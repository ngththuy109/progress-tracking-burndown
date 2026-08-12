/**
 * Sổ đăng ký Epic — PRD §2.6, Phụ lục B.
 *
 * Bảng `tracked_epic` là NGUỒN DUY NHẤT trả lời "job đêm phải chạy cho Epic
 * nào". Hệ thống không tự động theo dõi mọi Epic; PM phải chủ động thêm.
 */
import { z } from 'zod';
import { TRACKED_EPIC_STATUS, type ScopeType } from './enums.js';

/**
 * Bộ chọn phạm vi lá của một scope theo dõi (DYNAMIC-TIERS-DESIGN §6):
 *   CONTAINER — lá là hậu duệ của issue `epicKey` (Epic/Task, mọi độ sâu);
 *   QUERY     — lá là ticket khớp `scopeJql` (project phẳng, không container).
 * `leafIssueTypes` = loại issue được coi là lá; rỗng = suy theo cây.
 */
export interface TrackedScope {
  readonly scopeType: ScopeType;
  readonly scopeJql: string | null;
  readonly leafIssueTypes: readonly string[];
}

/** Đọc scope từ một hàng tracked_epic (giá trị thô từ DB), có mặc định an toàn. */
export function scopeOf(row: {
  scopeType?: string | null;
  scopeJql?: string | null;
  leafIssueTypes?: readonly string[] | null;
}): TrackedScope {
  const scopeType: ScopeType = row.scopeType === 'QUERY' ? 'QUERY' : 'CONTAINER';
  return {
    scopeType,
    scopeJql: row.scopeJql ?? null,
    leafIssueTypes: row.leafIssueTypes ?? [],
  };
}

/** Nhãn hiển thị cho hai kiểu scope. */
export const SCOPE_TYPE_LABEL: Record<ScopeType, string> = {
  CONTAINER: 'Container (Epic/Task và hậu duệ)',
  QUERY: 'JQL (project phẳng)',
};

/** Lý do một key không thêm được. Dùng đúng các mã này, đừng tự chế thêm. */
export const EPIC_REJECT_REASON = [
  'NOT_FOUND',
  'NOT_AN_EPIC',
  'NO_PERMISSION',
  'ALREADY_TRACKED',
] as const;
export type EpicRejectReason = (typeof EPIC_REJECT_REASON)[number];

/** Cảnh báo vẫn cho thêm — khác hẳn `reason` là chặn hẳn. */
export const EPIC_ADD_WARNING = ['NO_CHILD_TASK', 'MISSING_WBS_DATES'] as const;
export type EpicAddWarning = (typeof EPIC_ADD_WARNING)[number];

export const validateEpicsRequestSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(100),
});
export type ValidateEpicsRequest = z.infer<typeof validateEpicsRequestSchema>;

export interface EpicValidationOk {
  readonly key: string;
  readonly valid: true;
  readonly displayName: string;
  readonly projectKey: string;
  readonly phaseCount: number;
  readonly subtaskCount: number;
  readonly totalEstimateHours: number;
  readonly missingWbsDateCount: number;
  readonly warnings: readonly EpicAddWarning[];
}

export interface EpicValidationFailed {
  readonly key: string;
  readonly valid: false;
  readonly reason: EpicRejectReason;
  readonly message: string;
}

export type EpicValidationResult = EpicValidationOk | EpicValidationFailed;

export interface ValidateEpicsResponse {
  readonly results: readonly EpicValidationResult[];
  readonly summary: { readonly valid: number; readonly invalid: number; readonly canAdd: number };
}

/**
 * Đăng ký scope QUERY (project phẳng §2.5): `keys` là ID scope do người dùng đặt (không
 * phải Epic key), `scope.scopeJql` là JQL tìm lá. Vắng `scope` ⇒ luồng CONTAINER cũ
 * (validate + lookup Epic trên Jira) — không đổi.
 */
export const addScopeSchema = z.object({
  scopeJql: z.string().min(1, 'JQL is required for a QUERY scope.'),
  leafIssueTypes: z.array(z.string()).default([]),
  /** Project key để kế thừa cấu hình + hiển thị. */
  projectKey: z.string().min(1),
});
export type AddScope = z.infer<typeof addScopeSchema>;

export const addEpicsRequestSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).max(100),
  /** Múi giờ IANA. Quyết định "một ngày" bắt đầu lúc nào (C-1). */
  timezone: z.string().min(1),
  calendarId: z.string().min(1),
  note: z.string().max(500).nullable().default(null),
  /** Có ⇒ đăng ký scope QUERY; vắng ⇒ CONTAINER (đăng ký Epic như cũ). */
  scope: addScopeSchema.optional(),
});
export type AddEpicsRequest = z.infer<typeof addEpicsRequestSchema>;

export const patchEpicRequestSchema = z
  .object({
    /** Chỉ đổi qua lại giữa `PAUSED` và `ACTIVE` — xem máy trạng thái. */
    status: z.enum(TRACKED_EPIC_STATUS).optional(),
    timezone: z.string().min(1).optional(),
    calendarId: z.string().min(1).optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.' });
export type PatchEpicRequest = z.infer<typeof patchEpicRequestSchema>;

export const deleteEpicRequestSchema = z.object({
  purge: z.boolean().default(false),
  /**
   * Khi `purge = true`, người dùng phải GÕ LẠI key Epic (PRD §2.6.4).
   *
   * Một tham số query `?purge=true` quá dễ bấm nhầm cho một thao tác xoá sạch
   * lịch sử và không hoàn tác được.
   */
  confirmKey: z.string().nullable().default(null),
});

export interface TrackedEpicSummary {
  readonly epicKey: string;
  readonly displayName: string;
  readonly projectKey: string;
  readonly status: string;
  readonly timezone: string;
  readonly calendarId: string;
  readonly lastSyncedAt: string | null;
  readonly lastError: string | null;
  readonly note: string | null;
  readonly dataHealth: {
    readonly phaseCount: number;
    readonly subtaskCount: number;
    readonly totalEstimateHours: number;
    /** Số Sub-task thiếu `wbs_start_date` / `wbs_end_date` — rủi ro R-08. */
    readonly missingWbsDateCount: number;
    readonly unclassifiedTaskCount: number;
  };
}

export interface MissingDateRow {
  readonly issueKey: string;
  readonly summary: string;
  readonly parentKey: string | null;
  readonly missingStart: boolean;
  readonly missingEnd: boolean;
}

export interface BrowsableEpic {
  readonly key: string;
  readonly displayName: string;
  readonly alreadyTracked: boolean;
}

// ---------------------------------------------------------------------------
// Schema phản hồi — frontend (T-29) kiểm dữ liệu tại biên bằng chính chúng
// ---------------------------------------------------------------------------

/**
 * Khai bằng zod chứ không chỉ bằng `interface`.
 *
 * `interface` biến mất lúc chạy, nên frontend không kiểm được gì. Thiếu bước
 * kiểm tại biên thì một trường vắng mặt sẽ lộ ra dưới dạng `undefined` ở giữa
 * màn hình, cách chỗ gây lỗi rất xa.
 */
export const trackedEpicSummarySchema = z.object({
  epicKey: z.string(),
  displayName: z.string(),
  projectKey: z.string(),
  status: z.string(),
  timezone: z.string(),
  calendarId: z.string(),
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  note: z.string().nullable(),
  dataHealth: z.object({
    phaseCount: z.number().int(),
    subtaskCount: z.number().int(),
    totalEstimateHours: z.number(),
    missingWbsDateCount: z.number().int(),
    unclassifiedTaskCount: z.number().int(),
  }),
});

export const listEpicsResponseSchema = z.object({ epics: z.array(trackedEpicSummarySchema) });

export const epicValidationResultSchema = z.union([
  z.object({
    key: z.string(),
    valid: z.literal(true),
    displayName: z.string(),
    projectKey: z.string(),
    phaseCount: z.number().int(),
    subtaskCount: z.number().int(),
    totalEstimateHours: z.number(),
    missingWbsDateCount: z.number().int(),
    warnings: z.array(z.enum(EPIC_ADD_WARNING)),
  }),
  z.object({
    key: z.string(),
    valid: z.literal(false),
    reason: z.enum(EPIC_REJECT_REASON),
    message: z.string(),
  }),
]);

export const validateEpicsResponseSchema = z.object({
  results: z.array(epicValidationResultSchema),
  summary: z.object({
    valid: z.number().int(),
    invalid: z.number().int(),
    canAdd: z.number().int(),
  }),
});

export const addEpicsResponseSchema = z.object({
  added: z.array(z.string()),
  skipped: z.array(z.string()),
  estimatedSeconds: z.number().int(),
});
export type AddEpicsResponse = z.infer<typeof addEpicsResponseSchema>;

export const missingDatesResponseSchema = z.object({
  epicKey: z.string(),
  rows: z.array(
    z.object({
      issueKey: z.string(),
      summary: z.string(),
      parentKey: z.string().nullable(),
      missingStart: z.boolean(),
      missingEnd: z.boolean(),
    }),
  ),
});

export const browseEpicsResponseSchema = z.object({
  epics: z.array(
    z.object({
      key: z.string(),
      displayName: z.string(),
      alreadyTracked: z.boolean(),
    }),
  ),
});

/** Câu giải thích cho từng lý do từ chối — dùng chung giữa API và giao diện. */
export const EPIC_REJECT_MESSAGE: Readonly<Record<(typeof EPIC_REJECT_REASON)[number], string>> = {
  NOT_FOUND: 'No such issue on Jira. Check the key — it may be a typo.',
  NOT_AN_EPIC: 'This is not an Epic but another issue type. Only Epics can be tracked.',
  ALREADY_TRACKED: 'This Epic is already being tracked.',
  NO_PERMISSION: 'The current account cannot read this Epic on Jira.',
};
