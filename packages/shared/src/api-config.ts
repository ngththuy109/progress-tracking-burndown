/**
 * Hợp đồng HTTP của nhóm API cấu hình Phase — PRD Phụ lục B.
 *
 * Để ở `shared` vì frontend (T-21) dùng lại đúng những schema này. Tên trường
 * PHẢI khớp Phụ lục B: màn hình quản trị đã được đặc tả theo đó, đổi tên là
 * hỏng card sau.
 */
import { z } from 'zod';
import { configPayloadSchema, matchRuleSchema } from './phase-config.js';

/** So kết quả phân loại của cấu hình nháp với `phase_code` đang lưu. */
export const PREVIEW_ROW_STATUS = ['UNCHANGED', 'CHANGED', 'STILL_UNCLASSIFIED'] as const;
export type PreviewRowStatus = (typeof PREVIEW_ROW_STATUS)[number];

/**
 * Ước tính thô thời gian tính lại một Epic.
 *
 * ĐÂY LÀ ƯỚC TÍNH, KHÔNG PHẢI CAM KẾT. Frontend phải hiện dưới dạng "khoảng ~2
 * phút", tuyệt đối không làm đồng hồ đếm ngược — số thật phụ thuộc số ngày lịch
 * sử và số Sub-task của từng Epic.
 */
export const RECOMPUTE_SECONDS_PER_EPIC = 40;

/** Nhãn hiển thị của Phase đặc biệt `UNCLASSIFIED`. */
export const UNCLASSIFIED_LABEL = 'Unclassified';

// ---------------------------------------------------------------------------
// POST /api/config/phase/preview
// ---------------------------------------------------------------------------

export const previewRequestSchema = z.object({
  /** `null` = đang sửa bộ Mặc định (GLOBAL). */
  projectKey: z.string().min(1).nullable(),
  draft: configPayloadSchema,
  /**
   * Số dòng TỐI ĐA trả về. Phần tóm tắt luôn đếm trên TOÀN BỘ Task, không chỉ
   * phần trả về — so `rows.length` với `totalTasks` là biết có bị cắt hay không.
   */
  limit: z.number().int().min(1).max(500).default(200),
});
export type PreviewRequest = z.infer<typeof previewRequestSchema>;

export const previewWinningRuleSchema = z.object({
  keyword: z.string(),
  mode: matchRuleSchema.shape.matchMode,
  priority: z.number().int(),
});

export const previewRowSchema = z.object({
  taskKey: z.string(),
  originalTitle: z.string(),
  /** Mẫu tiêu đề nào đã khớp. `null` = không mẫu nào khớp. */
  matchedPattern: z.string().nullable(),
  /** Phần chữ bóc ra từ tiêu đề. */
  extractedName: z.string().nullable(),
  /** Luật nào đã thắng — thứ PM cần nhất để hiểu vì sao ra kết quả đó. */
  winningRule: previewWinningRuleSchema.nullable(),
  resultPhaseCode: z.string(),
  resultLabel: z.string(),
  previousPhaseCode: z.string(),
  status: z.enum(PREVIEW_ROW_STATUS),
});
export type PreviewRow = z.infer<typeof previewRowSchema>;

export const previewSummarySchema = z.object({
  unchanged: z.number().int(),
  changed: z.number().int(),
  stillUnclassified: z.number().int(),
  affectedEpics: z.number().int(),
  estimatedRecomputeSeconds: z.number().int(),
});

export const apiWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ApiWarning = z.infer<typeof apiWarningSchema>;

export const previewResponseSchema = z.object({
  projectKey: z.string().nullable(),
  /** Tổng số Task đã xét, KỂ CẢ phần không nằm trong `rows` do giới hạn. */
  totalTasks: z.number().int(),
  summary: previewSummarySchema,
  warnings: z.array(apiWarningSchema),
  rows: z.array(previewRowSchema),
});
export type PreviewResponse = z.infer<typeof previewResponseSchema>;

// ---------------------------------------------------------------------------
// PUT /api/config/phase
// ---------------------------------------------------------------------------

export const saveConfigRequestSchema = z.object({
  projectKey: z.string().min(1).nullable(),
  payload: configPayloadSchema,
  /** Lý do sửa. Hiện ở màn hình lịch sử version để người sau hiểu được. */
  note: z.string().max(500).nullable().default(null),
});
export type SaveConfigRequest = z.infer<typeof saveConfigRequestSchema>;

export const saveConfigResponseSchema = z.object({
  version: z.number().int(),
  affectedEpics: z.number().int(),
  estimatedRecomputeSeconds: z.number().int(),
});
export type SaveConfigResponse = z.infer<typeof saveConfigResponseSchema>;

/** Thân phản hồi khi cấu hình không hợp lệ (HTTP 400). */
export const validationErrorResponseSchema = z.object({
  error: z.literal('CONFIG_INVALID'),
  message: z.string(),
  issues: z.array(
    z.object({
      level: z.enum(['ERROR', 'WARNING']),
      code: z.string(),
      message: z.string(),
      /** Đường dẫn tới đúng trường gây lỗi, để UI neo thông báo. */
      path: z.string().optional(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// GET /api/config/phase
// ---------------------------------------------------------------------------

/**
 * Cấu hình đang hiệu lực, đã gộp kế thừa.
 *
 * Khai bằng zod (chứ không chỉ bằng `interface EffectiveConfig`) vì frontend
 * phải KIỂM dữ liệu này tại biên. Nhất là `inherited`: thiếu nó thì màn hình
 * cấu hình mất sạch nhãn "kế thừa từ Mặc định" mà không có lỗi nào báo ra.
 */
export const inheritFlagsSchema = z.object({
  titlePatterns: z.boolean(),
  subtaskPatterns: z.boolean(),
  phaseDefinitions: z.boolean(),
  matchRules: z.boolean(),
  signboardColumns: z.boolean(),
});
export type InheritFlags = z.infer<typeof inheritFlagsSchema>;

/** Tên các phần có thể ghi đè theo project. Dùng chung cho UI và cho kiểm tra. */
export const INHERITABLE_PARTS = [
  'titlePatterns',
  'subtaskPatterns',
  'phaseDefinitions',
  'matchRules',
  'signboardColumns',
] as const;
export type InheritablePartKey = (typeof INHERITABLE_PARTS)[number];

export const effectiveConfigSchema = configPayloadSchema.extend({
  projectKey: z.string().nullable(),
  globalVersion: z.number().int(),
  projectVersion: z.number().int().nullable(),
  inherited: inheritFlagsSchema,
});
export type EffectiveConfigResponse = z.infer<typeof effectiveConfigSchema>;

// ---------------------------------------------------------------------------
// GET /api/config/phase/versions
// ---------------------------------------------------------------------------

export const configVersionSchema = z.object({
  version: z.number().int(),
  isActive: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  note: z.string().nullable(),
});
export type ConfigVersion = z.infer<typeof configVersionSchema>;

/** Route bọc danh sách trong một object để sau này thêm trường mà không vỡ. */
export const versionsResponseSchema = z.object({ versions: z.array(configVersionSchema) });

// ---------------------------------------------------------------------------
// GET /api/config/phase/unmatched
// ---------------------------------------------------------------------------

export const unmatchedLabelSchema = z.object({
  /** Chuỗi bóc được từ tiêu đề nhưng không luật nào khớp. `null` = không bóc được. */
  rawPhaseLabel: z.string().nullable(),
  count: z.number().int(),
  /** Vài key ví dụ để PM bấm sang Jira xem. */
  sampleTaskKeys: z.array(z.string()),
});
export type UnmatchedLabel = z.infer<typeof unmatchedLabelSchema>;

export const unmatchedResponseSchema = z.object({ labels: z.array(unmatchedLabelSchema) });

// ---------------------------------------------------------------------------
// Phân quyền
// ---------------------------------------------------------------------------

export const USER_ROLE = ['ADMIN', 'PM', 'VIEWER'] as const;
export type UserRole = (typeof USER_ROLE)[number];

export interface Principal {
  readonly userId: string;
  readonly role: UserRole;
  /** Các project user này phụ trách. Chỉ có nghĩa với role `PM`. */
  readonly projects: readonly string[];
}

// ---------------------------------------------------------------------------
// GET /api/me — người dùng đang đăng nhập
// ---------------------------------------------------------------------------

/**
 * Ai đang đăng nhập, để frontend hiện tên và ẩn/hiện nút theo vai trò.
 *
 * Đây CHỈ để phục vụ giao diện; API vẫn tự kiểm quyền ở mỗi endpoint ghi —
 * ẩn nút không phải là hàng rào bảo mật, chỉ đỡ cho người dùng bấm vào thứ
 * chắc chắn bị từ chối.
 */
export const meResponseSchema = z.object({
  userId: z.string(),
  role: z.enum(USER_ROLE),
  projects: z.array(z.string()),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// ---------------------------------------------------------------------------
// Quản lý người dùng — /api/users (chỉ ADMIN)
// ---------------------------------------------------------------------------

/**
 * Người dùng đến từ đâu:
 *   DB  — cấp trong bảng `app_user`, sửa/xoá được ở đây.
 *   ENV — admin mồi qua biến môi trường `AUTH_BOOTSTRAP_ADMINS`, CHỈ ĐỌC (đổi ở
 *         env, không đổi ở màn hình — nếu không sẽ hiểu nhầm là đã hạ quyền).
 */
export const APP_USER_SOURCE = ['DB', 'ENV'] as const;
export type AppUserSource = (typeof APP_USER_SOURCE)[number];

export const appUserSchema = z.object({
  userId: z.string(),
  role: z.enum(USER_ROLE),
  projects: z.array(z.string()),
  displayName: z.string().nullable(),
  source: z.enum(APP_USER_SOURCE),
});
export type AppUserView = z.infer<typeof appUserSchema>;

export const listUsersResponseSchema = z.object({ users: z.array(appUserSchema) });
export type ListUsersResponse = z.infer<typeof listUsersResponseSchema>;

/**
 * Cấp / cập nhật một người dùng. `userId` là email (server tự hạ chữ thường).
 * `projects` chỉ có nghĩa với PM — server từ chối nếu gán cho ADMIN/VIEWER.
 */
export const upsertUserRequestSchema = z.object({
  userId: z.string().trim().min(1),
  role: z.enum(USER_ROLE),
  projects: z.array(z.string().trim().min(1)).default([]),
  displayName: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .default(null),
});
export type UpsertUserRequest = z.infer<typeof upsertUserRequestSchema>;

// ---------------------------------------------------------------------------
// Danh mục Project — /api/projects (chỉ ADMIN)
// ---------------------------------------------------------------------------

/**
 * Key project theo chuẩn Jira: chữ HOA, bắt đầu bằng chữ cái. Chuẩn hoá (trim +
 * viết hoa) nằm ở server; schema này chốt định dạng để chặn key rác.
 */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

export const projectSchema = z.object({
  projectKey: z.string(),
  displayName: z.string().nullable(),
  /** Số PM đang được gán vào project này (một project có thể nhiều PM). */
  pmCount: z.number().int().nonnegative(),
});
export type ProjectView = z.infer<typeof projectSchema>;

export const listProjectsResponseSchema = z.object({ projects: z.array(projectSchema) });
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;

export const upsertProjectRequestSchema = z.object({
  projectKey: z.string().trim().min(1),
  displayName: z.string().trim().min(1).nullable().default(null),
});
export type UpsertProjectRequest = z.infer<typeof upsertProjectRequestSchema>;
