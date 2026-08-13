import {
  HEALTH_THRESHOLD,
  OPS_THRESHOLD,
  type DataQualityEpic,
  type HealthMetricName,
  type JobRun,
  type OpsHealthResponse,
  type OpsMetric,
} from '@app/shared';
import { levelOf } from './epic-health.service.js';
import { PLAN_SHIFT_WARN_RATIO } from './burndown.service.js';

/**
 * Dashboard giám sát vận hành — HÀM THUẦN của `GET /api/ops/health` (T-33).
 *
 * Nhận số đo ĐÃ đọc sẵn từ PostgreSQL (adapter làm phần I/O) rồi gắn NGƯỠNG và
 * MỨC cho từng con số. Tách phần thuần này ra để kiểm được toàn bộ logic —
 * ngưỡng, sắp xếp, trạng thái rỗng — mà không cần dựng cơ sở dữ liệu.
 *
 * Ba cạm bẫy của một màn hình giám sát mà file này canh:
 *   1. Số đo KHÔNG kèm ngưỡng thì vô nghĩa — "18 phút" là tốt hay xấu?
 *   2. Chưa đo được phải nói `null` (→ "chưa đo được"), TUYỆT ĐỐI không hiện 0
 *      như thể mọi thứ bình thường.
 *   3. Không lộ token: endpoint chỉ ghép số đếm, không đọc header/biến môi trường.
 */

export type OpsLevel = OpsMetric['level'];

/**
 * Mức của một số đo kiểu "trần" — càng cao càng xấu, có một ngưỡng chặn trên.
 *
 * Ngưỡng 0 (không dung sai: Epic lỗi, snapshot trễ) thì mọi giá trị dương là
 * CRITICAL ngay. Ngưỡng dương thì chạm 80% đã WARN để còn kịp trở tay trước khi
 * vượt hẳn.
 */
export function capLevel(value: number, threshold: number): OpsLevel {
  if (threshold <= 0) return value > 0 ? 'CRITICAL' : 'OK';
  if (value > threshold) return 'CRITICAL';
  if (value >= threshold * 0.8) return 'WARN';
  return 'OK';
}

/** Mức trôi kế hoạch — R-11, dùng chung ngưỡng với `summarizeShifts` (T-15). */
export function planDriftLevel(ratio: number): 'OK' | 'WARN' | 'CRITICAL' {
  if (ratio > PLAN_SHIFT_WARN_RATIO * 2) return 'CRITICAL';
  if (ratio > PLAN_SHIFT_WARN_RATIO) return 'WARN';
  return 'OK';
}

function round(n: number): number {
  return Math.round(n);
}

/** Một số đo "trần": có giá trị thì gắn mức, chưa đo được thì `null` + UNKNOWN. */
function capMetric(args: {
  name: string;
  label: string;
  value: number | null;
  threshold: number;
  unit: string;
}): OpsMetric {
  const { name, label, value, threshold, unit } = args;
  return {
    name,
    label,
    value,
    threshold,
    unit,
    level: value === null ? 'UNKNOWN' : capLevel(value, threshold),
  };
}

/** Sáu số đo chất lượng dữ liệu, tính trên toàn bộ Sub-task đang hoạt động. */
const DATA_METRICS: readonly { name: string; label: string; key: HealthMetricName }[] = [
  { name: 'missingWbsDate', label: 'Sub-task thiếu ngày kế hoạch', key: 'missingWbsDateRatio' },
  { name: 'missingEstimate', label: 'Sub-task thiếu ước lượng', key: 'missingEstimateRatio' },
  { name: 'unclassifiedPhase', label: 'Task chưa phân loại', key: 'unclassifiedPhaseRatio' },
  { name: 'unparsedSubtask', label: 'Sub-task sai định dạng', key: 'unparsedSubtaskRatio' },
  { name: 'closedNoWorklog', label: 'Task đóng nhưng chưa log giờ', key: 'closedNoWorklogRatio' },
  { name: 'closeLag', label: 'Task đóng trễ hơn ngày làm thật', key: 'closeLagRatio' },
];

export interface RawRun {
  readonly runId: string;
  readonly epicKey: string;
  readonly runType: string;
  readonly status: string;
  readonly startedAt: Date;
  /** `null` khi job còn đang chạy — cột `duration_ms` chỉ có khi đã kết thúc. */
  readonly durationMs: number | null;
  readonly errorMessage: string | null;
}

export interface RawErroredEpic {
  readonly epicKey: string;
  readonly lastError: string;
  /** Mốc để tính "lỗi bao lâu rồi": lần đồng bộ thành công gần nhất, hoặc lúc thêm Epic. */
  readonly since: Date;
}

export interface RawPlanDrift {
  readonly epicKey: string;
  readonly phaseCode: string;
  /** Tổng số ngày làm việc bị LÙI RA XA (chỉ chiều dương). */
  readonly shiftedWorkdays: number;
  readonly planWorkdays: number;
}

export interface RawDataQualityRatios {
  readonly missingEstimateRatio: number;
  readonly unclassifiedPhaseRatio: number;
  readonly missingWbsDateRatio: number;
  readonly unparsedSubtaskRatio: number;
  readonly closedNoWorklogRatio: number;
  readonly closeLagRatio: number;
}

export interface RawEpicDataQuality extends RawDataQualityRatios {
  readonly epicKey: string;
  readonly displayName: string;
  readonly total: number;
}

export interface OpsHealthInput {
  readonly collectedAt: Date;
  /** Thời lượng lần chạy job đêm (DAILY) gần nhất, tính bằng phút. `null` nếu chưa từng chạy. */
  readonly nightlyDurationMinutes: number | null;
  readonly rateLimitHits24h: number;
  readonly erroredEpicCount: number;
  /** Số Epic ACTIVE đã lỡ ít nhất một snapshot đêm. */
  readonly snapshotBehindCount: number;
  readonly data: RawDataQualityRatios & {
    /** Số Sub-task đang xét. 0 nghĩa là CHƯA có dữ liệu → mọi tỉ lệ là "chưa đo được". */
    readonly total: number;
  };
  /** Chất lượng dữ liệu tách theo TỪNG Epic đang theo dõi. */
  readonly dataByEpic: readonly RawEpicDataQuality[];
  readonly recentRuns: readonly RawRun[];
  readonly erroredEpics: readonly RawErroredEpic[];
  readonly planDrift: readonly RawPlanDrift[];
}

const HOUR_MS = 3_600_000;

/**
 * Ghép phản hồi `GET /api/ops/health` từ số đo đã đọc sẵn.
 *
 * MỘT lần gọi trả về cả bốn nhóm. Dashboard gọi sáu endpoint thì đúng lúc hệ
 * thống đang tải nặng chính nó lại góp phần làm nặng thêm (T-33).
 */
export function dataQualityMetrics(total: number, ratios: RawDataQualityRatios): OpsMetric[] {
  return DATA_METRICS.map(({ name, label, key }) => {
    const ratio = ratios[key];
    // Chưa có Sub-task nào thì "0%" là lời nói dối — trông y hệt dữ liệu sạch.
    // Nói "chưa đo được" thay vì hiện 0.
    if (total <= 0) {
      return { name, label, value: null, threshold: round(HEALTH_THRESHOLD[key].warn * 100), unit: '%', level: 'UNKNOWN' };
    }
    return {
      name,
      label,
      value: round(ratio * 100),
      threshold: round(HEALTH_THRESHOLD[key].warn * 100),
      unit: '%',
      level: levelOf(key, ratio),
    };
  });
}

export function buildOpsHealth(input: OpsHealthInput): OpsHealthResponse {
  const dataMetrics = dataQualityMetrics(input.data.total, input.data);

  // Cùng ngưỡng, cùng cách tính với số toàn cục — chỉ khác phạm vi. Epic tệ nhất
  // lên trước để người trực thấy ngay đội nào cần sửa dữ liệu.
  const worstOf = (ms: readonly OpsMetric[]): number =>
    Math.max(...ms.map((m) => (m.level === 'CRITICAL' ? 2 : m.level === 'WARN' ? 1 : 0)));
  const byEpic: DataQualityEpic[] = input.dataByEpic
    .map((e) => ({
      epicKey: e.epicKey,
      displayName: e.displayName,
      total: e.total,
      metrics: dataQualityMetrics(e.total, e),
    }))
    .sort((a, b) => worstOf(b.metrics) - worstOf(a.metrics) || a.epicKey.localeCompare(b.epicKey));

  const recentRuns: JobRun[] = input.recentRuns.map((r) => ({
    runId: r.runId,
    epicKey: r.epicKey,
    runType: r.runType,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    durationSeconds: r.durationMs === null ? null : r.durationMs / 1000,
    errorMessage: r.errorMessage,
  }));

  const erroredEpics = input.erroredEpics.map((e) => ({
    epicKey: e.epicKey,
    // NGUYÊN VĂN lỗi — "Sync failed" xoá mất đúng thứ người trực lúc 2 giờ sáng cần.
    lastError: e.lastError,
    erroredSinceHours: (input.collectedAt.getTime() - e.since.getTime()) / HOUR_MS,
  }));

  const planDriftRows = input.planDrift
    .map((d) => {
      const ratio = d.planWorkdays > 0 ? d.shiftedWorkdays / d.planWorkdays : 0;
      return {
        epicKey: d.epicKey,
        phaseCode: d.phaseCode,
        shiftedWorkdays: d.shiftedWorkdays,
        planWorkdays: d.planWorkdays,
        ratio,
        level: planDriftLevel(ratio),
      };
    })
    // Chỉ hiện Phase đã trôi QUÁ ngưỡng — danh sách để người trực xử lý, không
    // phải bảng liệt kê mọi dịch chuyển nhỏ.
    .filter((d) => d.level !== 'OK')
    // Nghiêm trọng lên trước — người trực đọc từ trên xuống.
    .sort((a, b) => b.ratio - a.ratio);

  return {
    collectedAt: input.collectedAt.toISOString(),
    jobs: {
      metrics: [
        capMetric({
          name: 'nightlyDuration',
          label: 'Thời lượng job đêm gần nhất',
          value: input.nightlyDurationMinutes,
          threshold: OPS_THRESHOLD.nightlyDurationMinutes,
          unit: 'phút',
        }),
        capMetric({
          name: 'snapshotBehind',
          label: 'Epic trễ snapshot',
          value: input.snapshotBehindCount,
          threshold: OPS_THRESHOLD.missingSnapshotDays,
          unit: 'Epic',
        }),
        capMetric({
          name: 'erroredEpics',
          label: 'Epic đang lỗi',
          value: input.erroredEpicCount,
          threshold: OPS_THRESHOLD.erroredEpics,
          unit: 'Epic',
        }),
      ],
      recentRuns,
      erroredEpics,
    },
    jira: {
      metrics: [
        capMetric({
          name: 'rateLimitHits',
          label: 'Lần bị Jira chặn (24h)',
          value: input.rateLimitHits24h,
          threshold: OPS_THRESHOLD.rateLimitHits24h,
          unit: 'lần',
        }),
      ],
    },
    data: { metrics: dataMetrics, byEpic },
    planDrift: { rows: planDriftRows },
  };
}
