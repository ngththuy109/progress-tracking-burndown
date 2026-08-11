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

/**
 * Bước của pipeline đồng bộ đang chạy khi job ném lỗi.
 *
 * Trả lời "lỗi Ở ĐÂU": FETCH_TREE / FETCH_HISTORY là phía Jira (mạng, quyền,
 * rate limit); PERSIST là phía database; FINALIZE là phần chốt sổ cuối job.
 */
export const SYNC_STEPS = ['FETCH_TREE', 'FETCH_HISTORY', 'PERSIST', 'FINALIZE'] as const;
export type SyncStep = (typeof SYNC_STEPS)[number];

/**
 * Hợp đồng của `GET /api/ops/runs/:runId` — chi tiết MỘT lần chạy job.
 *
 * Bảng Recent runs chỉ mang một dòng `errorMessage`; màn hình chi tiết trả lời
 * hai câu còn lại: lỗi ở bước nào (`errorStep`) và nguyên nhân đầy đủ
 * (`errorDetail` — stack trace nguyên văn).
 */
export const syncRunDetailSchema = z.object({
  runId: z.string(),
  epicKey: z.string(),
  runType: z.string(),
  status: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  apiCallsMade: z.number(),
  rateLimitHits: z.number(),
  daysComputed: z.number(),
  /** Bước đang chạy khi lỗi. `null` với job thành công hoặc job cũ (trước khi có cột). */
  errorStep: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Stack trace nguyên văn. `null` với job thành công hoặc job cũ. */
  errorDetail: z.string().nullable(),
});
export type SyncRunDetail = z.infer<typeof syncRunDetailSchema>;

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

/**
 * Chất lượng dữ liệu của MỘT Epic đang theo dõi.
 *
 * Tách theo Epic vì "5% Sub-task thiếu ước lượng" toàn cục không nói được đội
 * nào phải sửa — cùng con số đó có thể là một Epic sạch và một Epic nát.
 */
export const dataQualityEpicSchema = z.object({
  epicKey: z.string(),
  displayName: z.string(),
  /** Số Sub-task đang xét của Epic này (đã trừ ticket được đánh dấu bỏ qua). */
  total: z.number(),
  metrics: z.array(opsMetricSchema),
});
export type DataQualityEpic = z.infer<typeof dataQualityEpicSchema>;

/** Bốn loại lỗi dữ liệu — khớp với bốn số đo ở nhóm Data quality. */
export const DQ_PROBLEMS = [
  'MISSING_ESTIMATE',
  'MISSING_WBS_DATE',
  'UNCLASSIFIED_PHASE',
  'UNPARSED_TITLE',
] as const;
export type DqProblem = (typeof DQ_PROBLEMS)[number];

/**
 * Hợp đồng của `GET /api/ops/data-quality/issues` — chi tiết TỪNG ticket lỗi.
 *
 * Các số đo phần trăm chỉ nói "có bao nhiêu"; danh sách này nói "ticket NÀO,
 * lỗi GÌ" để người dùng biết sub-task nào cần điều chỉnh — và xuất được ra file.
 * Ticket đã đánh dấu bỏ qua vẫn nằm trong danh sách (kèm cờ `exempt`) để gỡ
 * đánh dấu được, nhưng KHÔNG được tính vào các số đo.
 */
export const dataQualityIssueSchema = z.object({
  issueKey: z.string(),
  epicKey: z.string(),
  epicDisplayName: z.string(),
  summary: z.string(),
  problems: z.array(z.enum(DQ_PROBLEMS)),
  /** true = người vận hành đã xác nhận "không cần sửa dữ liệu". */
  exempt: z.boolean(),
  exemptBy: z.string().nullable(),
});
export type DataQualityIssue = z.infer<typeof dataQualityIssueSchema>;

export const dataQualityIssuesResponseSchema = z.object({
  collectedAt: z.string(),
  issues: z.array(dataQualityIssueSchema),
});
export type DataQualityIssuesResponse = z.infer<typeof dataQualityIssuesResponseSchema>;

/** Thân của `PUT /api/ops/data-quality/issues/:issueKey/exempt`. */
export const dqExemptRequestSchema = z.object({ exempt: z.boolean() });
export type DqExemptRequest = z.infer<typeof dqExemptRequestSchema>;

export const dqExemptResponseSchema = z.object({
  issueKey: z.string(),
  exempt: z.boolean(),
});
export type DqExemptResponse = z.infer<typeof dqExemptResponseSchema>;

export const opsHealthResponseSchema = z.object({
  /** Thời điểm số liệu này được lấy. Thiếu nó thì có người ra quyết định trên số của 20 phút trước. */
  collectedAt: z.string(),
  jobs: z.object({
    metrics: z.array(opsMetricSchema),
    recentRuns: z.array(jobRunSchema),
    erroredEpics: z.array(erroredEpicSchema),
  }),
  jira: z.object({ metrics: z.array(opsMetricSchema) }),
  data: z.object({
    metrics: z.array(opsMetricSchema),
    /** Tách theo TỪNG Epic đang theo dõi — số toàn cục không nói được đội nào phải sửa. */
    byEpic: z.array(dataQualityEpicSchema),
  }),
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
