import { z } from 'zod';
import type { DateOnly } from './calendar.js';

/**
 * Hợp đồng HTTP của nhóm API biểu đồ Burndown — PRD Phụ lục B.
 *
 * Tên trường PHẢI khớp Phụ lục B: màn hình biểu đồ (T-30) đã được đặc tả theo
 * đó, đổi tên là hỏng card sau.
 */

/** Ba chế độ xem của PRD §5.1. */
export const CHART_MODE = ['EPIC', 'PHASE', 'COMPARE'] as const;
export type ChartMode = (typeof CHART_MODE)[number];

/** Tối đa 4 Phase khi so sánh — hơn nữa thì biểu đồ không đọc được. */
export const MAX_COMPARE_PHASES = 4;

/** Cache biểu đồ sống 15 phút (PRD §4.7). */
export const CHART_CACHE_TTL_SECONDS = 15 * 60;

// ---------------------------------------------------------------------------
// Điểm dữ liệu
// ---------------------------------------------------------------------------

export const chartPointSchema = z.object({
  date: z.string(),
  /**
   * `null` = KHÔNG CÓ SNAPSHOT ngày đó.
   *
   * Đây là lỗ thủng nhìn thấy được, cố ý không nội suy. Nối tắt hai điểm trông
   * đẹp hơn nhưng PM sẽ đọc ra một tiến độ không có thật (E-12).
   */
  plannedRemainingHours: z.number().nullable(),
  actualRemainingHours: z.number().nullable(),
  /** Kế hoạch trừ thực tế. Dương = đang sớm, âm = đang trễ. */
  varianceHours: z.number().nullable(),
});
export type ChartPoint = z.infer<typeof chartPointSchema>;

export const chartSeriesSchema = z.object({
  /** `EPIC` cho chế độ tổng, hoặc mã Phase. */
  key: z.string(),
  label: z.string(),
  colorHex: z.string().nullable(),
  points: z.array(chartPointSchema),
});
export type ChartSeries = z.infer<typeof chartSeriesSchema>;

// ---------------------------------------------------------------------------
// Dấu mốc
// ---------------------------------------------------------------------------

export const CHART_MARKER_TYPE = ['SCOPE_ADDED', 'SCOPE_REMOVED', 'PLAN_SHIFTED'] as const;
export type ChartMarkerType = (typeof CHART_MARKER_TYPE)[number];

export const chartMarkerSchema = z.object({
  date: z.string(),
  type: z.enum(CHART_MARKER_TYPE),
  /** Giờ phát sinh thêm/bớt, hoặc số ngày làm việc bị dời. */
  amount: z.number(),
  /** Câu tiếng Việt hiện trong tooltip. */
  detail: z.string(),
  /** Sub-task hoặc Phase gây ra. */
  causedByKeys: z.array(z.string()),
});
export type ChartMarker = z.infer<typeof chartMarkerSchema>;

export const PLAN_SHIFT_LEVEL = ['OK', 'WARN', 'CRITICAL'] as const;

export const planShiftSummarySchema = z.object({
  /** Tổng số ngày LÀM VIỆC bị lùi. Chỉ đếm chiều lùi ra xa. */
  totalShiftedWorkdays: z.number(),
  shiftCount: z.number().int(),
  warningLevel: z.enum(PLAN_SHIFT_LEVEL),
});
export type PlanShiftSummary = z.infer<typeof planShiftSummarySchema>;

// ---------------------------------------------------------------------------
// Sức khoẻ dữ liệu
// ---------------------------------------------------------------------------

export const dataHealthSchema = z.object({
  /**
   * NGÀY CỤ THỂ bị thiếu snapshot, không phải một con số.
   *
   * PM cần biết thủng lỗ ở đâu để đi tìm nguyên nhân; "thiếu 3 ngày" không giúp
   * được gì (E-12).
   */
  missingSnapshotDays: z.array(z.string()),
  missingEstimateRatio: z.number(),
  unclassifiedPhaseRatio: z.number(),
  missingWbsDateRatio: z.number(),
});
export type DataHealth = z.infer<typeof dataHealthSchema>;

// ---------------------------------------------------------------------------
// Phản hồi
// ---------------------------------------------------------------------------

/**
 * Câu giải thích BẮT BUỘC đi kèm mọi phản hồi.
 *
 * Hệ thống không dùng baseline (PRD §4.3), nên đường Kế hoạch phản ánh kế hoạch
 * MỚI NHẤT chứ không phải cam kết ban đầu. Không nói rõ điều này thì PM sẽ thấy
 * điểm của hôm qua đổi chỗ và tưởng hệ thống hỏng. Đây là tuyến phòng thủ R-11.
 */
export const PLAN_FLOATING_NOTE =
  'The Planned line is recomputed after every sync, including the part already in the past, ' +
  'because the system follows the latest plan in Jira instead of freezing the original commitment. ' +
  'Look for the ⚑ marks to see when a planned date moved and what caused it.';

export const burndownResponseSchema = z.object({
  epicKey: z.string(),
  mode: z.enum(CHART_MODE),
  from: z.string(),
  to: z.string(),
  series: z.array(chartSeriesSchema),
  markers: z.array(chartMarkerSchema),
  planShiftSummary: planShiftSummarySchema,
  dataHealth: dataHealthSchema,
  /** Luôn `true` ở phiên bản này. Có baseline rồi mới có thể là `false`. */
  planIsFloating: z.literal(true),
  planNote: z.string(),
  /**
   * Cảnh báo về LỊCH LÀM VIỆC của Epic — ví dụ "lịch chưa khai ngày lễ nào"
   * (E-14) hay "không tìm thấy lịch, đang dùng mặc định". Sinh ra từ T-12
   * nhưng trước đây chỉ nằm trong dữ liệu nội bộ; đưa vào phản hồi để màn hình
   * hiện được cho người dùng (C-10) — cấu hình lịch sai không còn im lặng.
   * `default([])` để client cũ đọc phản hồi cũ vẫn parse được.
   */
  calendarWarnings: z.array(z.string()).default([]),
});
export type BurndownResponse = z.infer<typeof burndownResponseSchema>;

/** Một dòng `daily_snapshot` đã nạp, dạng engine/service dùng. */
export interface SnapshotRow {
  readonly snapshotDate: DateOnly;
  readonly plannedRemainingS: number;
  readonly actualRemainingS: number;
  readonly totalScopeS: number;
  readonly totalSpentS: number;
  readonly scopeAddedS: number;
  readonly scopeRemovedS: number;
  readonly countTodo: number;
  readonly countInProgress: number;
  readonly countDone: number;
  readonly perPhase: readonly {
    readonly phaseCode: string;
    readonly remainingS: number;
    readonly spentS: number;
    readonly originalS: number;
    readonly countTodo: number;
    readonly countInProgress: number;
    readonly countDone: number;
    readonly plannedRemainingS: number | null;
  }[];
}
