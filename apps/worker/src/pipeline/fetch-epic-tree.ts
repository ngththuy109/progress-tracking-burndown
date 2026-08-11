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
 * Số key tối đa trong một mệnh đề `parent IN (...)`.
 *
 * JQL không có giới hạn cứng công bố, nhưng danh sách IN quá dài làm câu truy
 * vấn phình tới mức Jira từ chối hoặc chậm bất thường. ~50 key giữ mỗi câu ở
 * cỡ vài KB; tầng biên giới (frontier) lớn hơn thì tách thành nhiều câu.
 */
export const PARENT_IN_CHUNK_SIZE = 50;

/**
 * Cây issue lấy về theo TẦNG — thay cho bộ ba cố định epic/tasks/subtasks.
 *
 * `byTier[0]` là tầng gốc (`[root]` hoặc `[]` nếu root đã biến mất trên Jira),
 * `byTier[d]` (1..depth) là mọi issue ở tầng d. Vai trò (EPIC/TASK/SUBTASK/
 * MIDDLE) KHÔNG nằm ở đây — nó được gán từ vị trí tầng trong `buildRecords`.
 */
export interface RootTree {
  /** Issue gốc — `null` nếu Jira không còn trả về nó. */
  readonly root: JiraIssue | null;
  /** Độ dài luôn là `depth + 1`; tầng không có issue là mảng rỗng. */
  readonly byTier: readonly (readonly JiraIssue[])[];
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

/** Cắt danh sách key thành từng lô cho mệnh đề `parent IN (...)`. */
function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parentInJql(keys: readonly string[]): string {
  return `parent IN (${keys.map(quote).join(',')})`;
}

/**
 * Lấy cả cây issue 1..N tầng bằng vòng lặp biên giới (frontier):
 * frontier = [rootKey], rồi mỗi tầng lấy con qua `parent IN (...)` (tách lô
 * ~50 key) cho tới tầng lá.
 *
 * Bộ lọc `updated >=` CHỈ áp cho TẦNG LÁ, cố ý:
 *
 *   • Các tầng trên là câu hỏi về CẤU TRÚC — cần biết root này có những nhánh
 *     nào. Lọc theo `updated` ở đây thì một nhánh không đổi sẽ biến mất khỏi
 *     kết quả, kéo theo mọi con cháu của nó không được truy vấn nữa. Lỗi này
 *     hoàn toàn im lặng: job vẫn chạy xong, chỉ là thiếu dữ liệu.
 *   • Tầng lá mới là chỗ có khối lượng (500 ticket) — lọc ở đây mới là chỗ
 *     tiết kiệm thật.
 *
 * Số issue ở các tầng trên chỉ vài chục, nên lấy lại toàn bộ gần như không tốn
 * gì. Với `depth = 2` chuỗi JQL phát ra GIỐNG TỪNG BYTE bản epic→task→subtask
 * cũ (một câu `key = X OR parent = X`, một câu `parent IN (...)` cho lá, và
 * một câu quét key khi tăng dần) — có test khoá chặt điều này.
 */
export async function fetchRootTree(
  client: JiraClient,
  args: {
    /** Key của issue gốc (tracked root — cột `epic_key` trong DB). */
    rootKey: string;
    /** Số tầng DƯỚI root: 1..4 (`project.hierarchy_depth`). */
    depth: number;
    fields: ResolvedFieldMapping;
    /** Đã trừ lùi sẵn. `null` = backfill. */
    since: Date | null;
  },
): Promise<RootTree> {
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
  ];

  const leafFilter = args.since ? ` AND updated >= ${quote(toJqlTimestamp(args.since))}` : '';
  const byTier: JiraIssue[][] = [];
  let root: JiraIssue | null = null;

  if (args.depth >= 2) {
    // (1) Root + tầng 1 trong MỘT câu — tầng 1 không bao giờ bị lọc `updated`
    // nên gộp được, giữ nguyên số lần gọi của bản cũ.
    const top = await searchIssues(client, {
      jql: `key = ${quote(args.rootKey)} OR parent = ${quote(args.rootKey)}`,
      fields: issueFields,
    });
    root = top.find((i) => i.key === args.rootKey) ?? null;
    byTier.push(root ? [root] : []);
    byTier.push(top.filter((i) => i.key !== args.rootKey));
  } else {
    // depth = 1: tầng 1 chính là tầng lá và cần bộ lọc `updated`, mà bộ lọc đó
    // KHÔNG được chạm vào root (root không đổi sẽ biến mất) — nên tách hai câu.
    const rootRes = await searchIssues(client, {
      jql: `key = ${quote(args.rootKey)}`,
      fields: issueFields,
    });
    root = rootRes.find((i) => i.key === args.rootKey) ?? null;
    byTier.push(root ? [root] : []);
  }

  // (2) Vòng lặp biên giới cho các tầng còn lại; tầng lá có lọc `updated`.
  for (let d = byTier.length; d <= args.depth; d++) {
    const isLeaf = d === args.depth;
    // Tầng 1 luôn hỏi theo rootKey — kể cả khi Jira không còn trả về root,
    // giống hệt `parent = X` của bản cũ.
    const frontier = d === 1 ? [args.rootKey] : byTier[d - 1]!.map((i) => i.key);
    const tier: JiraIssue[] = [];
    for (const keys of chunked(frontier, PARENT_IN_CHUNK_SIZE)) {
      tier.push(
        ...(await searchIssues(client, {
          jql: parentInJql(keys) + (isLeaf ? leafFilter : ''),
          fields: issueFields,
        })),
      );
    }
    byTier.push(tier);
  }

  // (3) Quét KEY tầng lá để biết issue nào còn sống — chỉ cần khi tăng dần.
  //
  // Ở chế độ tăng dần, kết quả (2) chỉ chứa lá VỪA ĐỔI. Lấy nó làm `liveKeys`
  // thì mọi lá không đổi sẽ bị coi là đã biến mất và bị xoá mềm sạch sau mỗi
  // đêm. Nhưng nếu bỏ hẳn việc xoá mềm ở chế độ tăng dần thì issue gỡ khỏi
  // Jira sẽ KHÔNG BAO GIỜ được đánh dấu — vì sau lần backfill đầu tiên, mọi
  // lần chạy đều là tăng dần.
  //
  // Nên phải quét riêng danh sách key, không kèm bộ lọc `updated`. Chỉ lấy
  // đúng một trường nên phản hồi rất nhẹ, và đổi lại thì việc xoá mềm hoạt
  // động đúng ở MỌI lần chạy. Các tầng trên đã được lấy TRỌN VẸN nên key của
  // chúng chính là danh sách sống, không cần quét lại.
  const leafFrontier = args.depth === 1 ? [args.rootKey] : byTier[args.depth - 1]!.map((i) => i.key);
  let liveLeafKeys: string[];
  if (args.since === null || leafFrontier.length === 0) {
    liveLeafKeys = byTier[args.depth]!.map((i) => i.key);
  } else {
    liveLeafKeys = [];
    for (const keys of chunked(leafFrontier, PARENT_IN_CHUNK_SIZE)) {
      liveLeafKeys.push(
        ...(await searchIssues(client, { jql: parentInJql(keys), fields: ['summary'] })).map(
          (i) => i.key,
        ),
      );
    }
  }

  return {
    root,
    byTier,
    liveKeys: new Set([
      ...byTier.slice(0, args.depth).flatMap((tier) => tier.map((i) => i.key)),
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
