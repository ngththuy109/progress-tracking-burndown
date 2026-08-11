import { z } from 'zod';
import { CONFIG_SCOPE, MATCH_MODE } from './enums.js';
import { WORK_SIDE } from './api-calendar.js';

/**
 * Cấu hình nhận diện Phase — PRD §2.2.
 *
 * NGUYÊN TẮC GỐC: toàn bộ quy tắc nhận diện Phase đều là cấu hình, không có gì
 * viết cứng trong mã nguồn. PM tự sửa qua màn hình quản trị, không cần dev và
 * không cần deploy. Đây là thứ làm giảm rủi ro R-01 (dữ liệu Jira không sạch,
 * khả năng Cao).
 */

/** Tầng 1 — mẫu tiêu đề Task, ví dụ `[Phase] {name}`. */
export const titlePatternSchema = z.object({
  patternText: z.string().min(1, 'Pattern text cannot be empty.'),
  sortOrder: z.number().int(),
});

/** Mẫu tiêu đề Sub-task, ví dụ `[{project}][{team}][{phase}][{function}]_{task}`. */
export const subtaskPatternSchema = titlePatternSchema;

/** Định nghĩa một Phase chuẩn. */
export const phaseDefinitionSchema = z.object({
  phaseCode: z.string().min(1, 'Phase code is required.').max(24, 'Phase code is at most 24 characters.'),
  labelVi: z.string().min(1, 'Phase name is required.'),
  labelJa: z.string().nullable().optional(),
  colorHex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable()
    .optional(),
  /** Thứ tự HIỂN THỊ trên biểu đồ. KHÁC `matchPriority`. */
  displayOrder: z.number().int(),
});

/** Tầng 2 — luật khớp từ khoá sang Phase. */
export const matchRuleSchema = z.object({
  keyword: z.string().min(1, 'Keyword is required.'),
  matchMode: z.enum(MATCH_MODE).default('CONTAINS'),
  phaseCode: z.string().min(1, 'Pick the target Phase for this rule.').max(24, 'Phase code is at most 24 characters.'),
  /** Thứ tự ƯU TIÊN KHI KHỚP, số nhỏ thắng. KHÁC `displayOrder`. */
  matchPriority: z.number().int().default(50),
});

/** Một cột của bảng Signboard. Khớp CHÍNH XÁC, không phải từ khoá. */
export const signboardColumnSchema = z.object({
  taskCode: z.string().min(1, 'Column code is required.').max(32, 'Column code is at most 32 characters.'),
  labelVi: z.string().min(1, 'Column name is required.'),
  labelJa: z.string().nullable().optional(),
  /**
   * Phía làm loại task này — VN (người làm) hay JP (khách hàng review), T-37.
   * `default('VN')` để payload cũ (trước khi có trường này) vẫn parse được.
   */
  side: z.enum(WORK_SIDE).default('VN'),
  displayOrder: z.number().int(),
});

/** Nội dung một bộ cấu hình, không kèm metadata version. */
export const configPayloadSchema = z.object({
  fallbackScanFullTitle: z.boolean().default(true),
  titlePatterns: z.array(titlePatternSchema),
  subtaskPatterns: z.array(subtaskPatternSchema),
  phaseDefinitions: z.array(phaseDefinitionSchema),
  matchRules: z.array(matchRuleSchema),
  signboardColumns: z.array(signboardColumnSchema),
});

export type TitlePattern = z.infer<typeof titlePatternSchema>;
export type PhaseDefinition = z.infer<typeof phaseDefinitionSchema>;
export type MatchRule = z.infer<typeof matchRuleSchema>;
export type SignboardColumn = z.infer<typeof signboardColumnSchema>;
export type ConfigPayload = z.infer<typeof configPayloadSchema>;

/**
 * Bộ cấu hình RỖNG — điểm xuất phát khi CHƯA có gì được cấu hình.
 *
 * Dùng khi database chưa seed bộ Mặc định: màn hình **Phase settings** và
 * **Signboard columns** vẫn mở bình thường với bộ rỗng này để admin tự định
 * nghĩa Phase và cột Signboard rồi Lưu (tạo GLOBAL v1) — không bắt phải chạy
 * seed trước. `fallbackScanFullTitle` bật sẵn vì đó là mặc định an toàn nhất.
 */
export const EMPTY_CONFIG_PAYLOAD: ConfigPayload = {
  fallbackScanFullTitle: true,
  titlePatterns: [],
  subtaskPatterns: [],
  phaseDefinitions: [],
  matchRules: [],
  signboardColumns: [],
};

export interface ConfigSetMeta {
  readonly id: number;
  readonly scope: (typeof CONFIG_SCOPE)[number];
  readonly projectKey: string | null;
  readonly version: number;
  readonly isActive: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly note: string | null;
}

export type ConfigSet = ConfigSetMeta & ConfigPayload;

/**
 * Ba phần kế thừa ĐỘC LẬP NHAU (PRD §2.2.6).
 *
 * Project ghi đè mẫu tiêu đề thì danh sách Phase và luật khớp VẪN kế thừa từ bộ
 * Mặc định. Làm kiểu "tất cả hoặc không có gì" là sai: project chỉ muốn đổi mẫu
 * tiêu đề sẽ mất sạch danh sách Phase — cấu hình vẫn lưu được nhưng mọi Task rơi
 * vào UNCLASSIFIED, và đó là lỗi im lặng.
 */
export type InheritablePart = 'titlePatterns' | 'phaseDefinitions' | 'matchRules';

/** Cấu hình đang hiệu lực, đã gộp kế thừa, kèm cờ để UI hiện nhãn. */
export interface EffectiveConfig extends ConfigPayload {
  readonly projectKey: string | null;
  readonly globalVersion: number;
  readonly projectVersion: number | null;
  /** true = phần đó lấy từ bộ Mặc định, chưa được project ghi đè. */
  readonly inherited: Readonly<Record<InheritablePart | 'signboardColumns' | 'subtaskPatterns', boolean>>;
}

/** Kết quả kiểm tra hợp lệ khi lưu — PRD §2.2.4. */
export interface ValidationIssue {
  readonly level: 'ERROR' | 'WARNING';
  readonly code: string;
  readonly message: string;
  /** Đường dẫn tới trường gây lỗi, để UI neo thông báo đúng chỗ. */
  readonly path?: string;
}
