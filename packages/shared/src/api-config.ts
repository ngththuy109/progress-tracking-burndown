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
  subPhaseOrders: z.boolean(),
});
export type InheritFlags = z.infer<typeof inheritFlagsSchema>;

/** Tên các phần có thể ghi đè theo project. Dùng chung cho UI và cho kiểm tra. */
export const INHERITABLE_PARTS = [
  'titlePatterns',
  'subtaskPatterns',
  'phaseDefinitions',
  'matchRules',
  'signboardColumns',
  'subPhaseOrders',
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

/**
 * Mô hình phân quyền multi-tenant (2 tầng):
 *
 *   - Role TOÀN CỤC (`app_user.role`): ADMIN — thấy/quản mọi dự án, quản trị
 *     hệ thống; MEMBER — chỉ thấy dự án mình là thành viên.
 *   - Role TRONG DỰ ÁN (`project_member.role`): PM — cấu hình + thao tác ghi
 *     trong dự án đó; VIEWER — chỉ xem dự án đó.
 *
 * Một người có thể là PM dự án A đồng thời VIEWER dự án B. PM/VIEWER toàn cục
 * kiểu cũ đã chuyển thành membership per-project (migration 20260812000000).
 */
export const GLOBAL_ROLE = ['ADMIN', 'MEMBER'] as const;
export type GlobalRole = (typeof GLOBAL_ROLE)[number];

export const PROJECT_ROLE = ['PM', 'VIEWER'] as const;
export type ProjectRole = (typeof PROJECT_ROLE)[number];

export interface Principal {
  readonly userId: string;
  /** ADMIN toàn cục — vượt mọi kiểm tra membership. */
  readonly isAdmin: boolean;
  /** projectKey → role trong dự án đó. Rỗng với người chưa được cấp quyền. */
  readonly memberships: Readonly<Record<string, ProjectRole>>;
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
/** Một dự án user truy cập được — nguồn dữ liệu cho project switcher. */
export const meProjectSchema = z.object({
  projectKey: z.string(),
  displayName: z.string().nullable(),
  /** Role hiệu dụng trong dự án. ADMIN toàn cục nhận 'PM' (toàn quyền). */
  role: z.enum(PROJECT_ROLE),
});
export type MeProject = z.infer<typeof meProjectSchema>;

export const meResponseSchema = z.object({
  userId: z.string(),
  isAdmin: z.boolean(),
  /** ADMIN: mọi dự án chưa ARCHIVED. MEMBER: các dự án có membership. */
  projects: z.array(meProjectSchema),
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
  role: z.enum(GLOBAL_ROLE),
  displayName: z.string().nullable(),
  source: z.enum(APP_USER_SOURCE),
  /** Số dự án user này là thành viên — để màn hình quản trị nhìn nhanh. */
  membershipCount: z.number().int().nonnegative(),
});
export type AppUserView = z.infer<typeof appUserSchema>;

export const listUsersResponseSchema = z.object({ users: z.array(appUserSchema) });
export type ListUsersResponse = z.infer<typeof listUsersResponseSchema>;

/**
 * Cấp / cập nhật một người dùng. `userId` là email (server tự hạ chữ thường).
 * Membership theo dự án quản ở /api/admin/projects/:projectKey/members —
 * KHÔNG quản ở đây.
 */
export const upsertUserRequestSchema = z.object({
  userId: z.string().trim().min(1),
  role: z.enum(GLOBAL_ROLE),
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

export const PROJECT_STATUS = ['ACTIVE', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUS)[number];

/** Số tầng dưới tracked root: 1..4 (2 = Epic/Task/Subtask cổ điển). */
export const HIERARCHY_DEPTH_MIN = 1;
export const HIERARCHY_DEPTH_MAX = 4;

/**
 * Project = TENANT. Token Jira KHÔNG BAO GIỜ xuất hiện ở đây — API chỉ trả
 * `hasJiraToken` để UI biết đã nhập hay chưa (token là write-only).
 */
export const projectSchema = z.object({
  projectKey: z.string(),
  displayName: z.string().nullable(),
  status: z.enum(PROJECT_STATUS),
  jiraBaseUrl: z.string().nullable(),
  jiraEmail: z.string().nullable(),
  /** true = đã nhập token riêng; false = đang fallback env JIRA_*. */
  hasJiraToken: z.boolean(),
  hierarchyDepth: z.number().int().min(HIERARCHY_DEPTH_MIN).max(HIERARCHY_DEPTH_MAX),
  timezone: z.string(),
  defaultCalendarId: z.string().nullable(),
  /** Số thành viên (mọi role) — để màn hình quản trị nhìn nhanh. */
  memberCount: z.number().int().nonnegative(),
});
export type ProjectView = z.infer<typeof projectSchema>;

export const listProjectsResponseSchema = z.object({ projects: z.array(projectSchema) });
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;

export const upsertProjectRequestSchema = z.object({
  projectKey: z.string().trim().min(1),
  displayName: z.string().trim().min(1).nullable().default(null),
  status: z.enum(PROJECT_STATUS).default('ACTIVE'),
  hierarchyDepth: z
    .number()
    .int()
    .min(HIERARCHY_DEPTH_MIN)
    .max(HIERARCHY_DEPTH_MAX)
    .default(2),
  timezone: z.string().trim().min(1).default('Asia/Ho_Chi_Minh'),
  defaultCalendarId: z.string().trim().min(1).nullable().default(null),
});
export type UpsertProjectRequest = z.infer<typeof upsertProjectRequestSchema>;

// ---------------------------------------------------------------------------
// Kết nối Jira của tenant — PUT /api/admin/projects/:projectKey/jira
// ---------------------------------------------------------------------------

/**
 * Cập nhật kết nối Jira. `apiToken`:
 *   - chuỗi có nội dung → mã hóa rồi lưu;
 *   - `null`            → XÓA token đã lưu (quay về fallback env);
 *   - không gửi trường  → GIỮ NGUYÊN token cũ (đổi URL/email không phải nhập lại).
 * `fieldsConfig` cùng shape với config/jira-fields.yaml (zod kiểm ở server).
 */
export const updateProjectJiraRequestSchema = z.object({
  jiraBaseUrl: z.string().trim().url().nullable().default(null),
  jiraEmail: z.string().trim().email().nullable().default(null),
  apiToken: z.string().trim().min(1).nullable().optional(),
  fieldsConfig: z.unknown().nullable().default(null),
});
export type UpdateProjectJiraRequest = z.infer<typeof updateProjectJiraRequestSchema>;

/** Kết quả từng bước của "Test connection" — hiển thị nguyên trạng trên UI. */
export const jiraTestStepSchema = z.object({
  step: z.enum(['AUTH', 'FIELDS', 'PROJECT_ACCESS']),
  ok: z.boolean(),
  detail: z.string(),
});
export const jiraTestResponseSchema = z.object({
  ok: z.boolean(),
  steps: z.array(jiraTestStepSchema),
});
export type JiraTestResponse = z.infer<typeof jiraTestResponseSchema>;

// ---------------------------------------------------------------------------
// Thành viên dự án — /api/admin/projects/:projectKey/members
// ---------------------------------------------------------------------------

export const projectMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(PROJECT_ROLE),
  displayName: z.string().nullable(),
  addedBy: z.string(),
  addedAt: z.string(),
});
export type ProjectMemberView = z.infer<typeof projectMemberSchema>;

export const listMembersResponseSchema = z.object({ members: z.array(projectMemberSchema) });
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;

export const upsertMemberRequestSchema = z.object({
  userId: z.string().trim().min(1),
  role: z.enum(PROJECT_ROLE),
});
export type UpsertMemberRequest = z.infer<typeof upsertMemberRequestSchema>;

