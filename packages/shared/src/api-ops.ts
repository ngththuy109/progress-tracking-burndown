import { z } from 'zod';

/**
 * Hợp đồng của `GET /api/ops/health` — dashboard giám sát (T-33).
 *
 * MỘT endpoint gom mọi số đo. Màn hình gọi 6 endpoint thì lúc hệ thống đang tải
 * nặng chính dashboard lại góp phần làm nặng thêm — đúng lúc không nên.
 */

export const jobRunSchema = z.object({
  runId: z.string(),
  epicKey: z.string(),
  runType: z.string(),
  status: z.string(),
  startedAt: z.string(),
  /** Job đêm dài dần là dấu hiệu SỚM NHẤT của việc hệ thống sắp không kịp. */
  durationSeconds: z.number().nullable(),
  errorMessage: z.string().nullable(),
});
export type JobRun = z.infer<typeof jobRunSchema>;

export const erroredEpicSchema = z.object({
  epicKey: z.string(),
  /** NGUYÊN VĂN lỗi. "Sync failed" không giúp được người trực lúc 2 giờ sáng. */
  lastError: z.string(),
  erroredSinceHours: z.number(),
});

export const planDriftRowSchema = z.object({
  epicKey: z.string(),
  phaseCode: z.string(),
  shiftedWorkdays: z.number(),
  planWorkdays: z.number(),
  ratio: z.number(),
  level: z.enum(['OK', 'WARN', 'CRITICAL']),
});

/**
 * Một số đo kèm NGƯỠNG của nó.
 *
 * Số đo không có ngưỡng thì vô nghĩa: "18 phút" là tốt hay xấu? Chỉ biết được
 * khi thấy ngưỡng là 30 phút.
 */
export const opsMetricSchema = z.object({
  name: z.string(),
  label: z.string(),
  value: z.number().nullable(),
  threshold: z.number(),
  unit: z.string(),
  level: z.enum(['OK', 'WARN', 'CRITICAL', 'UNKNOWN']),
});
export type OpsMetric = z.infer<typeof opsMetricSchema>;

export const opsHealthResponseSchema = z.object({
  /** Thời điểm số liệu này được lấy. Thiếu nó thì có người ra quyết định trên số của 20 phút trước. */
  collectedAt: z.string(),
  jobs: z.object({
    metrics: z.array(opsMetricSchema),
    recentRuns: z.array(jobRunSchema),
    erroredEpics: z.array(erroredEpicSchema),
  }),
  jira: z.object({ metrics: z.array(opsMetricSchema) }),
  data: z.object({ metrics: z.array(opsMetricSchema) }),
  planDrift: z.object({ rows: z.array(planDriftRowSchema) }),
});
export type OpsHealthResponse = z.infer<typeof opsHealthResponseSchema>;

/** Ngưỡng riêng của dashboard — PRD §10.4. */
export const OPS_THRESHOLD = {
  /** Job đêm chạy quá số phút này là sắp không kịp cửa sổ ban đêm. */
  nightlyDurationMinutes: 240,
  rateLimitHits24h: 10,
  erroredEpics: 0,
  missingSnapshotDays: 0,
  apiP95Ms: 2000,
} as const;

/** Tự làm mới mỗi 60 giây; người dùng tắt được. */
export const OPS_REFRESH_MS = 60_000;
