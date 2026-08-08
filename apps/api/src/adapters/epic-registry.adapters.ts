import type { PrismaClient } from '@app/db';
import {
  findByKey,
  insertIfAbsent,
  listMissingDates,
  listWithHealth,
  removeEpic,
  updateEpic,
} from '@app/db';
import {
  JiraHttpError,
  getIssue,
  searchIssues,
  type JiraClient,
  type JiraIssue,
  type ResolvedFieldMapping,
} from '@app/jira';
import type { TrackedEpicStatus } from '@app/shared';
import type {
  BackfillQueue,
  JiraEpicPort,
  JiraLookupResult,
  TrackedEpicStore,
} from '../services/epic-registry.service.js';

/**
 * Bộ chuyển đổi cho sổ đăng ký Epic.
 *
 * Ngoài điểm lắp ráp `main.ts` (composition root, nơi dựng `JiraClient` thật),
 * ĐÂY LÀ FILE DUY NHẤT trong `apps/api` được import `@app/jira`
 * (ARCHITECTURE.md §2). Tầng service chỉ nhìn thấy cổng, nên vẫn test được mà
 * không cần Jira sandbox.
 */

export function createTrackedEpicStore(prisma: PrismaClient): TrackedEpicStore {
  return {
    async findStatus(epicKey) {
      const row = await findByKey(prisma, epicKey);
      return (row?.status as TrackedEpicStatus | undefined) ?? null;
    },
    async existingKeys(keys) {
      if (keys.length === 0) return new Set<string>();
      const rows = await prisma.trackedEpic.findMany({
        where: { epicKey: { in: [...keys] } },
        select: { epicKey: true },
      });
      return new Set(rows.map((r) => r.epicKey));
    },
    insertIfAbsent: (rows) => insertIfAbsent(prisma, rows),
    update: (epicKey, data) => updateEpic(prisma, epicKey, data),
    remove: (epicKey, purge) => removeEpic(prisma, epicKey, purge),
    listWithHealth: (projectKey) => listWithHealth(prisma, projectKey),
    listMissingDates: (epicKey) => listMissingDates(prisma, epicKey),
  };
}

/** Số key tối đa nhận mỗi lần — trùng với giới hạn ở zod schema. */
export const MAX_KEYS_PER_LOOKUP = 100;

export function createJiraEpicPort(
  client: JiraClient,
  fields: ResolvedFieldMapping,
): JiraEpicPort {
  return {
    /**
     * Tra nhiều key: đường nhanh là 3 lần gọi `/search`, bất kể 1 hay 100 key.
     *
     * Gọi từng key một sẽ là 100 request cho một hộp thoại — đúng vấn đề N+1 mà
     * PRD §4.5 cảnh báo, chỉ là ở chỗ khác. Khi có key sai, tầng (1) buộc phải
     * lùi về tra lẻ (xem `resolveEpicKeys`) — đó là cái giá không tránh được để
     * một key hỏng không kéo sập cả lượt.
     */
    async lookup(keys) {
      const out = new Map<string, JiraLookupResult>();
      const wanted = [...new Set(keys)].slice(0, MAX_KEYS_PER_LOOKUP);
      if (wanted.length === 0) return out;

      // (1) Bản thân các key — CHỊU ĐƯỢC key sai (xem `resolveEpicKeys`).
      const epics = await resolveEpicKeys(client, wanted);
      const foundKeys = new Set(epics.map((e) => e.key));

      // (2) Con trực tiếp — Task (Phase)
      const tasks =
        foundKeys.size === 0
          ? []
          : await searchIssues(client, {
              jql: `parent IN (${[...foundKeys].map(quote).join(',')})`,
              fields: ['parent', 'issuetype'],
            });

      // (3) Cháu — Sub-task, nơi có estimate và ngày kế hoạch
      const taskKeys = tasks.map((t) => t.key);
      const subtasks =
        taskKeys.length === 0
          ? []
          : await searchIssues(client, {
              jql: `parent IN (${taskKeys.map(quote).join(',')})`,
              fields: ['parent', 'timeoriginalestimate', fields.wbsStartDate, fields.wbsEndDate],
            });

      const taskToEpic = new Map<string, string>();
      const phaseCount = new Map<string, number>();
      for (const t of tasks) {
        const epicKey = parentKeyOf(t.fields);
        if (!epicKey) continue;
        taskToEpic.set(t.key, epicKey);
        phaseCount.set(epicKey, (phaseCount.get(epicKey) ?? 0) + 1);
      }

      const subtaskCount = new Map<string, number>();
      const estimate = new Map<string, number>();
      const missingDates = new Map<string, number>();
      for (const s of subtasks) {
        const epicKey = taskToEpic.get(parentKeyOf(s.fields) ?? '');
        if (!epicKey) continue;
        subtaskCount.set(epicKey, (subtaskCount.get(epicKey) ?? 0) + 1);
        estimate.set(epicKey, (estimate.get(epicKey) ?? 0) + numberOf(s.fields['timeoriginalestimate']));
        // Thiếu MỘT trong hai ngày đã là không so sánh được sớm/trễ.
        if (s.fields[fields.wbsStartDate] == null || s.fields[fields.wbsEndDate] == null) {
          missingDates.set(epicKey, (missingDates.get(epicKey) ?? 0) + 1);
        }
      }

      for (const e of epics) {
        out.set(e.key, {
          ok: true,
          meta: {
            key: e.key,
            issueId: BigInt(e.id),
            displayName: stringOf(e.fields['summary']),
            projectKey: nestedString(e.fields['project'], 'key'),
            issueType: normalizeIssueType(nestedString(e.fields['issuetype'], 'name')),
            phaseCount: phaseCount.get(e.key) ?? 0,
            subtaskCount: subtaskCount.get(e.key) ?? 0,
            totalEstimateSeconds: estimate.get(e.key) ?? 0,
            missingWbsDateCount: missingDates.get(e.key) ?? 0,
          },
        });
      }

      // Key không có trong kết quả: Jira CỐ Ý không phân biệt "không tồn tại"
      // với "không có quyền đọc" trong JQL — trả lời khác nhau sẽ để lộ sự tồn
      // tại của issue. Phải hỏi riêng từng key mới biết, và chỉ hỏi những key
      // thiếu nên thường là không hỏi lần nào.
      await Promise.all(
        wanted
          .filter((k) => !foundKeys.has(k))
          .map(async (k) => out.set(k, await probeMissingKey(client, k))),
      );

      return out;
    },

    async browse(projectKey, page) {
      // Lọc theo `statusCategory`, KHÔNG theo `status.name` (C-4): tên trạng
      // thái là tiếng Nhật và admin đổi được bất cứ lúc nào.
      const issues = await searchIssues(client, {
        jql:
          `project = ${quote(projectKey)} AND issuetype = Epic ` +
          `AND statusCategory != Done ORDER BY created DESC`,
        fields: ['summary'],
        maxResults: page.maxResults,
      });

      return {
        items: issues
          .slice(page.startAt, page.startAt + page.maxResults)
          .map((i) => ({ key: i.key, displayName: stringOf(i.fields['summary']) })),
        total: issues.length,
      };
    },
  };
}

/** Trường lấy về khi tra Epic — đủ để phân loại và hiển thị. */
const EPIC_LOOKUP_FIELDS = ['summary', 'issuetype', 'project'] as const;

/**
 * Tra các key Epic, CHỊU ĐƯỢC key không tồn tại.
 *
 * Đường nhanh là MỘT câu JQL `key IN (...)` cho cả lô — đúng "3 lần gọi bất kể 1
 * hay 100 key" mà `lookup` hướng tới, và là đường đi khi mọi key đều hợp lệ
 * (Epic chọn từ màn hình duyệt, hoặc lượt tra lại toàn key hợp lệ trong `addEpics`).
 *
 * NHƯNG Jira Cloud trả **HTTP 400** ngay khi CHỈ MỘT key trong `key IN (...)`
 * không tồn tại / không đọc được ("... does not exist for field 'issueKey'") —
 * mà kiểm key thì key sai chính là ca thường gặp nhất. Không bắt lỗi này thì cả
 * lượt kiểm 500 (đúng bug đang gặp). Khi trúng 400 thì LÙI về tra từng key một
 * qua endpoint issue: chỉ những key đọc được mới lọt vào kết quả, phần còn lại
 * để `probeMissingKey` phân loại NOT_FOUND / NO_PERMISSION.
 *
 * Chỉ 400 mới lùi — lỗi khác (xác thực, 5xx) vẫn ném lên để lộ đúng nguyên nhân.
 */
async function resolveEpicKeys(
  client: JiraClient,
  keys: readonly string[],
): Promise<readonly JiraIssue[]> {
  try {
    return await searchIssues(client, {
      jql: `key IN (${keys.map(quote).join(',')})`,
      fields: [...EPIC_LOOKUP_FIELDS],
    });
  } catch (err) {
    if (!(err instanceof JiraHttpError) || err.status !== 400) throw err;
    const resolved = await Promise.all(keys.map((k) => getEpicIssueOrNull(client, k)));
    return resolved.filter((issue): issue is JiraIssue => issue !== null);
  }
}

/** GET một issue, trả `null` khi 404/403 để `probeMissingKey` phân loại tiếp. */
async function getEpicIssueOrNull(client: JiraClient, key: string): Promise<JiraIssue | null> {
  try {
    return await getIssue(client, key, EPIC_LOOKUP_FIELDS);
  } catch (err) {
    if (err instanceof JiraHttpError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

/** Phân biệt "không tồn tại" với "không có quyền" bằng một lần GET issue. */
async function probeMissingKey(client: JiraClient, key: string): Promise<JiraLookupResult> {
  try {
    await client.request<unknown>(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      query: { fields: 'summary' },
    });
    // Đọc được ở đây nhưng JQL không trả về: thường do chỉ mục Jira chưa kịp
    // cập nhật. Coi như không tìm thấy còn hơn báo sai là thiếu quyền.
    return { ok: false, reason: 'NOT_FOUND' };
  } catch (err) {
    if (err instanceof JiraHttpError && err.status === 403) {
      return { ok: false, reason: 'NO_PERMISSION' };
    }
    return { ok: false, reason: 'NOT_FOUND' };
  }
}

/**
 * Jira trả `issuetype.name` theo NGÔN NGỮ của tài khoản dịch vụ — tiếng Nhật là
 * `エピック`, `サブタスク`. So chuỗi 'Epic' thẳng sẽ trượt sạch trên Jira tiếng Nhật.
 */
function normalizeIssueType(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === 'epic' || n === 'エピック') return 'EPIC';
  if (n === 'sub-task' || n === 'subtask' || n === 'サブタスク') return 'SUBTASK';
  return name;
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

function parentKeyOf(fields: Record<string, unknown>): string | null {
  const parent = fields['parent'];
  if (parent && typeof parent === 'object' && 'key' in parent) {
    const k = (parent as { key: unknown }).key;
    return typeof k === 'string' ? k : null;
  }
  return null;
}

function nestedString(v: unknown, prop: string): string {
  if (v && typeof v === 'object' && prop in v) {
    const inner = (v as Record<string, unknown>)[prop];
    return typeof inner === 'string' ? inner : '';
  }
  return '';
}

function stringOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numberOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Đẩy job backfill vào BullMQ. Chỉ cần đúng một lệnh nên khai interface tối thiểu. */
export interface QueueLike {
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
}

export const BACKFILL_JOB_NAME = 'backfill-epic';

export function createBackfillQueue(queue: QueueLike): BackfillQueue {
  return {
    async enqueue(epicKeys) {
      for (const epicKey of epicKeys) {
        // `jobId` theo Epic để bấm "Thêm" hai lần không tạo hai job backfill
        // cùng chạy trên một Epic (C-6). Dấu `__` chứ không phải `:` — BullMQ cấm
        // `:` trong jobId tuỳ biến.
        await queue.add(BACKFILL_JOB_NAME, { epicKey }, { jobId: `${BACKFILL_JOB_NAME}__${epicKey}` });
      }
    },
  };
}
