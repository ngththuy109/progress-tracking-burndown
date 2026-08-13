import { z } from 'zod';
import type { JiraClient } from './client.js';

/**
 * 8 endpoint Jira mà PRD §2.5 dùng tới. Tất cả đều CHỈ ĐỌC.
 *
 * Mọi phản hồi được validate bằng zod ở BIÊN — lỗi nổ đúng chỗ thay vì lan ra
 * dưới dạng `undefined` ở tận tầng engine.
 */

// --------------------------------------------------------------------------
// Schema
// --------------------------------------------------------------------------
export const statusCategorySchema = z.object({
  key: z.string(),
  name: z.string(),
});

export const jiraStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  statusCategory: statusCategorySchema,
});

export const jiraFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  custom: z.boolean().optional(),
  schema: z.object({ type: z.string() }).partial().optional(),
});

export const jiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.record(z.string(), z.unknown()),
});

export const jiraUserSchema = z.object({
  accountId: z.string(),
  // Có thể vắng với account bị xoá/ẩn — khi đó không tra được tên, giữ nguyên id.
  displayName: z.string().optional(),
});

/** `/user/bulk` phân trang kiểu PageBean (`startAt` + `isLast`). */
export const bulkUserPageSchema = z.object({
  values: z.array(jiraUserSchema),
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
  isLast: z.boolean().optional(),
});

export const searchResultSchema = z.object({
  issues: z.array(jiraIssueSchema),
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
  isLast: z.boolean().optional(),
  nextPageToken: z.string().optional(),
});

export const worklogSchema = z.object({
  id: z.string(),
  issueId: z.string().optional(),
  author: z.object({ accountId: z.string() }).partial().optional(),
  timeSpentSeconds: z.number(),
  started: z.string(),
  created: z.string(),
  updated: z.string(),
});

export const worklogPageSchema = z.object({
  worklogs: z.array(worklogSchema),
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
});

/**
 * Bỏ prototype khỏi object trước khi validate.
 *
 * BẮT BUỘC với `changelogItemSchema`: Jira đặt tên trường đúng bằng `toString`,
 * mà `toString` cũng là hàm có sẵn trên `Object.prototype`. Khi Jira KHÔNG gửi
 * trường đó, zod đọc `data['toString']` và nhặt phải HÀM kế thừa từ prototype
 * rồi báo "Expected string, received function" — làm hỏng việc parse của cả
 * trang changelog, không riêng dòng đó.
 *
 * `{...obj}` không cứu được: object sao chép ra vẫn có `Object.prototype`. Phải
 * dùng `Object.create(null)` mới thật sự không còn khoá kế thừa nào.
 */
function stripPrototype(v: unknown): unknown {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? Object.assign(Object.create(null) as Record<string, unknown>, v)
    : v;
}

export const changelogItemSchema = z.preprocess(
  stripPrototype,
  z.object({
    field: z.string(),
    fieldId: z.string().optional(),
    from: z.string().nullable().optional(),
    fromString: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    toString: z.string().nullable().optional(),
  }),
);

export const changelogEntrySchema = z.object({
  id: z.string(),
  author: z.object({ accountId: z.string() }).partial().optional(),
  created: z.string(),
  items: z.array(changelogItemSchema),
});

export const changelogPageSchema = z.object({
  values: z.array(changelogEntrySchema),
  startAt: z.number().optional(),
  maxResults: z.number().optional(),
  total: z.number().optional(),
  isLast: z.boolean().optional(),
});

/** `/worklog/updated` và `/worklog/deleted` phân trang theo `since`, KHÔNG theo `startAt`. */
export const worklogIdPageSchema = z.object({
  values: z.array(z.object({ worklogId: z.number(), updatedTime: z.number() })),
  since: z.number().optional(),
  until: z.number().optional(),
  lastPage: z.boolean(),
  nextPage: z.string().optional(),
});

export type JiraStatus = z.infer<typeof jiraStatusSchema>;
export type JiraField = z.infer<typeof jiraFieldSchema>;
export type JiraIssue = z.infer<typeof jiraIssueSchema>;
export type JiraWorklog = z.infer<typeof worklogSchema>;
export type JiraChangelogEntry = z.infer<typeof changelogEntrySchema>;
export type JiraUser = z.infer<typeof jiraUserSchema>;

// --------------------------------------------------------------------------
// Endpoint
// --------------------------------------------------------------------------

/**
 * Tìm issue theo JQL — endpoint "enhanced search" `/rest/api/3/search/jql`.
 *
 * KHÔNG dùng `/rest/api/3/search` cũ: Atlassian đã GỠ HẲN endpoint đó khỏi Jira
 * Cloud (chặn từ tháng 10/2025), mọi lời gọi trả `410 Gone`. Vì tra key Epic,
 * duyệt Epic và cả job đồng bộ đều đi qua đây, gọi endpoint đã gỡ khiến MỌI lần
 * tìm — kể cả một key hợp lệ — chết thành 500. (Lúc khởi động chỉ chạm
 * `/field` và `/status`, hai endpoint không bị gỡ, nên app vẫn lên được và lỗi
 * chỉ lộ ra khi tìm issue.)
 *
 * Khác biệt lớn nhất so với endpoint cũ là PHÂN TRANG BẰNG TOKEN, không phải
 * `startAt`/`total`: mỗi trang trả `nextPageToken` nếu còn nữa, và endpoint này
 * KHÔNG trả `total`. Hết trang khi không còn `nextPageToken` (hoặc `isLast`).
 *
 * `fields` là THAM SỐ BẮT BUỘC — không cho gọi thiếu. Truyền đủ trường cần giảm
 * ~70% dung lượng phản hồi (CONVENTIONS.md C-7).
 */
export async function searchIssues(
  client: JiraClient,
  params: { jql: string; fields: readonly string[]; maxResults?: number },
): Promise<JiraIssue[]> {
  const all: JiraIssue[] = [];
  const maxResults = params.maxResults ?? 100;
  let nextPageToken: string | undefined;

  for (;;) {
    const raw = await client.request<unknown>('/rest/api/3/search/jql', {
      method: 'POST',
      body: {
        jql: params.jql,
        fields: [...params.fields],
        maxResults,
        // Chỉ gửi token từ trang thứ hai trở đi — trang đầu không có.
        ...(nextPageToken !== undefined ? { nextPageToken } : {}),
      },
    });
    const page = searchResultSchema.parse(raw);
    all.push(...page.issues);

    // Dừng khi hết trang. So token trả về với token vừa gửi để chặn vòng lặp vô
    // hạn nếu Jira trả một token không tiến.
    if (page.isLast === true) break;
    if (page.nextPageToken === undefined || page.nextPageToken === nextPageToken) break;
    nextPageToken = page.nextPageToken;
  }

  return all;
}

/**
 * Lấy MỘT issue theo key.
 *
 * Khác `searchIssues` một điểm sống còn khi kiểm key: JQL `key IN (...)` bị Jira
 * Cloud trả **HTTP 400** ngay khi CHỈ MỘT key trong danh sách không tồn tại
 * ("An issue with key 'X' does not exist for field 'issueKey'."). Endpoint issue
 * trực tiếp thì trả lời RÀNH MẠCH từng key: 200 khi đọc được, 404 khi không có,
 * 403 khi thiếu quyền — nhờ đó tra được cả những key do người dùng dán vào có
 * thể sai mà không làm hỏng cả lượt.
 */
export async function getIssue(
  client: JiraClient,
  issueKey: string,
  fields: readonly string[],
): Promise<JiraIssue> {
  const raw = await client.request<unknown>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    query: { fields: fields.join(',') },
  });
  return jiraIssueSchema.parse(raw);
}

export async function getStatuses(client: JiraClient): Promise<JiraStatus[]> {
  const raw = await client.request<unknown>('/rest/api/3/status');
  return z.array(jiraStatusSchema).parse(raw);
}

export async function getFields(client: JiraClient): Promise<JiraField[]> {
  const raw = await client.request<unknown>('/rest/api/3/field');
  return z.array(jiraFieldSchema).parse(raw);
}

export async function getIssueWorklogs(
  client: JiraClient,
  issueKey: string,
): Promise<JiraWorklog[]> {
  const all: JiraWorklog[] = [];
  let startAt = 0;

  for (;;) {
    const raw = await client.request<unknown>(`/rest/api/3/issue/${issueKey}/worklog`, {
      query: { startAt, maxResults: 100 },
    });
    const page = worklogPageSchema.parse(raw);
    all.push(...page.worklogs);

    const total = page.total ?? all.length;
    startAt += page.worklogs.length;
    if (page.worklogs.length === 0 || startAt >= total) break;
  }

  return all;
}

export async function getIssueChangelog(
  client: JiraClient,
  issueKey: string,
): Promise<JiraChangelogEntry[]> {
  const all: JiraChangelogEntry[] = [];
  let startAt = 0;

  for (;;) {
    const raw = await client.request<unknown>(`/rest/api/3/issue/${issueKey}/changelog`, {
      query: { startAt, maxResults: 100 },
    });
    const page = changelogPageSchema.parse(raw);
    all.push(...page.values);

    if (page.isLast === true) break;
    const total = page.total ?? all.length;
    startAt += page.values.length;
    if (page.values.length === 0 || startAt >= total) break;
  }

  return all;
}

/**
 * ID các worklog vừa đổi kể từ mốc `since`.
 *
 * Phân trang theo `since`, KHÔNG theo `startAt` — dùng nhầm kiểu sẽ lặp vô hạn
 * hoặc bỏ sót dữ liệu.
 */
export async function getUpdatedWorklogIds(
  client: JiraClient,
  sinceMs: number,
): Promise<number[]> {
  return collectWorklogIds(client, '/rest/api/3/worklog/updated', sinceMs);
}

/** ID các worklog vừa bị xoá — dùng cho E-17. */
export async function getDeletedWorklogIds(
  client: JiraClient,
  sinceMs: number,
): Promise<number[]> {
  return collectWorklogIds(client, '/rest/api/3/worklog/deleted', sinceMs);
}

async function collectWorklogIds(
  client: JiraClient,
  path: string,
  sinceMs: number,
): Promise<number[]> {
  const ids: number[] = [];
  let since = sinceMs;

  for (;;) {
    const raw = await client.request<unknown>(path, { query: { since } });
    const page = worklogIdPageSchema.parse(raw);
    ids.push(...page.values.map((v) => v.worklogId));

    if (page.lastPage || page.values.length === 0) break;
    const maxUpdated = Math.max(...page.values.map((v) => v.updatedTime));
    if (maxUpdated <= since) break; // chống lặp vô hạn khi Jira trả mốc không tiến
    since = maxUpdated;
  }

  return ids;
}

/**
 * Tra tên hiển thị của user theo `accountId` — `GET /rest/api/3/user/bulk`.
 *
 * Dùng cho cột PIC (Signboard) khi "Request participants" chỉ trả về accountId.
 * Gọi theo lô ≤ 200 accountId (giới hạn của endpoint) và phân trang từng lô.
 *
 * Query có nhiều `accountId` LẶP LẠI — `JiraClient.request` chỉ nhận query dạng
 * `Record` (một khoá một giá trị) nên chuỗi query được dựng TAY vào path; hàm
 * request giữ nguyên query có sẵn trên path (nó chỉ `set` thêm các khoá của
 * `opts.query`, ở đây bỏ trống).
 *
 * Cần quyền "Browse users and groups". Thiếu quyền → Jira trả 403; nơi gọi
 * (worker) bắt lỗi và để cột PIC hiện accountId thay vì tên, KHÔNG làm hỏng đồng bộ.
 */
export async function getUsersByAccountIds(
  client: JiraClient,
  accountIds: readonly string[],
): Promise<JiraUser[]> {
  const MAX_IDS_PER_CALL = 200;
  const out: JiraUser[] = [];

  for (let i = 0; i < accountIds.length; i += MAX_IDS_PER_CALL) {
    const batch = accountIds.slice(i, i + MAX_IDS_PER_CALL);
    let startAt = 0;

    for (;;) {
      const qs = new URLSearchParams();
      qs.set('startAt', String(startAt));
      qs.set('maxResults', String(MAX_IDS_PER_CALL));
      for (const id of batch) qs.append('accountId', id);

      const raw = await client.request<unknown>(`/rest/api/3/user/bulk?${qs.toString()}`);
      const page = bulkUserPageSchema.parse(raw);
      out.push(...page.values);

      const total = page.total ?? out.length;
      startAt += page.values.length;
      if (page.isLast === true || page.values.length === 0 || startAt >= total) break;
    }
  }

  return out;
}

/** Lấy chi tiết worklog theo lô — tối đa 1000 ID mỗi lần gọi. */
export async function getWorklogsByIds(
  client: JiraClient,
  ids: readonly number[],
): Promise<JiraWorklog[]> {
  const out: JiraWorklog[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const raw = await client.request<unknown>('/rest/api/3/worklog/list', {
      method: 'POST',
      body: { ids: ids.slice(i, i + 1000) },
    });
    out.push(...z.array(worklogSchema).parse(raw));
  }
  return out;
}
