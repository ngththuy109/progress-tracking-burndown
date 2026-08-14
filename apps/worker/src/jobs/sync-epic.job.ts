import type { EffectiveConfig, SyncStep, TrackedEpicStatus } from '@app/shared';
import type { JiraClient, ResolvedFieldMapping } from '@app/jira';
import { fetchEpicTree, fetchHistory, skewedWatermark } from '../pipeline/fetch-epic-tree.js';
import {
  buildRecords,
  hasRetroLog,
  type ChangelogRecord,
  type IssueRecord,
  type WorklogRecord,
} from '../pipeline/persist-issues.js';
import { resolveParticipantNames } from '../pipeline/resolve-participant-names.js';

/**
 * Đồng bộ MỘT Epic đầu-cuối — PRD §4.2 giai đoạn 1–3.
 *
 * Giai đoạn 4 (tổng hợp ngày Phase) và 5 (dựng lịch sử) thuộc T-15 và T-18.
 *
 * Mọi thứ bên ngoài đi qua CỔNG, nên toàn bộ luồng này test được với một Jira
 * giả và kho dữ liệu trong bộ nhớ — không cần PostgreSQL.
 */

export interface IssueWritePort {
  /** UPSERT theo `issue_key`. Chạy hai lần phải cho kết quả y hệt (C-6). */
  upsertMany(rows: readonly IssueRecord[]): Promise<void>;
  /**
   * Đánh dấu issue đã biến mất khỏi Epic.
   *
   * XOÁ CỨNG LÀ MẤT LỊCH SỬ VĨNH VIỄN: snapshot của những ngày trước đó vẫn
   * phải nhìn thấy issue này.
   */
  markRemoved(epicKey: string, liveKeys: ReadonlySet<string>, at: Date): Promise<number>;
  /** Key của mọi issue thuộc Epic — để ánh xạ `issueId` → `issueKey`. */
  knownIdToKey(epicKey: string): Promise<ReadonlyMap<string, string>>;
}

export interface WorklogWritePort {
  upsertMany(rows: readonly WorklogRecord[]): Promise<void>;
  /** Worklog bị xoá trên Jira: đặt cờ, KHÔNG xoá dòng (E-17). */
  markDeleted(worklogIds: readonly bigint[]): Promise<number>;
  /**
   * Đối soát khi ĐỌC LẠI TOÀN BỘ: đặt cờ cho worklog của Epic KHÔNG còn trong
   * tập `liveWorklogIds` (tập đầy đủ vừa lấy từ Jira). CHỈ gọi khi không có mốc
   * `since` — xem `markWorklogsDeletedMissing`.
   */
  markDeletedMissing(epicKey: string, liveWorklogIds: ReadonlySet<bigint>): Promise<number>;
}

export interface ChangelogWritePort {
  /** UPSERT theo `(issue_key, jira_history_id, field_name)`. */
  upsertMany(rows: readonly ChangelogRecord[]): Promise<void>;
}

export interface SyncRunPort {
  start(args: { epicKey: string; runType: string; startedAt: Date }): Promise<number>;
  finish(args: {
    id: number;
    status: 'SUCCESS' | 'FAILED';
    finishedAt: Date;
    apiCalls: number;
    rateLimitHits: number;
    issuesRead: number;
    worklogsRead: number;
    errorMessage: string | null;
    /** Bước đang chạy khi job ném lỗi — màn hình Monitoring trả lời "lỗi ở đâu". */
    errorStep: SyncStep | null;
    /** Stack trace nguyên văn — nguồn của màn hình chi tiết lần chạy. */
    errorDetail: string | null;
  }): Promise<void>;
}

export interface EpicStatePort {
  read(epicKey: string): Promise<{ status: TrackedEpicStatus; lastSyncedAt: Date | null } | null>;
  setStatus(epicKey: string, status: TrackedEpicStatus, lastError: string | null): Promise<void>;
  setSynced(epicKey: string, at: Date): Promise<void>;
}

export interface DirtyEpicQueuePort {
  add(epicKeys: readonly string[]): Promise<void>;
}

export interface SyncEpicDeps {
  readonly jira: JiraClient;
  readonly fields: ResolvedFieldMapping;
  readonly config: EffectiveConfig;
  readonly issues: IssueWritePort;
  readonly worklogs: WorklogWritePort;
  readonly changelog: ChangelogWritePort;
  readonly syncRuns: SyncRunPort;
  readonly epics: EpicStatePort;
  readonly dirty: DirtyEpicQueuePort;
  /**
   * Đồng hồ, truyền vào chứ không đọc thẳng.
   *
   * Job này KHÔNG thuộc `engine` nên không bị lint chặn, nhưng vẫn nhận đồng hồ
   * qua tham số: watermark và `sync_run` đều phụ thuộc thời gian, và test không
   * đóng băng được đồng hồ sẽ chập chờn.
   */
  readonly now: () => Date;
}

export interface SyncEpicResult {
  readonly epicKey: string;
  readonly status: 'SUCCESS' | 'FAILED';
  readonly issuesRead: number;
  readonly worklogsRead: number;
  readonly changelogRead: number;
  readonly removed: number;
  readonly worklogsDeleted: number;
  readonly apiCalls: number;
  readonly rateLimitHits: number;
  readonly retroLogDetected: boolean;
  readonly warnings: readonly { code: string; message: string }[];
  readonly errorMessage: string | null;
}

export interface SyncEpicOptions {
  /**
   * Bỏ qua watermark và đọc lại TOÀN BỘ lịch sử từ Jira.
   *
   * Đây là nửa đầu của `{"full":true}` trong runbook. Không có nó thì "dựng lại
   * toàn bộ lịch sử" chỉ dựng lại snapshot từ dữ liệu thô đang có — mà nếu dữ
   * liệu thô mới là thứ bị thiếu thì tính lại bao nhiêu lần cũng ra sai y hệt.
   *
   * ĐẮT: một Epic 500 Sub-task tốn ~135 lần gọi Jira thay vì ~15 (PRD §4.5).
   */
  readonly ignoreWatermark?: boolean;
}

export async function syncEpic(
  deps: SyncEpicDeps,
  epicKey: string,
  options: SyncEpicOptions = {},
): Promise<SyncEpicResult> {
  const startedAt = deps.now();
  deps.jira.resetCounters();

  const state = await deps.epics.read(epicKey);
  if (state === null) {
    throw new Error(`Epic ${epicKey} không có trong sổ theo dõi — không đồng bộ.`);
  }

  const rereadAll = options.ignoreWatermark === true;
  // Đọc lại toàn bộ thì ghi `sync_run` là BACKFILL, không phải DAILY: màn hình
  // /ops phải phân biệt được một lượt chạy 18 giây với một lượt chạy 4 giây, nếu
  // không thì "job đêm hôm nay chậm bất thường" trông giống hệt lỗi.
  const runType = rereadAll || state.lastSyncedAt === null ? 'BACKFILL' : 'DAILY';
  // Ghi `sync_run` NGAY TỪ ĐẦU. Chỉ ghi lúc kết thúc thì job chết giữa chừng sẽ
  // không để lại dấu vết nào, và người vận hành không biết nó đã chạy hay chưa.
  const runId = await deps.syncRuns.start({ epicKey, runType, startedAt });

  // Bước ĐANG chạy — cập nhật trước mỗi giai đoạn để khi ném lỗi biết được job
  // chết ở đâu: phía Jira (FETCH_*), phía database (PERSIST) hay lúc chốt sổ.
  let step: SyncStep = 'FETCH_TREE';

  try {
    const since = rereadAll ? null : skewedWatermark(state.lastSyncedAt);

    // --- GIAI ĐOẠN 1: cây issue, đúng 2 lần gọi search ---
    const tree = await fetchEpicTree(deps.jira, { epicKey, fields: deps.fields, since });

    // Epic đã bị XOÁ khỏi Jira (trước đây lấy về, sau đó bị xoá trên Jira).
    //
    // KHÔNG đọc lịch sử: mọi issue con cũng đã biến mất nên `/issue/{key}/worklog`
    // và `/changelog` sẽ trả 404 và làm job đổ y như lỗi 400 lúc nãy. Thay vào đó
    // đánh dấu TOÀN BỘ issue của Epic là đã gỡ (xoá mềm, PRD E-02): snapshot cũ
    // giữ nguyên, từ hôm nay trở đi issue rời khỏi Burndown — `liveKeys` rỗng nên
    // `markRemoved` quét sạch mọi issue chưa gỡ của Epic này.
    //
    // Coi đây là THÀNH CÔNG, không phải lỗi: nếu ném lỗi thì Epic kẹt vĩnh viễn ở
    // ERROR và mỗi lần Resync lại vấp đúng lỗi đó (chính là sự cố đang sửa). PM
    // vẫn có thể Bỏ theo dõi Epic sau đó nếu không cần giữ lịch sử nữa (RUNBOOK).
    if (tree.epicGone) {
      step = 'PERSIST';
      const removed = await deps.issues.markRemoved(epicKey, tree.liveKeys, deps.now());

      step = 'FINALIZE';
      const finishedAt = deps.now();
      await deps.syncRuns.finish({
        id: runId,
        status: 'SUCCESS',
        finishedAt,
        apiCalls: deps.jira.apiCallsMade,
        rateLimitHits: deps.jira.rateLimitHits,
        issuesRead: 0,
        worklogsRead: 0,
        errorMessage: null,
        errorStep: null,
        errorDetail: null,
      });

      await deps.epics.setSynced(epicKey, finishedAt);
      // Gỡ Epic khỏi ERROR: lượt Resync này chính là thứ đưa nó ra khỏi trạng
      // thái lỗi (API đã chuyển ERROR → BACKFILLING trước khi đẩy job).
      if (state.status === 'BACKFILLING') {
        await deps.epics.setStatus(epicKey, 'ACTIVE', null);
      }

      return {
        epicKey,
        status: 'SUCCESS',
        issuesRead: 0,
        worklogsRead: 0,
        changelogRead: 0,
        removed,
        worklogsDeleted: 0,
        apiCalls: deps.jira.apiCallsMade,
        rateLimitHits: deps.jira.rateLimitHits,
        retroLogDetected: false,
        // Cảnh báo để vận hành biết VÌ SAO dữ liệu bị gỡ hàng loạt — cùng kênh
        // `sync.warning` như PHASE_MISMATCH/FIELD_TRUNCATED ở wire.ts.
        warnings: [
          {
            code: 'EPIC_DELETED_IN_JIRA',
            message:
              `Epic ${epicKey} không còn trên Jira (đã bị xoá). Đã đánh dấu ${removed} issue ` +
              `là đã gỡ và GIỮ NGUYÊN lịch sử cũ. Bỏ theo dõi Epic này nếu không cần nữa.`,
          },
        ],
        errorMessage: null,
      };
    }

    // --- GIAI ĐOẠN 2: worklog + changelog song song ---
    step = 'FETCH_HISTORY';
    // Chỉ Task và Sub-task mới có worklog đáng kể; bản thân Epic thì không.
    const historyTargets = [...tree.tasks, ...tree.subtasks];
    const idToKey = new Map(historyTargets.map((i) => [i.id, i.key]));
    // Bổ sung issueId của issue đã đồng bộ từ lần trước để gắn đúng worklog lấy
    // theo lô (chế độ tăng dần) — NHƯNG chỉ những issue CÒN SỐNG trên Jira
    // (`liveKeys`).
    //
    // Task/Sub-task bị XOÁ trên Jira vẫn nằm trong DB với `removed_at` chưa gắn
    // (chỉ được gắn ở `markRemoved` phía dưới), nên nó vẫn lọt vào `knownIdToKey`.
    // Đọc lịch sử của nó theo key thì `/issue/{key}/changelog` và `/worklog` trả
    // 404 — KHÔNG thuộc diện thử lại — và làm đổ cả lượt đồng bộ Epic ngay ở
    // FETCH_HISTORY, trước khi kịp gỡ nó. Lọc theo `liveKeys` để không bao giờ gọi
    // lịch sử cho issue đã biến mất (đồng thời khỏi tốn lời gọi 404 vô ích cho mọi
    // issue đã gỡ từ lâu); `markRemoved` bên dưới vẫn gỡ nó bình thường.
    for (const [id, key] of await deps.issues.knownIdToKey(epicKey)) {
      if (!idToKey.has(id) && tree.liveKeys.has(key)) idToKey.set(id, key);
    }

    const history = await fetchHistory(deps.jira, { issueIdToKey: idToKey, since });

    // --- GIAI ĐOẠN 3: phân tách tiêu đề rồi ghi xuống ---
    step = 'PERSIST';
    // Tra tên hiển thị cho "Request participants" (cột PIC) TRƯỚC khi build vì
    // `buildRecords` là hàm thuần. Chỉ tốn lời gọi khi field trả về accountId
    // trống tên; lỗi tra tên KHÔNG làm hỏng đồng bộ, chỉ thành cảnh báo.
    const participants = await resolveParticipantNames(deps.jira, tree.subtasks, deps.fields);

    const built = buildRecords({
      epicKey,
      tree,
      worklogsByIssue: history.worklogsByIssue,
      changelogByIssue: history.changelogByIssue,
      config: deps.config,
      fields: deps.fields,
      participantNames: participants.names,
    });

    await deps.issues.upsertMany(built.issues);
    await deps.changelog.upsertMany(built.changelog);
    await deps.worklogs.upsertMany(built.worklogs);

    let worklogsDeleted = await deps.worklogs.markDeleted(
      history.deletedWorklogIds.map((n) => BigInt(n)),
    );

    // ĐỐI SOÁT worklog đã xoá — CHỈ khi đọc lại toàn bộ (`since === null`).
    //
    // Lượt đọc lại toàn bộ lấy ĐẦY ĐỦ worklog còn sống của từng issue, nên
    // `history.worklogsByIssue` chính là bản đầy đủ để đối soát: worklog nào còn
    // trong DB mà không còn ở đây thì đã bị xoá trên Jira. Phải làm ở đây vì
    // `/worklog/deleted` chỉ chạy khi có `since` — không có bước này thì full
    // resync KHÔNG bao giờ đánh dấu được worklog đã xoá, và ngày bắt đầu/kết thúc
    // THỰC TẾ (suy từ worklog) kẹt ở giá trị cũ dù chạy lại bao nhiêu lần.
    //
    // KHÔNG chạy ở chế độ tăng dần: khi đó `worklogsByIssue` chỉ chứa worklog
    // VỪA ĐỔI, đối soát sẽ xoá nhầm sạch phần không đổi. Deletion của chế độ tăng
    // dần đã có `/worklog/deleted` + `markDeleted` lo ở trên.
    if (since === null) {
      const liveWorklogIds = new Set<bigint>();
      for (const list of history.worklogsByIssue.values()) {
        for (const w of list) liveWorklogIds.add(BigInt(w.id));
      }
      worklogsDeleted += await deps.worklogs.markDeletedMissing(epicKey, liveWorklogIds);
    }

    // Chạy ở MỌI lần đồng bộ, kể cả tăng dần: `tree.liveKeys` đến từ một lần
    // quét key riêng KHÔNG có bộ lọc `updated`, nên nó luôn là danh sách đầy đủ
    // những gì còn sống trên Jira (xem `fetchEpicTree`).
    const removed = await deps.issues.markRemoved(epicKey, tree.liveKeys, deps.now());

    // Log giờ lùi ngày làm sai lịch sử của những ngày ĐÃ CHỐT SỔ, nên phải tính
    // lại chứ không chỉ ghi thêm (PRD E-03).
    const retroLogDetected = hasRetroLog(built.worklogs);
    if (retroLogDetected) await deps.dirty.add([epicKey]);

    step = 'FINALIZE';
    const finishedAt = deps.now();
    await deps.syncRuns.finish({
      id: runId,
      status: 'SUCCESS',
      finishedAt,
      apiCalls: deps.jira.apiCallsMade,
      rateLimitHits: deps.jira.rateLimitHits,
      issuesRead: built.issues.length,
      worklogsRead: built.worklogs.length,
      errorMessage: null,
      errorStep: null,
      errorDetail: null,
    });

    await deps.epics.setSynced(epicKey, finishedAt);
    if (state.status === 'BACKFILLING') {
      await deps.epics.setStatus(epicKey, 'ACTIVE', null);
    }

    return {
      epicKey,
      status: 'SUCCESS',
      issuesRead: built.issues.length,
      worklogsRead: built.worklogs.length,
      changelogRead: built.changelog.length,
      removed,
      worklogsDeleted,
      apiCalls: deps.jira.apiCallsMade,
      rateLimitHits: deps.jira.rateLimitHits,
      retroLogDetected,
      // Gộp cảnh báo tra tên PIC (nếu có) với cảnh báo phân tách tiêu đề — cùng
      // đi ra log `sync.warning` ở wire.ts.
      warnings: [...participants.warnings, ...built.warnings],
      errorMessage: null,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    await deps.syncRuns.finish({
      id: runId,
      status: 'FAILED',
      finishedAt: deps.now(),
      apiCalls: deps.jira.apiCallsMade,
      rateLimitHits: deps.jira.rateLimitHits,
      issuesRead: 0,
      worklogsRead: 0,
      errorMessage,
      errorStep: step,
      // Stack trace giữ NGUYÊN VĂN: đây là thứ màn hình chi tiết lần chạy hiện
      // ra để người trực khỏi phải grep log worker giữa đêm.
      errorDetail: err instanceof Error ? (err.stack ?? errorMessage) : String(err),
    });

    // Chuyển ERROR chứ KHÔNG gỡ khỏi sổ (E-26): có thể chỉ là lỗi tạm thời hoặc
    // Epic vừa đổi key. Để PM quyết định.
    await deps.epics.setStatus(epicKey, 'ERROR', errorMessage);

    return {
      epicKey,
      status: 'FAILED',
      issuesRead: 0,
      worklogsRead: 0,
      changelogRead: 0,
      removed: 0,
      worklogsDeleted: 0,
      apiCalls: deps.jira.apiCallsMade,
      rateLimitHits: deps.jira.rateLimitHits,
      retroLogDetected: false,
      warnings: [],
      errorMessage,
    };
  }
}
