import { z } from 'zod';

/**
 * Hierarchy Profile — mô tả CÂY THẬT của dự án ánh xạ vào ba VAI trừu tượng
 * (docs/FLEXIBLE-HIERARCHY-PROPOSAL.md).
 *
 *   ROOT  — đơn vị theo dõi: 1 dòng `tracked_epic`, 1 burndown, 1 signboard
 *   GROUP — tầng trung gian mang thông tin Phase (0..n tầng)
 *   LEAF  — đơn vị công việc: estimate, worklog, ngày WBS — nguồn của mọi con số
 *
 * Engine (snapshot/signboard/rollup) chỉ làm việc trên ticket LEAF nhóm theo
 * `phaseCode`, nên profile chỉ cần trả lời hai câu hỏi: cây sâu bao nhiêu tầng,
 * và `phase_code` / hàng / cột Signboard lấy từ đâu. Từ chỗ dữ liệu đổ về các
 * cột quen thuộc (`phase_code`, `function_key`, `task_type`) trở đi, KHÔNG có
 * gì thay đổi theo dạng dự án nữa.
 */

// ---------------------------------------------------------------------------
// Vai của một tầng. Suy được từ vị trí (đầu = ROOT, cuối = LEAF, giữa = GROUP)
// nhưng vẫn ghi tường minh trong config để người đọc không phải nhớ quy ước —
// validator kiểm tra hai chiều khớp nhau.
// ---------------------------------------------------------------------------
export const HIERARCHY_ROLE = ['ROOT', 'GROUP', 'LEAF'] as const;
export type HierarchyRole = (typeof HIERARCHY_ROLE)[number];

/**
 * Nguồn của `phase_code` — chỗ linh hoạt quan trọng nhất giữa các dạng dự án.
 *
 *   GROUP_TITLE     — bóc từ tiêu đề tầng GROUP (hành vi 3 tầng hiện tại)
 *   SELF_TITLE_SLOT — bóc từ chính tiêu đề LEAF (ô `{phase}` của mẫu Sub-task),
 *                     rồi vẫn đi qua luật khớp từ khoá để chuẩn hoá về mã Phase
 *   FIELD           — đọc từ một field Jira của LEAF (labels/components/custom
 *                     field), rồi đi qua luật khớp từ khoá
 *   FIXED           — cả ROOT là MỘT phase duy nhất (dự án không chia phase)
 */
export const PHASE_SOURCE_TYPE = ['GROUP_TITLE', 'SELF_TITLE_SLOT', 'FIELD', 'FIXED'] as const;
export type PhaseSourceType = (typeof PHASE_SOURCE_TYPE)[number];

/** Nguồn của hàng (function) / cột (task type) Signboard. */
export const SB_DIMENSION_SOURCE = ['TITLE_SLOT', 'FIELD'] as const;
export type SbDimensionSource = (typeof SB_DIMENSION_SOURCE)[number];

/** Các ô giữ chỗ hợp lệ của mẫu tiêu đề Sub-task — khớp `compile-pattern`. */
export const TITLE_SLOTS = ['project', 'team', 'phase', 'function', 'task'] as const;
export type TitleSlot = (typeof TITLE_SLOTS)[number];

/** Trần độ sâu. 5 tầng đã là Initiative→Epic→Story→Task→Sub-task; sâu hơn là cấu hình sai. */
export const MAX_HIERARCHY_LEVELS = 5;

// ---------------------------------------------------------------------------
// Zod schema — đây là dạng PM lưu qua API, nên thông báo lỗi phải nói được
// "sửa ô nào" chứ không chỉ "sai".
// ---------------------------------------------------------------------------

export const hierarchyLevelSchema = z.object({
  role: z.enum(HIERARCHY_ROLE),
  /**
   * Lọc TUỲ CHỌN theo tên issue type Jira (so sánh không phân biệt hoa thường).
   * Bỏ trống = nhận mọi issue nằm đúng vị trí trong cây. Vai được định nghĩa
   * theo QUAN HỆ cha–con chứ không theo tên type — tên khác nhau ở mỗi Jira.
   */
  issueTypes: z.array(z.string().min(1)).optional(),
});

export const phaseSourceSchema = z.object({
  type: z.enum(PHASE_SOURCE_TYPE),
  /**
   * Nghĩa phụ thuộc `type`:
   *   SELF_TITLE_SLOT → tên ô trong mẫu tiêu đề (mặc định 'phase')
   *   FIELD           → tên/id field Jira ('labels', 'components', 'customfield_10123')
   *   FIXED           → mã Phase
   *   GROUP_TITLE     → không dùng
   */
  ref: z.string().min(1).max(64).nullable().optional(),
  /**
   * CHỈ với GROUP_TITLE ở cây ≥ 4 tầng: index (0-based trong `levels`) của tầng
   * GROUP mang thông tin Phase. Mặc định 1 — tầng ngay dưới ROOT, đúng hành vi
   * 3 tầng hiện tại. Tầng GROUP sâu hơn kế thừa phase của cha nó.
   */
  groupLevel: z.number().int().min(1).optional(),
});

export const sbDimensionSchema = z.object({
  source: z.enum(SB_DIMENSION_SOURCE),
  /** TITLE_SLOT → tên ô của mẫu; FIELD → tên/id field Jira. */
  ref: z.string().min(1).max(64),
});

export const hierarchyProfileSchema = z.object({
  levels: z.array(hierarchyLevelSchema).min(2).max(MAX_HIERARCHY_LEVELS),
  phaseSource: phaseSourceSchema,
  signboard: z.object({
    row: sbDimensionSchema,
    column: sbDimensionSchema,
  }),
});

export type HierarchyLevel = z.infer<typeof hierarchyLevelSchema>;
export type PhaseSource = z.infer<typeof phaseSourceSchema>;
export type SbDimension = z.infer<typeof sbDimensionSchema>;
export type HierarchyProfile = z.infer<typeof hierarchyProfileSchema>;

// ---------------------------------------------------------------------------
// Profile mặc định = hành vi 3 tầng Epic → Task (Phase) → Sub-task hiện tại.
//
// KHÔNG có profile trong cấu hình ⇒ dùng bộ này — nhờ vậy mọi dữ liệu và cấu
// hình có sẵn chạy y nguyên, seed không phải chèn thêm dòng nào, và SQL seed
// thuần (tools/db) cũng không phải đổi.
// ---------------------------------------------------------------------------
export const DEFAULT_HIERARCHY_PROFILE: HierarchyProfile = {
  levels: [
    // Chỉ ROOT khai issueTypes: giữ đúng luật "key dán vào phải là Epic" của
    // màn đăng ký hiện tại. Hai tầng dưới nhận theo vị trí trong cây.
    { role: 'ROOT', issueTypes: ['EPIC'] },
    { role: 'GROUP' },
    { role: 'LEAF' },
  ],
  phaseSource: { type: 'GROUP_TITLE' },
  signboard: {
    row: { source: 'TITLE_SLOT', ref: 'function' },
    column: { source: 'TITLE_SLOT', ref: 'task' },
  },
};

/** Profile hiệu lực: cái được khai, hoặc bộ mặc định 3 tầng. */
export function resolveHierarchyProfile(
  profile: HierarchyProfile | null | undefined,
): HierarchyProfile {
  return profile ?? DEFAULT_HIERARCHY_PROFILE;
}

/** Index của tầng LEAF (= độ sâu cây − 1). */
export function leafLevelIndex(profile: HierarchyProfile): number {
  return profile.levels.length - 1;
}

/**
 * Index tầng GROUP mang Phase khi `phaseSource.type === 'GROUP_TITLE'`.
 * `null` khi cây không có tầng GROUP nào (2 tầng) — validator đã chặn ca này
 * từ lúc lưu, nhưng đường chạy vẫn phải tự vệ.
 */
export function phaseCarrierLevelIndex(profile: HierarchyProfile): number | null {
  if (profile.levels.length < 3) return null;
  const idx = profile.phaseSource.groupLevel ?? 1;
  return idx >= 1 && idx <= profile.levels.length - 2 ? idx : 1;
}

/**
 * Vai của tầng thứ `levelIndex` (0-based). Nguồn sự thật là VỊ TRÍ, không phải
 * trường `role` PM gõ — validator bắt hai bên khớp nhau lúc lưu.
 */
export function roleOfLevel(profile: HierarchyProfile, levelIndex: number): HierarchyRole {
  if (levelIndex === 0) return 'ROOT';
  if (levelIndex >= leafLevelIndex(profile)) return 'LEAF';
  return 'GROUP';
}

/**
 * Issue type Jira (đã chuẩn hoá) có được nhận vào tầng này không.
 * So sánh không phân biệt hoa thường; danh sách trống/vắng = nhận tất cả.
 */
export function levelAcceptsIssueType(level: HierarchyLevel, issueTypeName: string): boolean {
  const allowed = level.issueTypes;
  if (!allowed || allowed.length === 0) return true;
  const needle = issueTypeName.trim().toLowerCase();
  return allowed.some((t) => t.trim().toLowerCase() === needle);
}
