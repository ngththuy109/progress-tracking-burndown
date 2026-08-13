import { z } from 'zod';
import { syncJobPayloadSchema } from './sync-job.js';

/**
 * Hợp đồng HTTP của nhóm API vận hành Epic — PRD Phụ lục B.
 *
 * Endpoint quan trọng nhất là `/explain`: nó là **bước đầu tiên trong runbook**
 * khi PM báo số liệu sai (PRD §10.3).
 */

/** Ba mức cảnh báo dùng chung cho mọi chỉ số sức khoẻ. */
export const HEALTH_LEVEL = ['OK', 'WARN', 'CRITICAL'] as const;
export type HealthLevel = (typeof HEALTH_LEVEL)[number];

/**
 * Ngưỡng cảnh báo — PRD §10.4.
 *
 * Để ở `shared` vì cả API (T-25) lẫn dashboard vận hành (T-33) đều đọc; hai nơi
 * tự khai riêng thì sẽ có ngày lệch nhau và người trực không biết tin bên nào.
 */
export const HEALTH_THRESHOLD = {
  /** Sub-task thiếu Original Estimate — rủi ro R-02. */
  missingEstimateRatio: { warn: 0.1, critical: 0.3 },
  /** Task rơi vào Chưa phân loại — rủi ro R-01. */
  unclassifiedPhaseRatio: { warn: 0.2, critical: 0.4 },
  /** Sub-task thiếu ngày kế hoạch — rủi ro R-08. */
  missingWbsDateRatio: { warn: 0.1, critical: 0.3 },
  /** Sub-task đặt tên sai định dạng — E-27. */
  unparsedSubtaskRatio: { warn: 0.3, critical: 0.5 },
  /**
   * Sub-task đã đóng, CÓ ước lượng nhưng KHÔNG có worklog nào.
   *
   * Đây là tập task mà đường Thực tế chỉ tụt về 0 đúng vào ngày bấm đóng ticket
   * (Quy tắc 1), không có mốc worklog để suy ra "làm xong thật lúc nào" — nên
   * nếu ticket đóng trễ hơn ngày làm thật thì biểu đồ trông như task bị trễ.
   * Cùng thang với `missingEstimateRatio` vì cùng là "khối lượng bị khai thiếu".
   */
  closedNoWorklogRatio: { warn: 0.1, critical: 0.3 },
} as const;

export type HealthMetricName = keyof typeof HEALTH_THRESHOLD;

export const healthMetricSchema = z.object({
  name: z.string(),
  ratio: z.number(),
  level: z.enum(HEALTH_LEVEL),
  /** Câu tiếng Việt nói rõ điều gì sai và làm gì tiếp (C-9). */
  message: z.string(),
});
export type HealthMetric = z.infer<typeof healthMetricSchema>;

export const epicHealthResponseSchema = z.object({
  epicKey: z.string(),
  status: z.string(),
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** NGÀY CỤ THỂ bị thiếu snapshot, không phải một con số (E-12). */
  missingSnapshotDays: z.array(z.string()),
  metrics: z.array(healthMetricSchema),
  /** Mức xấu nhất trong mọi chỉ số — dùng cho huy hiệu tổng. */
  overallLevel: z.enum(HEALTH_LEVEL),
});
export type EpicHealthResponse = z.infer<typeof epicHealthResponseSchema>;

// ---------------------------------------------------------------------------
// Giải thích một điểm dữ liệu
// ---------------------------------------------------------------------------

export const explainRowSchema = z.object({
  issueKey: z.string(),
  summary: z.string(),
  phaseCode: z.string(),
  statusCategoryAtDay: z.enum(['new', 'indeterminate', 'done']),
  /** 1, '1b', 2 hay 3 — quy tắc nào của PRD §4.3.2 đã được áp dụng. */
  appliedRule: z.union([z.literal(1), z.literal('1b'), z.literal(2), z.literal(3)]),
  /** Câu tiếng Việt PM đọc được. Chỉ có số quy tắc thì endpoint này vô dụng. */
  ruleExplanation: z.string(),
  originalEstimateHours: z.number(),
  spentHoursUpToDay: z.number(),
  remainingHours: z.number(),
  /**
   * CHỈ có khi quy tắc 2 thắng — đây là thứ runbook bảo đi tìm.
   *
   * Ai đó sửa tay `timeestimate` trên Jira một lần và giá trị đó dính mãi. Đó là
   * nguyên nhân sai số phổ biến nhất (PRD §10.3).
   */
  estimateOverride: z
    .object({
      valueHours: z.number(),
      changedAt: z.string(),
      changedBy: z.string().nullable(),
    })
    .nullable(),
});
export type ExplainRow = z.infer<typeof explainRowSchema>;

export const explainResponseSchema = z.object({
  epicKey: z.string(),
  date: z.string(),
  rows: z.array(explainRowSchema),
  recomputedRemainingHours: z.number(),
  storedRemainingHours: z.number(),
  /**
   * Chỉ khác `null` khi số tính lại LỆCH số đã lưu.
   *
   * Đây là lý do tồn tại của endpoint: phát hiện snapshot cũ hoặc engine sai.
   * Tính lại mà không so với số đã lưu thì bỏ lỡ đúng thứ đáng giá nhất.
   */
  mismatch: z
    .object({
      storedHours: z.number(),
      recomputedHours: z.number(),
      differenceHours: z.number(),
    })
    .nullable(),
});
export type ExplainResponse = z.infer<typeof explainResponseSchema>;

// ---------------------------------------------------------------------------
// Đồng bộ lại
// ---------------------------------------------------------------------------

/**
 * Thân yêu cầu `POST /api/epic/:epicKey/resync`.
 *
 * DẪN XUẤT từ schema của job chứ không khai lại: `epicKey` đã nằm trong đường
 * dẫn nên bỏ đi, ba trường còn lại giống hệt. Hai bản khai riêng chính là cách
 * lỗi cũ đã xảy ra — API nhận một trường mà job không bao giờ nhìn thấy. Dẫn
 * xuất thế này thì thêm trường vào yêu cầu mà quên thêm vào job là chuyện không
 * xảy ra được nữa.
 */
export const resyncRequestSchema = syncJobPayloadSchema.omit({ epicKey: true });
export type ResyncRequest = z.infer<typeof resyncRequestSchema>;

export const resyncResponseSchema = z.object({
  jobId: z.string(),
  queued: z.literal(true),
  /** Ước tính thô, KHÔNG phải cam kết. Đừng làm đồng hồ đếm ngược. */
  estimatedSeconds: z.number().int(),
});
export type ResyncResponse = z.infer<typeof resyncResponseSchema>;

// ---------------------------------------------------------------------------
// Lịch sử dịch chuyển kế hoạch
// ---------------------------------------------------------------------------

export const planShiftRowSchema = z.object({
  phaseCode: z.string(),
  shiftType: z.string(),
  fromDate: z.string().nullable(),
  toDate: z.string().nullable(),
  shiftedWorkdays: z.number(),
  causedByKeys: z.array(z.string()),
  detectedAt: z.string(),
});
export type PlanShiftRow = z.infer<typeof planShiftRowSchema>;

export const planShiftHistoryResponseSchema = z.object({
  epicKey: z.string(),
  shifts: z.array(planShiftRowSchema),
  totalShiftedWorkdays: z.number(),
  warningLevel: z.enum(HEALTH_LEVEL),
});
export type PlanShiftHistoryResponse = z.infer<typeof planShiftHistoryResponseSchema>;
