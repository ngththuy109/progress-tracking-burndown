import { z } from 'zod';
import { GROUP_SOURCE_TYPE, GROUP_TIER_ROLE, MATCH_MODE } from './enums.js';

/**
 * Cấu hình phân tầng linh động N tầng — DYNAMIC-TIERS-DESIGN.md.
 *
 * Tổng quát hoá bộ phase_* (một tầng "Phase" cố định) thành một DANH SÁCH CÓ THỨ
 * TỰ 1..N tầng nhóm logic. Mỗi lá mang một vectơ khoá theo tầng (jira_issue.group_path).
 *
 * Ở Vòng 1 các bảng group_tier* được SINH MIRROR từ phase_* (deriveDefaultTiersFromPhase)
 * nên hành vi không đổi; Vòng 2 engine mới chuyển sang đọc chúng.
 */

/** Giá trị chuẩn của một tầng — tổng quát `phaseDefinition` cho mọi tầng. */
export const groupTierDefinitionSchema = z.object({
  groupCode: z.string().min(1, 'Group code is required.').max(64, 'Group code is at most 64 characters.'),
  labelVi: z.string().min(1, 'Name is required.'),
  labelJa: z.string().nullable().optional(),
  colorHex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable()
    .optional(),
  displayOrder: z.number().int(),
});

/** Luật khớp từ khoá → mã tầng — tổng quát `phaseMatchRule`. */
export const groupTierRuleSchema = z.object({
  keyword: z.string().min(1, 'Keyword is required.'),
  matchMode: z.enum(MATCH_MODE).default('CONTAINS'),
  groupCode: z.string().min(1, 'Pick the target value for this rule.').max(64),
  matchPriority: z.number().int().default(50),
});

/** Mẫu tiêu đề của một tầng — tổng quát `phaseTitlePattern` (chỉ tầng dựa trên title). */
export const groupTierTitlePatternSchema = z.object({
  patternText: z.string().min(1, 'Pattern text cannot be empty.'),
  sortOrder: z.number().int(),
});

/** Định nghĩa MỘT tầng nhóm. */
export const groupTierSchema = z.object({
  /** 1 = tầng trên cùng (ngay dưới gốc), tăng dần xuống lá. */
  tierOrder: z.number().int(),
  code: z.string().min(1, 'Tier code is required.').max(32, 'Tier code is at most 32 characters.'),
  labelVi: z.string().min(1, 'Tier name is required.'),
  labelJa: z.string().nullable().optional(),
  role: z.enum(GROUP_TIER_ROLE),
  sourceType: z.enum(GROUP_SOURCE_TYPE),
  /** Tham số của source (tên token, tiền tố label, mã field…). Để JSON cho linh hoạt. */
  sourceConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  definitions: z.array(groupTierDefinitionSchema).default([]),
  rules: z.array(groupTierRuleSchema).default([]),
  titlePatterns: z.array(groupTierTitlePatternSchema).default([]),
  displayOrder: z.number().int(),
});

export type GroupTierDefinition = z.infer<typeof groupTierDefinitionSchema>;
export type GroupTierRule = z.infer<typeof groupTierRuleSchema>;
export type GroupTierTitlePattern = z.infer<typeof groupTierTitlePatternSchema>;
export type GroupTier = z.infer<typeof groupTierSchema>;

/** Mã tầng Phase cố định — dùng khi sinh mirror từ phase config. */
export const PHASE_TIER_CODE = 'PHASE' as const;

// ---------------------------------------------------------------------------
// Xem thử cấu trúc tầng: dán MỘT tiêu đề Task → từng tầng bóc ra mã gì
// ---------------------------------------------------------------------------

/** Thân `POST /api/config/phase/tiers-preview` — tiers là BẢN NHÁP đang sửa, chưa lưu. */
export const tiersPreviewRequestSchema = z.object({
  taskTitle: z.string().min(1, 'Enter a Task title to preview.'),
  tiers: z.array(groupTierSchema),
});

/** Kết quả của MỘT tầng. `resolved: null` = nguồn không bóc được từ tiêu đề Task (cần dữ liệu lá). */
export const tierPreviewEntrySchema = z.object({
  code: z.string(),
  labelVi: z.string(),
  sourceType: z.enum(GROUP_SOURCE_TYPE),
  resolved: z.string().nullable(),
});

export const tiersPreviewResponseSchema = z.object({
  /** Phase theo cấu hình Phase đang hiệu lực — đúng thứ Sub-task sẽ kế thừa. */
  parentPhase: z.string(),
  /** Theo thứ tự tầng. */
  entries: z.array(tierPreviewEntrySchema),
});

export type TiersPreviewRequest = z.infer<typeof tiersPreviewRequestSchema>;
export type TierPreviewEntry = z.infer<typeof tierPreviewEntrySchema>;
export type TiersPreviewResponse = z.infer<typeof tiersPreviewResponseSchema>;

/**
 * Sinh MIRROR "một tầng Phase" từ phần cấu hình phase_* — cầu nối Vòng 1.
 *
 * Mô hình 3 tầng hôm nay = cấu hình có ĐÚNG một tầng nhóm (role=PHASE,
 * source=PARENT_TASK_TITLE). Hàm THUẦN: dùng cho repository (mirror lúc lưu),
 * backfill dữ liệu cũ, và seed mặc định — để ba nơi luôn nhất quán.
 */
export function deriveDefaultTiersFromPhase(payload: {
  readonly titlePatterns: readonly { readonly patternText: string; readonly sortOrder: number }[];
  readonly phaseDefinitions: readonly {
    readonly phaseCode: string;
    readonly labelVi: string;
    readonly labelJa?: string | null | undefined;
    readonly colorHex?: string | null | undefined;
    readonly displayOrder: number;
  }[];
  readonly matchRules: readonly {
    readonly keyword: string;
    readonly matchMode: 'CONTAINS' | 'REGEX';
    readonly phaseCode: string;
    readonly matchPriority: number;
  }[];
}): GroupTier[] {
  return [
    {
      tierOrder: 1,
      code: PHASE_TIER_CODE,
      labelVi: 'Phase',
      labelJa: null,
      role: 'PHASE',
      sourceType: 'PARENT_TASK_TITLE',
      sourceConfig: null,
      definitions: payload.phaseDefinitions.map((p) => ({
        groupCode: p.phaseCode,
        labelVi: p.labelVi,
        labelJa: p.labelJa ?? null,
        colorHex: p.colorHex ?? null,
        displayOrder: p.displayOrder,
      })),
      rules: payload.matchRules.map((r) => ({
        keyword: r.keyword,
        matchMode: r.matchMode,
        groupCode: r.phaseCode,
        matchPriority: r.matchPriority,
      })),
      titlePatterns: payload.titlePatterns.map((t) => ({
        patternText: t.patternText,
        sortOrder: t.sortOrder,
      })),
      displayOrder: 0,
    },
  ];
}
