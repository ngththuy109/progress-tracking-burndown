import {
  TRACKED_EPIC_TRANSITIONS,
  type AddEpicsRequest,
  type BrowsableEpic,
  type EpicAddWarning,
  type EpicValidationResult,
  type MissingDateRow,
  type PatchEpicRequest,
  type TrackedEpicStatus,
  type TrackedEpicSummary,
  type ValidateEpicsResponse,
} from '@app/shared';
import { ApiError } from './phase-config.service.js';

/**
 * Sổ đăng ký Epic — PRD §2.6.
 *
 * Cùng lối với T-09: mọi thứ bên ngoài đi qua CỔNG, nên logic ở đây test được
 * mà không cần PostgreSQL lẫn Jira.
 */

const SECONDS_PER_HOUR = 3600;

// ---------------------------------------------------------------------------
// Máy trạng thái vòng đời — PRD §2.6.1
// ---------------------------------------------------------------------------

/**
 * Chuyển trạng thái sai phải NÉM LỖI, không âm thầm cho qua.
 *
 * Ca nguy hiểm nhất là `PENDING → ACTIVE` thẳng: bỏ qua bước BACKFILLING nghĩa
 * là Epic vào job đêm khi chưa có lịch sử, biểu đồ thủng lỗ mà không rõ nguyên
 * nhân. Bảng này chỉ là tài liệu nếu không có ai gọi nó — nên mọi đường đổi
 * trạng thái đều phải đi qua đây.
 */
export function assertTransition(from: TrackedEpicStatus, to: TrackedEpicStatus): void {
  if (from === to) return;
  const allowed = TRACKED_EPIC_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new ApiError(
      409,
      'INVALID_TRANSITION',
      `An Epic cannot go from ${from} to ${to}. ` +
        `From ${from} the only allowed next states are: ${allowed.join(', ')}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cổng
// ---------------------------------------------------------------------------

export interface JiraEpicMeta {
  readonly key: string;
  readonly issueId: bigint;
  readonly displayName: string;
  readonly projectKey: string;
  /** Kiểu issue THẬT trên Jira — dùng để bắt ca "key này là Task chứ không phải Epic". */
  readonly issueType: string;
  readonly phaseCount: number;
  readonly subtaskCount: number;
  readonly totalEstimateSeconds: number;
  readonly missingWbsDateCount: number;
}

export type JiraLookupResult =
  | { readonly ok: true; readonly meta: JiraEpicMeta }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' | 'NO_PERMISSION' };

export interface JiraEpicPort {
  /** Tra nhiều key một lượt — PM dán cả danh sách chứ không nhập từng cái. */
  lookup(keys: readonly string[]): Promise<ReadonlyMap<string, JiraLookupResult>>;
  browse(
    projectKey: string,
    page: { startAt: number; maxResults: number },
  ): Promise<{ items: readonly Omit<BrowsableEpic, 'alreadyTracked'>[]; total: number }>;
}

export interface TrackedEpicStore {
  findStatus(epicKey: string): Promise<TrackedEpicStatus | null>;
  existingKeys(keys: readonly string[]): Promise<ReadonlySet<string>>;
  insertIfAbsent(rows: readonly InsertEpicRow[]): Promise<number>;
  update(epicKey: string, data: EpicPatchData): Promise<void>;
  remove(epicKey: string, purge: boolean): Promise<void>;
  listWithHealth(projectKey: string | null): Promise<readonly TrackedEpicSummary[]>;
  listMissingDates(epicKey: string): Promise<readonly MissingDateRow[]>;
}

/**
 * Trường nào cũng có thể vắng mặt.
 *
 * Viết `| undefined` tường minh chứ không dùng `Partial<>`: dự án bật
 * `exactOptionalPropertyTypes`, ở chế độ đó `Partial<{status: string}>` nghĩa là
 * "được phép vắng mặt" chứ KHÔNG phải "được phép bằng undefined" — mà zod
 * `.optional()` lại sinh ra đúng kiểu thứ hai.
 */
export interface EpicPatchData {
  readonly status?: string | undefined;
  readonly timezone?: string | undefined;
  readonly calendarId?: string | undefined;
  readonly note?: string | null | undefined;
}

export interface InsertEpicRow {
  readonly epicKey: string;
  readonly epicId: bigint;
  readonly projectKey: string;
  readonly displayName: string;
  readonly timezone: string;
  readonly calendarId: string;
  readonly addedBy: string;
  readonly note: string | null;
}

export interface BackfillQueue {
  /** Đẩy job backfill. KHÔNG chạy đồng bộ ngay trong request. */
  enqueue(epicKeys: readonly string[]): Promise<void>;
}

export interface HierarchyConfigPort {
  /**
   * Issue type được chấp nhận làm ROOT theo Hierarchy Profile hiệu lực của
   * project (tầng `levels[0].issueTypes`). `null`/mảng rỗng = nhận mọi type.
   * Tên trả về ở dạng đã khai trong config — so KHÔNG phân biệt hoa thường.
   */
  rootIssueTypesFor(projectKey: string): Promise<readonly string[] | null>;
}

export interface EpicRegistryDeps {
  readonly store: TrackedEpicStore;
  readonly jira: JiraEpicPort;
  readonly backfill: BackfillQueue;
  /**
   * Vắng mặt = luật cũ "chỉ nhận Epic". Có mặt thì màn đăng ký nhận đúng loại
   * issue mà cấu trúc dự án khai — dự án 2 tầng đăng ký một ticket Task làm root.
   */
  readonly config?: HierarchyConfigPort | undefined;
}

// ---------------------------------------------------------------------------
// Kiểm tra trước khi thêm — PRD §2.6.3
// ---------------------------------------------------------------------------

/**
 * Kiểm tra cả danh sách key và trả kết quả TỪNG DÒNG.
 *
 * Không dừng ở key hỏng đầu tiên: PM dán 20 key thì cần biết cả 20 cái sai chỗ
 * nào trong một lượt, chứ không phải sửa một cái rồi bấm lại.
 */
export async function validateKeys(
  deps: EpicRegistryDeps,
  keys: readonly string[],
): Promise<ValidateEpicsResponse> {
  // Khử trùng lặp nhưng GIỮ THỨ TỰ PM đã dán, để họ dò lại được theo danh sách.
  const unique = [...new Set(keys.map((k) => k.trim()).filter((k) => k !== ''))];

  const [lookups, tracked] = await Promise.all([
    deps.jira.lookup(unique),
    deps.store.existingKeys(unique),
  ]);

  // Loại issue được nhận làm root, theo Hierarchy Profile của TỪNG project
  // (mỗi project một profile; tra một lần cho mỗi project xuất hiện).
  const rootTypesByProject = new Map<string, readonly string[] | null>();
  if (deps.config) {
    const projects = new Set(
      [...lookups.values()].flatMap((r) => (r.ok ? [r.meta.projectKey] : [])),
    );
    await Promise.all(
      [...projects].map(async (p) =>
        rootTypesByProject.set(p, await deps.config!.rootIssueTypesFor(p)),
      ),
    );
  }

  const acceptsRootType = (projectKey: string, issueType: string): boolean => {
    // Không có cổng cấu hình thì giữ nguyên luật cũ: chỉ nhận Epic.
    if (!deps.config) return issueType === 'EPIC';
    const allowed = rootTypesByProject.get(projectKey);
    if (!allowed || allowed.length === 0) return true;
    const needle = issueType.trim().toLowerCase();
    return allowed.some((t) => t.trim().toLowerCase() === needle);
  };

  const results: EpicValidationResult[] = unique.map((key) => {
    // Xét "đã theo dõi" TRƯỚC: đó là thông tin hữu ích hơn cho PM, và tránh
    // báo NOT_FOUND cho một Epic họ biết chắc là có.
    if (tracked.has(key)) {
      return { key, valid: false, reason: 'ALREADY_TRACKED', message: 'Already tracked' };
    }

    const found = lookups.get(key);
    if (!found || !found.ok) {
      const reason = found?.ok === false ? found.reason : 'NOT_FOUND';
      return {
        key,
        valid: false,
        reason,
        message:
          reason === 'NO_PERMISSION'
            ? `No permission to read issue ${key}`
            : `${key} not found`,
      };
    }

    if (!acceptsRootType(found.meta.projectKey, found.meta.issueType)) {
      return {
        key,
        valid: false,
        // Giữ mã lý do cũ để UI không phải đổi; câu chữ nói theo profile.
        reason: 'NOT_AN_EPIC',
        message: `${key} is a ${found.meta.issueType}, which this project's structure does not accept as a tracking root`,
      };
    }

    // Cảnh báo ≠ chặn. Epic chưa có Phase nào VẪN thêm được — có thể PM vừa tạo
    // và sắp thêm Task; chặn lại chỉ làm phiền.
    const warnings: EpicAddWarning[] = [];
    if (found.meta.phaseCount === 0) warnings.push('NO_CHILD_TASK');
    if (found.meta.missingWbsDateCount > 0) warnings.push('MISSING_WBS_DATES');

    return {
      key,
      valid: true,
      displayName: found.meta.displayName,
      projectKey: found.meta.projectKey,
      phaseCount: found.meta.phaseCount,
      subtaskCount: found.meta.subtaskCount,
      totalEstimateHours: found.meta.totalEstimateSeconds / SECONDS_PER_HOUR,
      missingWbsDateCount: found.meta.missingWbsDateCount,
      warnings,
    };
  });

  const valid = results.filter((r) => r.valid).length;
  return {
    results,
    summary: { valid, invalid: results.length - valid, canAdd: valid },
  };
}

/**
 * Thêm các key HỢP LỆ rồi đẩy job backfill. Key hỏng bị bỏ qua, không làm hỏng
 * cả lượt.
 *
 * Tuyệt đối không tự chạy đồng bộ ở đây: backfill 6 tháng mất tới 5 phút,
 * request sẽ timeout và PM tưởng thất bại rồi bấm thêm lần nữa.
 */
export async function addEpics(
  deps: EpicRegistryDeps,
  req: AddEpicsRequest,
  addedBy: string,
): Promise<ValidateEpicsResponse & { added: number }> {
  assertValidTimezone(req.timezone);

  const check = await validateKeys(deps, req.keys);
  const ok = check.results.filter((r) => r.valid);
  if (ok.length === 0) return { ...check, added: 0 };

  const lookups = await deps.jira.lookup(ok.map((r) => r.key));
  const rows: InsertEpicRow[] = [];
  for (const r of ok) {
    const found = lookups.get(r.key);
    if (!found?.ok) continue;
    rows.push({
      epicKey: r.key,
      epicId: found.meta.issueId,
      projectKey: found.meta.projectKey,
      displayName: found.meta.displayName,
      timezone: req.timezone,
      calendarId: req.calendarId,
      addedBy,
      note: req.note,
    });
  }

  const added = await deps.store.insertIfAbsent(rows);
  if (rows.length > 0) await deps.backfill.enqueue(rows.map((r) => r.epicKey));

  return { ...check, added };
}

export function listEpics(
  deps: EpicRegistryDeps,
  projectKey: string | null,
): Promise<readonly TrackedEpicSummary[]> {
  return deps.store.listWithHealth(projectKey);
}

/**
 * Duyệt Epic của một project để tích chọn.
 *
 * PHẢI phân trang: project lớn có hàng trăm Epic, trả hết một lần vừa chậm vừa
 * tốn quota Jira.
 */
export async function browseEpics(
  deps: EpicRegistryDeps,
  projectKey: string,
  page: { startAt: number; maxResults: number },
): Promise<{ items: readonly BrowsableEpic[]; total: number; startAt: number; maxResults: number }> {
  const { items, total } = await deps.jira.browse(projectKey, page);
  const tracked = await deps.store.existingKeys(items.map((i) => i.key));
  return {
    items: items.map((i) => ({ ...i, alreadyTracked: tracked.has(i.key) })),
    total,
    startAt: page.startAt,
    maxResults: page.maxResults,
  };
}

export async function patchEpic(
  deps: EpicRegistryDeps,
  epicKey: string,
  patch: PatchEpicRequest,
): Promise<void> {
  const current = await deps.store.findStatus(epicKey);
  if (current === null) throw new ApiError(404, 'NOT_TRACKED', `${epicKey} is not tracked.`);

  if (patch.timezone !== undefined) assertValidTimezone(patch.timezone);
  if (patch.status !== undefined) assertTransition(current, patch.status);

  await deps.store.update(epicKey, patch);
}

export async function removeEpic(
  deps: EpicRegistryDeps,
  epicKey: string,
  args: { purge: boolean; confirmKey: string | null },
): Promise<void> {
  const current = await deps.store.findStatus(epicKey);
  if (current === null) throw new ApiError(404, 'NOT_TRACKED', `${epicKey} is not tracked.`);

  // Xoá sạch là thao tác KHÔNG HOÀN TÁC ĐƯỢC, nên đòi gõ lại đúng key chứ không
  // chỉ một tham số `?purge=true` (PRD §2.6.4). Tham số quá dễ bấm nhầm.
  if (args.purge && args.confirmKey !== epicKey) {
    throw new ApiError(
      400,
      'CONFIRM_REQUIRED',
      `Deleting all data cannot be undone. Type "${epicKey}" into confirmKey to confirm.`,
    );
  }

  await deps.store.remove(epicKey, args.purge);
}

export async function listMissingDates(
  deps: EpicRegistryDeps,
  epicKey: string,
): Promise<readonly MissingDateRow[]> {
  const current = await deps.store.findStatus(epicKey);
  if (current === null) throw new ApiError(404, 'NOT_TRACKED', `${epicKey} is not tracked.`);
  return deps.store.listMissingDates(epicKey);
}

/**
 * Múi giờ phải là tên IANA thật (C-1).
 *
 * Dùng `Intl` thay vì luxon: `IANAZone.isValidZone` của luxon chính là phép thử
 * này bọc trong try/catch, nên kết quả giống hệt — không đáng kéo cả một thư
 * viện ngày tháng vào `apps/api` chỉ để kiểm tra một chuỗi.
 *
 * Sai múi giờ là lỗi lệch NGÀY, không phải lệch giờ: một worklog log lúc 23:30
 * sẽ rơi sang ngày hôm sau và biểu đồ lệch hẳn một cột.
 */
export function assertValidTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ApiError(
      400,
      'INVALID_TIMEZONE',
      `"${tz}" is not a valid IANA time zone. Valid examples: Asia/Ho_Chi_Minh, Asia/Tokyo.`,
    );
  }
}
