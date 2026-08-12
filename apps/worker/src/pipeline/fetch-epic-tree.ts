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
import type { TrackedScope } from '@app/shared';

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

export interface EpicTree {
  readonly epic: JiraIssue | null;
  readonly tasks: readonly JiraIssue[];
  readonly subtasks: readonly JiraIssue[];
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

/**
 * Lấy cả cây Epic bằng ĐÚNG 2 lần `searchIssues`.
 *
 * Bộ lọc `updated >=` CHỈ áp cho tầng Sub-task, cố ý:
 *
 *   • Tầng Epic + Task là câu hỏi về CẤU TRÚC — cần biết Epic này có những Phase
 *     nào. Lọc theo `updated` ở đây thì một Task không đổi sẽ biến mất khỏi kết
 *     quả, kéo theo mọi Sub-task của nó không được truy vấn nữa. Lỗi này hoàn
 *     toàn im lặng: job vẫn chạy xong, chỉ là thiếu dữ liệu.
 *   • Tầng Sub-task mới là chỗ có khối lượng (500 ticket) — lọc ở đây mới là
 *     chỗ tiết kiệm thật.
 *
 * Số Phase của một Epic chỉ vài cái, nên lấy lại toàn bộ tầng trên gần như
 * không tốn gì.
 */
export async function fetchEpicTree(
  client: JiraClient,
  args: {
    epicKey: string;
    fields: ResolvedFieldMapping;
    /** Đã trừ lùi sẵn. `null` = backfill. */
    since: Date | null;
    /** Bộ chọn phạm vi. Vắng ⇒ CONTAINER (mọi hàng cũ) → nhánh dưới KHÔNG đổi. */
    scope?: TrackedScope;
  },
): Promise<EpicTree> {
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
    // Nhãn Jira — nguồn khoá cho tầng nhóm dựa `LABEL` (DYNAMIC-TIERS-DESIGN.md §2.3).
    'labels',
    ...fieldIdsForSearch(args.fields),
  ];

  // Scope QUERY (project phẳng, §2.5): lá = ticket khớp JQL, KHÔNG có container. Nhánh
  // riêng, tách hẳn khỏi đường CONTAINER bên dưới — hàng cũ (scope vắng/CONTAINER) đi
  // đúng code cũ nên hành vi không đổi một byte.
  if (args.scope?.scopeType === 'QUERY') {
    return fetchQueryScope(client, args.scope.scopeJql ?? '', issueFields, args.since);
  }

  // (1) Bản thân Epic + các Task con. KHÔNG lọc theo `updated` — xem chú thích.
  const top = await searchIssues(client, {
    jql: `key = ${quote(args.epicKey)} OR parent = ${quote(args.epicKey)}`,
    fields: issueFields,
  });

  const epic = top.find((i) => i.key === args.epicKey) ?? null;
  const tasks = top.filter((i) => i.key !== args.epicKey);

  // (2) Sub-task, CÓ lọc theo `updated` khi đồng bộ tăng dần.
  const taskKeys = tasks.map((t) => t.key);
  const subtasks =
    taskKeys.length === 0
      ? []
      : await searchIssues(client, {
          jql:
            `parent IN (${taskKeys.map(quote).join(',')})` +
            (args.since ? ` AND updated >= ${quote(toJqlTimestamp(args.since))}` : ''),
          fields: issueFields,
        });

  // (3) Quét KEY để biết issue nào còn sống — chỉ cần khi đồng bộ tăng dần.
  //
  // Ở chế độ tăng dần, kết quả (2) chỉ chứa Sub-task VỪA ĐỔI. Lấy nó làm
  // `liveKeys` thì mọi Sub-task không đổi sẽ bị coi là đã biến mất và bị xoá
  // mềm sạch sau mỗi đêm. Nhưng nếu bỏ hẳn việc xoá mềm ở chế độ tăng dần thì
  // issue gỡ khỏi Jira sẽ KHÔNG BAO GIỜ được đánh dấu — vì sau lần backfill đầu
  // tiên, mọi lần chạy đều là tăng dần.
  //
  // Nên phải quét riêng danh sách key, không kèm bộ lọc `updated`. Chỉ lấy đúng
  // một trường nên phản hồi rất nhẹ, và đổi lại thì việc xoá mềm hoạt động
  // đúng ở MỌI lần chạy.
  const liveSubtaskKeys =
    args.since === null || taskKeys.length === 0
      ? subtasks.map((i) => i.key)
      : (
          await searchIssues(client, {
            jql: `parent IN (${taskKeys.map(quote).join(',')})`,
            fields: ['summary'],
          })
        ).map((i) => i.key);

  return {
    epic,
    tasks,
    subtasks,
    liveKeys: new Set([...top.map((i) => i.key), ...liveSubtaskKeys]),
  };
}

/**
 * Lấy lá của scope QUERY — DYNAMIC-TIERS-DESIGN §2.5, §6.
 *
 * Lá = ticket khớp JQL (cây phẳng, không container). Trả về ở `subtasks` với
 * `epic=null`/`tasks=[]`; nhờ vậy `persist-issues`/`fetchHistory`/`markRemoved` xử lý
 * y như lá CONTAINER — không phải sửa gì thêm. Khoá nhóm của lá phẳng lấy từ CHÍNH
 * tiêu đề nó (cấu hình tầng dùng `SELF_TITLE`), nên không cần Task cha.
 *
 * `updated >=` chỉ áp cho lần đọc dữ liệu; danh sách `liveKeys` quét KHÔNG lọc để xoá
 * mềm chạy đúng ở mọi lần (cùng lý do với nhánh CONTAINER). JQL rỗng ⇒ scope trống
 * (không đọc gì) thay vì quét cả Jira.
 */
async function fetchQueryScope(
  client: JiraClient,
  jql: string,
  issueFields: readonly string[],
  since: Date | null,
): Promise<EpicTree> {
  const trimmed = jql.trim();
  if (trimmed === '') {
    return { epic: null, tasks: [], subtasks: [], liveKeys: new Set() };
  }

  const leaves = await searchIssues(client, {
    jql: `(${trimmed})` + (since ? ` AND updated >= ${quote(toJqlTimestamp(since))}` : ''),
    fields: [...issueFields],
  });

  const liveKeys =
    since === null
      ? leaves.map((i) => i.key)
      : (await searchIssues(client, { jql: `(${trimmed})`, fields: ['summary'] })).map((i) => i.key);

  return { epic: null, tasks: [], subtasks: leaves, liveKeys: new Set(liveKeys) };
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
