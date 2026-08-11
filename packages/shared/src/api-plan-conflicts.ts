/**
 * Hợp đồng HTTP của API kiểm tra plan rơi vào ngày nghỉ — T-37.
 *
 * Bối cảnh nghiệp vụ: mỗi task do người VN làm và người JP review. Loại task
 * (cột Signboard) mang cờ `side` cho biết task thuộc phía nào, từ đó ngày kế
 * hoạch của Sub-task được kiểm tra với lịch của đúng phía đó.
 *
 * CHỈ soi ngày BẮT ĐẦU và ngày KẾT THÚC kế hoạch. Khoảng plan vắt qua ngày nghỉ
 * (thứ 4 tuần này → thứ 3 tuần sau) là bình thường — đường Kế hoạch đã tự loại
 * các ngày đó khi chia (T-16). Vi phạm là khi chính mốc start/end rơi trúng
 * ngày không làm việc: không ai bắt đầu hay kết thúc công việc vào ngày nghỉ.
 */
import { z } from 'zod';
import { DATE_ONLY_PATTERN } from './calendar.js';
import { WORK_SIDE } from './api-calendar.js';

/** Mốc nào của khoảng kế hoạch vi phạm. */
export const CONFLICT_FIELD = ['START', 'END'] as const;
export type ConflictField = (typeof CONFLICT_FIELD)[number];

/** Vì sao ngày đó không phải ngày làm việc. */
export const CONFLICT_REASON = ['WEEKEND', 'HOLIDAY'] as const;
export type ConflictReason = (typeof CONFLICT_REASON)[number];

export const planConflictViolationSchema = z.object({
  field: z.enum(CONFLICT_FIELD),
  date: z.string().regex(DATE_ONLY_PATTERN),
  reason: z.enum(CONFLICT_REASON),
  /** Tên ngày lễ nếu có khai — để PM hiểu ngay "à, đó là Tết". */
  holidayLabel: z.string().nullable(),
});
export type PlanConflictViolation = z.infer<typeof planConflictViolationSchema>;

export const planConflictSchema = z.object({
  issueKey: z.string(),
  summary: z.string(),
  parentKey: z.string().nullable(),
  phaseCode: z.string().nullable(),
  /** Loại task khớp cột Signboard. `null` = tiêu đề không khớp cột nào. */
  taskType: z.string().nullable(),
  side: z.enum(WORK_SIDE),
  /**
   * `false` = không tra được phía làm (taskType null hoặc cột không còn trong
   * cấu hình) nên đã kiểm tra theo lịch VN mặc định. Nói rõ ra thay vì bỏ qua
   * trong im lặng (C-10).
   */
  sideResolved: z.boolean(),
  violations: z.array(planConflictViolationSchema).min(1),
});
export type PlanConflict = z.infer<typeof planConflictSchema>;

export const planConflictsResponseSchema = z.object({
  epicKey: z.string(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    bySide: z.object({
      VN: z.number().int().nonnegative(),
      JP: z.number().int().nonnegative(),
    }),
    /** Số Sub-task phải kiểm theo lịch VN mặc định vì không rõ phía làm. */
    sideUnknownCount: z.number().int().nonnegative(),
  }),
  conflicts: z.array(planConflictSchema),
});
export type PlanConflictsResponse = z.infer<typeof planConflictsResponseSchema>;
