import {
  fieldIdsForSearch,
  getDeletedWorklogIds,
  getIssueChangelog,
  getIssueWorklogs,
  getUpdatedWorklogIds,
  getWorklogsByIds,
  searchIssues,
  type JiraChangelogEntry,
  type JiraClient,
  type JiraIssue,
  type JiraWorklog,
  type ResolvedFieldMapping,
} from '@app/jira';
import { levelAcceptsIssueType, type HierarchyProfile } from '@app/shared';

/**
 * GIAI ĐOẠN 1–2 của luồng đồng bộ — PRD §4.2, §4.5.
 *
 * Vấn đề N+1 là lý do file này không tầm thường (PRD §4.5):
 *
 *   tuần tự                     ~1002 lần gọi   ~200 giây
 *   song song 8 luồng + gộp lô   ~135 lần gọi    ~18 giây
 *   tăng dần (ngày thường)        ~15 lần gọi     ~4 giây
 */

/** Trừ lùi watermark 5 phút phòng lệch đồng hồ — PRD §4.2. */
export const WATERMARK_SKEW_MINUTES = 5;

/**
 * Cây issue đã phân TẦNG theo Hierarchy Profile.
 *
 * Đặt tên theo VAI chứ không theo issue type: dự án 2 tầng có `leaves` là các
 * Task con của một ticket root, `groupLevels` rỗng.
 */
export interface IssueTree {
  readonly root: JiraIssue | null;
  /**
   * Các tầng GROUP, index 0 = tầng ngay dưới ROOT. Cây 3 tầng có đúng 1 phần
   * tử (các Task Phase); cây 2 tầng — mảng rỗng.
   */
  readonly groupLevels: readonly (readonly JiraIssue[])[];
  readonly leaves: readonly JiraIssue[];
  /** Key của MỌI issue Jira đang trả về — dùng để phát hiện issue đã biến mất. */
  readonly liveKeys: ReadonlySet<string>;
}

/**
 * Định dạng mốc thời gian cho JQL: `"yyyy-MM-dd HH:mm"`.
 *
 * Jira KHÔNG nhận chuỗi ISO 8601 đầy đủ trong JQL. Truyền ISO vào sẽ bị từ chối
 * hoặc tệ hơn là bị hiểu sai thành mốc khác.
 */
export function toJqlTimestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

/** Watermark đã trừ lùi. `null` = backfill toàn bộ. */
export function skewedWatermark(lastSyncedAt: Date | null): Date | null {
  if (lastSyncedAt === null) return null;
  return new Date(lastSyncedAt.getTime() - WATERMARK_SKEW_MINUTES * 60_000);
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** Tên issue type Jira của một issue thô, để lọc theo `levels[i].issueTypes`. */
function issueTypeNameOf(issue: JiraIssue): string {
  const t = issue.fields['issuetype'];
  if (t && typeof t === 'object' && 'name' in t) {
    const name = (t as { name: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/** Giữ lại issue được tầng này chấp nhận (danh sách trống = nhận tất cả). */
function filterByLevel(
  rows: readonly JiraIssue[],
  profile: HierarchyProfile,
  levelIndex: number,
): JiraIssue[] {
  const level = profile.levels[levelIndex];
  if (!level?.issueTypes || level.issueTypes.length === 0) return [...rows];
  return rows.filter((i) => levelAcceptsIssueType(level, issueTypeNameOf(i)));
}

/**
 * Field Jira mà Hierarchy Profile cần đọc thêm (Phase/hàng/cột lấy từ FIELD).
 * Không khai vào danh sách fields của search thì Jira không trả về — và lỗi đó
 * im lặng: giá trị chỉ luôn là undefined.
 */
function profileExtraFields(profile: HierarchyProfile): string[] {
  const out: string[] = [];
  if (profile.phaseSource.type === 'FIELD' && profile.phaseSource.ref) {
    out.push(profile.phaseSource.ref);
  }
  if (profile.signboard.row.source === 'FIELD') out.push(profile.signboard.row.ref);
  if (profile.signboard.column.source === 'FIELD') out.push(profile.signboard.column.ref);
  return out;
}

/**
 * Lấy cả cây theo Hierarchy Profile — số lần `searchIssues` = số tầng − 1
 * (tầng 0 và 1 gộp chung một câu JQL), cộng 1 lần quét key khi tăng dần.
 * Với profile 3 tầng mặc định: ĐÚNG 2 lần search như trước.
 *
 * Bộ lọc `updated >=` CHỈ áp cho tầng LEAF, cố ý:
 *
 *   • Các tầng trên (ROOT + GROUP) là câu hỏi về CẤU TRÚC — cần biết root này
 *     có những nhánh nào. Lọc theo `updated` ở đây thì một nhánh không đổi sẽ
 *     biến mất khỏi kết quả, kéo theo mọi ticket lá của nó không được truy vấn
 *     nữa. Lỗi này hoàn toàn im lặng: job vẫn chạy xong, chỉ là thiếu dữ liệu.
 *   • Tầng LEAF mới là chỗ có khối lượng (500 ticket) — lọc ở đây mới là chỗ
 *     tiết kiệm thật.
 */
export async function fetchIssueTree(
  client: JiraClient,
  args: {
    /** Key của issue ROOT — với profile mặc định đây chính là Epic. */
    epicKey: string;
    fields: ResolvedFieldMapping;
    /** Đã trừ lùi sẵn. `null` = backfill. */
    since: Date | null;
    profile: HierarchyProfile;
  },
): Promise<IssueTree> {
  const { profile } = args;
  const levelCount = profile.levels.length; // ≥ 2, zod đã chặn
  const issueFields = [
    'summary',
    'issuetype',
    'parent',
    'status',
    'timeoriginalestimate',
    'timeestimate',
    'timespent',
    'created',
    'updated',
    ...fieldIdsForSearch(args.fields),
    ...profileExtraFields(profile),
  ];

  let root: JiraIssue | null = null;
  const groupLevels: JiraIssue[][] = [];
  /** Key tầng CHA của tầng lá — đích cho câu JQL cuối. */
  let parentKeys: string[];

  if (levelCount >= 3) {
    // (1) ROOT + tầng GROUP đầu tiên trong MỘT câu JQL — giữ nguyên tối ưu
    // "đúng 2 lần search" của profile 3 tầng.
    const top = await searchIssues(client, {
      jql: `key = ${quote(args.epicKey)} OR parent = ${quote(args.epicKey)}`,
      fields: issueFields,
    });
    root = top.find((i) => i.key === args.epicKey) ?? null;
    const firstGroup = filterByLevel(
      top.filter((i) => i.key !== args.epicKey),
      profile,
      1,
    );
    groupLevels.push(firstGroup);
    parentKeys = firstGroup.map((t) => t.key);

    // (1b) Các tầng GROUP sâu hơn (cây ≥ 4 tầng) — mỗi tầng một câu JQL,
    // vẫn KHÔNG lọc `updated` vì là câu hỏi cấu trúc.
    for (let level = 2; level <= levelCount - 2; level++) {
      const rows =
        parentKeys.length === 0
          ? []
          : filterByLevel(
              await searchIssues(client, {
                jql: `parent IN (${parentKeys.map(quote).join(',')})`,
                fields: issueFields,
              }),
              profile,
              level,
            );
      groupLevels.push(rows);
      parentKeys = rows.map((r) => r.key);
    }
  } else {
    // Cây 2 tầng: ROOT đứng một mình một câu, lá là con trực tiếp của nó.
    const top = await searchIssues(client, {
      jql: `key = ${quote(args.epicKey)}`,
      fields: issueFields,
    });
    root = top.find((i) => i.key === args.epicKey) ?? null;
    parentKeys = [args.epicKey];
  }

  // (2) Tầng LEAF, CÓ lọc theo `updated` khi đồng bộ tăng dần.
  const leaves =
    parentKeys.length === 0
      ? []
      : filterByLevel(
          await searchIssues(client, {
            jql:
              `parent IN (${parentKeys.map(quote).join(',')})` +
              (args.since ? ` AND updated >= ${quote(toJqlTimestamp(args.since))}` : ''),
            fields: issueFields,
          }),
          profile,
          levelCount - 1,
        );

  // (3) Quét KEY để biết issue nào còn sống — chỉ cần khi đồng bộ tăng dần.
  //
  // Ở chế độ tăng dần, kết quả (2) chỉ chứa ticket lá VỪA ĐỔI. Lấy nó làm
  // `liveKeys` thì mọi ticket lá không đổi sẽ bị coi là đã biến mất và bị xoá
  // mềm sạch sau mỗi đêm. Nhưng nếu bỏ hẳn việc xoá mềm ở chế độ tăng dần thì
  // issue gỡ khỏi Jira sẽ KHÔNG BAO GIỜ được đánh dấu — vì sau lần backfill đầu
  // tiên, mọi lần chạy đều là tăng dần.
  //
  // Nên phải quét riêng danh sách key, không kèm bộ lọc `updated`. Chỉ lấy đúng
  // một trường nên phản hồi rất nhẹ, và đổi lại thì việc xoá mềm hoạt động
  // đúng ở MỌI lần chạy.
  const liveLeafKeys =
    args.since === null || parentKeys.length === 0
      ? leaves.map((i) => i.key)
      : (
          await searchIssues(client, {
            jql: `parent IN (${parentKeys.map(quote).join(',')})`,
            fields: ['summary'],
          })
        ).map((i) => i.key);

  return {
    root,
    groupLevels,
    leaves,
    liveKeys: new Set([
      ...(root ? [root.key] : []),
      ...groupLevels.flat().map((i) => i.key),
      ...liveLeafKeys,
    ]),
  };
}

export interface FetchedHistory {
  readonly worklogsByIssue: ReadonlyMap<string, readonly JiraWorklog[]>;
  readonly changelogByIssue: ReadonlyMap<string, readonly JiraChangelogEntry[]>;
  readonly deletedWorklogIds: readonly number[];
}

/**
 * Lấy worklog và changelog SONG SONG — GIAI ĐOẠN 2.
 *
 * Không tự quản lý số luồng: `JiraClient` đã chặn ở 8 request đồng thời cho
 * TOÀN HỆ THỐNG (C-7). Thêm một bộ giới hạn nữa ở đây chỉ làm hai lớp chặn nhau
 * và che mất giới hạn thật.
 *
 * Cám dỗ lớn nhất ở đây là gọi tuần tự cho từng Sub-task: code đơn giản hơn
 * nhiều nhưng 500 Sub-task thành ~200 giây.
 */
export async function fetchHistory(
  client: JiraClient,
  args: {
    /**
     * Ánh xạ `issueId` (số, dạng chuỗi) sang `issueKey`.
     *
     * BẮT BUỘC phải có: `/worklog/list` chỉ trả `issueId`, không trả `issueKey`.
     * Không có bảng ánh xạ này thì mọi worklog lấy theo lô sẽ không gắn được vào
     * issue nào — và im lặng biến mất.
     */
    readonly issueIdToKey: ReadonlyMap<string, string>;
    readonly since: Date | null;
  },
): Promise<FetchedHistory> {
  const issueKeys = [...args.issueIdToKey.values()];
  const worklogsByIssue = new Map<string, readonly JiraWorklog[]>();
  const changelogByIssue = new Map<string, readonly JiraChangelogEntry[]>();

  const changelogTask = Promise.all(
    issueKeys.map(async (key) => {
      changelogByIssue.set(key, await getIssueChangelog(client, key));
    }),
  );

  const worklogTask = args.since
    ? fetchWorklogsIncrementally(client, args.issueIdToKey, args.since, worklogsByIssue)
    : Promise.all(
        issueKeys.map(async (key) => {
          worklogsByIssue.set(key, await getIssueWorklogs(client, key));
        }),
      );

  // Worklog bị xoá chỉ hỏi được khi có mốc `since` — API `/worklog/deleted`
  // không có chế độ "lấy tất cả" (E-17).
  const deletedTask = args.since
    ? getDeletedWorklogIds(client, args.since.getTime())
    : Promise.resolve([]);

  const [, , deletedWorklogIds] = await Promise.all([changelogTask, worklogTask, deletedTask]);

  return { worklogsByIssue, changelogByIssue, deletedWorklogIds };
}

/**
 * Đồng bộ tăng dần: hỏi Jira "worklog nào vừa đổi" rồi lấy chi tiết theo lô
 * 1000, thay vì hỏi từng issue.
 *
 * `/worklog/updated` trả về worklog của TOÀN BỘ Jira, nên phải lọc lại theo
 * issue của Epic này.
 */
async function fetchWorklogsIncrementally(
  client: JiraClient,
  issueIdToKey: ReadonlyMap<string, string>,
  since: Date,
  out: Map<string, readonly JiraWorklog[]>,
): Promise<void> {
  const ids = await getUpdatedWorklogIds(client, since.getTime());
  if (ids.length === 0) return;

  const details = await getWorklogsByIds(client, ids);

  // `/worklog/updated` trả worklog của TOÀN BỘ Jira, nên phải lọc lại theo
  // issue của Epic này — và lọc bằng `issueId`, không phải `issueKey`.
  const grouped = new Map<string, JiraWorklog[]>();
  for (const w of details) {
    if (w.issueId === undefined) continue;
    const key = issueIdToKey.get(w.issueId);
    if (key === undefined) continue;
    (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(w);
  }

  for (const [key, list] of grouped) out.set(key, list);
}
