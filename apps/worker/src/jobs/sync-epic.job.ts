import type { EffectiveConfig, SyncStep, TrackedEpicStatus, TrackedScope } from '@app/shared';
import type { JiraClient, ResolvedFieldMapping } from '@app/jira';
import { fetchEpicTree, fetchHistory, skewedWatermark } from '../pipeline/fetch-epic-tree.js';
import {
  buildRecords,
  hasRetroLog,
  type ChangelogRecord,
  type IssueRecord,
  type WorklogRecord,
} from '../pipeline/persist-issues.js';

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
  /** Bộ chọn phạm vi lá (CONTAINER/QUERY). Vắng ⇒ CONTAINER (DYNAMIC-TIERS §6). */
  readonly scope?: TrackedScope;
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
    const tree = await fetchEpicTree(deps.jira, {
      epicKey,
      fields: deps.fields,
      since,
      // Vắng ⇒ fetchEpicTree tự coi là CONTAINER (nhánh cũ, không đổi hành vi).
      ...(deps.scope ? { scope: deps.scope } : {}),
    });

    // --- GIAI ĐOẠN 2: worklog + changelog song song ---
    step = 'FETCH_HISTORY';
    // Chỉ Task và Sub-task mới có worklog đáng kể; bản thân Epic thì không.
    const historyTargets = [...tree.tasks, ...tree.subtasks];
    const idToKey = new Map(historyTargets.map((i) => [i.id, i.key]));
    // Issue có thể đã đồng bộ từ lần trước và lần này không đổi — vẫn cần
    // `issueId` của chúng để nhận diện worklog lấy theo lô.
    for (const [id, key] of await deps.issues.knownIdToKey(epicKey)) {
      if (!idToKey.has(id)) idToKey.set(id, key);
    }

    const history = await fetchHistory(deps.jira, { issueIdToKey: idToKey, since });

    // --- GIAI ĐOẠN 3: phân tách tiêu đề rồi ghi xuống ---
    step = 'PERSIST';
    const built = buildRecords({
      epicKey,
      tree,
      worklogsByIssue: history.worklogsByIssue,
      changelogByIssue: history.changelogByIssue,
      config: deps.config,
      fields: deps.fields,
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
      warnings: built.warnings,
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
