/**
 * Enum dùng chung giữa DB, engine, API và web.
 *
 * Dùng `as const` + union type thay cho `enum` của TypeScript: giá trị chạy thẳng
 * được vào cột `VARCHAR` của PostgreSQL mà không cần đổi kiểu, và tree-shake được.
 */

// ---------------------------------------------------------------------------
// Trạng thái Jira — CONVENTIONS.md C-4
//
// CHỈ được đọc `fields.status.statusCategory.key`. TUYỆT ĐỐI CẤM so sánh
// `status.name` — tên hiển thị là tiếng Nhật (完了, 対応中) và admin đổi được
// bất cứ lúc nào.
//
// Lưu ý: đây là `statusCategory.key`, KHÔNG phải `statusCategory.name`
// ('To Do' | 'In Progress' | 'Done'). Dùng nhầm sẽ không khớp gì cả.
// ---------------------------------------------------------------------------
export const STATUS_CATEGORY = ['new', 'indeterminate', 'done'] as const;
export type StatusCategory = (typeof STATUS_CATEGORY)[number];

/** Nhóm trạng thái hiển thị, chỉ dùng cho UI. Không dùng để so khớp. */
export const STATUS_CATEGORY_LABEL: Record<StatusCategory, string> = {
  new: 'To do',
  indeterminate: 'In progress',
  done: 'Done',
};

// ---------------------------------------------------------------------------
// Vòng đời Epic trong sổ đăng ký — PRD §2.6.1
// ---------------------------------------------------------------------------
export const TRACKED_EPIC_STATUS = [
  'PENDING',
  'BACKFILLING',
  'ACTIVE',
  'PAUSED',
  'ERROR',
] as const;
export type TrackedEpicStatus = (typeof TRACKED_EPIC_STATUS)[number];

/**
 * Chuyển trạng thái hợp lệ. Chuyển sai phải ném lỗi, không âm thầm cho qua.
 *
 * Đặc biệt: KHÔNG cho `PENDING → ACTIVE` trực tiếp. Bỏ qua bước BACKFILLING
 * nghĩa là Epic vào job đêm khi chưa có lịch sử → biểu đồ thủng lỗ mà không
 * rõ nguyên nhân.
 */
export const TRACKED_EPIC_TRANSITIONS: Record<TrackedEpicStatus, readonly TrackedEpicStatus[]> = {
  PENDING: ['BACKFILLING', 'ERROR'],
  BACKFILLING: ['ACTIVE', 'ERROR'],
  ACTIVE: ['PAUSED', 'ERROR'],
  PAUSED: ['ACTIVE'],
  ERROR: ['BACKFILLING'],
};

// ---------------------------------------------------------------------------
// Kết quả phân tách tiêu đề Sub-task — PRD §2.9.4
// ---------------------------------------------------------------------------
export const SB_PARSE_STATUS = ['OK', 'UNPARSED', 'UNKNOWN_TASK_TYPE'] as const;
export type SbParseStatus = (typeof SB_PARSE_STATUS)[number];

// ---------------------------------------------------------------------------
// Trạng thái ô bảng Signboard — PRD §6.4
//
// `NO_PLAN` là trạng thái THỨ SÁU, thêm ngoài 5 trạng thái ban đầu. Thiếu mốc
// kế hoạch thì không có gì để so sánh: không được ép vào `NYS` (sai nghĩa, task
// có thể đang làm dở) cũng không được ép vào `ON_SCHEDULE` (bịa kết luận không
// có căn cứ).
// ---------------------------------------------------------------------------
export const SIGNBOARD_STATUS = [
  'COMPLETED',
  'ON_SCHEDULE',
  'NYS',
  'DELAY_START',
  'DELAY_END',
  'NO_PLAN',
] as const;
export type SignboardStatus = (typeof SIGNBOARD_STATUS)[number];

/**
 * Thứ hạng khi gộp nhiều Sub-task vào một ô — PRD §6.5. Số lớn hơn = XẤU HƠN.
 *
 * `COMPLETED` xếp hạng 0 nghĩa là nó THUA mọi trạng thái khác khi gộp. Trực giác
 * dễ nghĩ ngược lại ("xong rồi thì tốt nhất"), nhưng ô có 1 xong 1 chưa bắt đầu
 * thì ô đó CHƯA XONG — hiện màu xanh là nói dối.
 */
export const SIGNBOARD_STATUS_RANK: Record<SignboardStatus, number> = {
  COMPLETED: 0,
  NYS: 1,
  ON_SCHEDULE: 2,
  NO_PLAN: 3,
  DELAY_START: 4,
  DELAY_END: 5,
};

export const SIGNBOARD_STATUS_LABEL: Record<SignboardStatus, string> = {
  COMPLETED: 'Done',
  ON_SCHEDULE: 'On schedule',
  NYS: 'Not started yet',
  DELAY_START: 'Late start',
  DELAY_END: 'Late finish',
  NO_PLAN: 'No planned dates',
};

// ---------------------------------------------------------------------------
// Cấu hình nhận diện Phase — PRD §2.2
// ---------------------------------------------------------------------------
export const CONFIG_SCOPE = ['GLOBAL', 'PROJECT'] as const;
export type ConfigScope = (typeof CONFIG_SCOPE)[number];

export const MATCH_MODE = ['CONTAINS', 'REGEX'] as const;
export type MatchMode = (typeof MATCH_MODE)[number];

/** Mã Phase cố định duy nhất. Mọi mã khác đều do PM cấu hình. */
export const UNCLASSIFIED_PHASE = 'UNCLASSIFIED' as const;

// ---------------------------------------------------------------------------
// Nhật ký chạy job
// ---------------------------------------------------------------------------
export const SYNC_RUN_TYPE = ['DAILY', 'BACKFILL', 'RECOMPUTE', 'MANUAL'] as const;
export type SyncRunType = (typeof SYNC_RUN_TYPE)[number];

export const SYNC_RUN_STATUS = ['RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED'] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUS)[number];

// ---------------------------------------------------------------------------
// Lịch sử dịch chuyển kế hoạch — tuyến phòng thủ cho rủi ro R-11
// ---------------------------------------------------------------------------
export const SHIFT_TYPE = ['START_MOVED', 'END_MOVED'] as const;
export type ShiftType = (typeof SHIFT_TYPE)[number];

// ---------------------------------------------------------------------------
// Mã cảnh báo nghiệp vụ — CONVENTIONS.md C-9
// Dùng đúng các mã này, đừng tự chế mã mới.
// ---------------------------------------------------------------------------
export const WARNING_CODE = [
  'PHASE_MISMATCH',
  'REGEX_TIMEOUT',
  'ORPHAN_PHASE_CODE',
  'INVALID_PHASE_PERIOD',
  'FIELD_MAPPING_BROKEN',
  'AMBIGUOUS_PHASE_RULE',
  'HISTORY_TRUNCATED',
  'ESTIMATE_HISTORY_MISSING',
  'MISSING_ESTIMATE',
  'NO_PHASE_FOUND',
  // Trường bóc từ tiêu đề dài quá cột VARCHAR nên phải cắt bớt khi lưu — xem
  // persist-issues.ts. Anh em với HISTORY_TRUNCATED: dữ liệu Jira vượt giới hạn,
  // không phải cấu hình sai.
  'FIELD_TRUNCATED',
] as const;
export type WarningCode = (typeof WARNING_CODE)[number];

// ---------------------------------------------------------------------------
// Phân tầng linh động N tầng — DYNAMIC-TIERS-DESIGN.md
//
// Tổng quát hoá bộ phase_* (một tầng "Phase") thành 1..N tầng nhóm logic. Mã cứng
// duy nhất vẫn là UNCLASSIFIED_PHASE (dùng chung cho tầng chưa nhận diện được).
// ---------------------------------------------------------------------------

/** Vai trò của một tầng. Đúng MỘT tầng mỗi cấu hình là PHASE (giữ Signboard/per-phase). */
export const GROUP_TIER_ROLE = ['PHASE', 'GROUP'] as const;
export type GroupTierRole = (typeof GROUP_TIER_ROLE)[number];

/** Cách bóc khoá nhóm cho một tầng. */
export const GROUP_SOURCE_TYPE = [
  'PARENT_TASK_TITLE',
  'SELF_TITLE',
  'SUBTASK_TITLE_TOKEN',
  'LABEL',
  'CUSTOM_FIELD',
] as const;
export type GroupSourceType = (typeof GROUP_SOURCE_TYPE)[number];

/** Cách một tracked scope chọn tập lá: theo issue container hay theo JQL. */
export const SCOPE_TYPE = ['CONTAINER', 'QUERY'] as const;
export type ScopeType = (typeof SCOPE_TYPE)[number];
