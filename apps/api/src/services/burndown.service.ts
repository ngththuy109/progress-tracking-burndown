import {
  MAX_COMPARE_PHASES,
  PLAN_FLOATING_NOTE,
  type BurndownResponse,
  type ChartMarker,
  type ChartMode,
  type ChartPoint,
  type ChartSeries,
  type DataHealth,
  type DateOnly,
  type PhaseRollup,
  type PlanShiftRecord,
  type PlanShiftSummary,
  type SnapshotRow,
} from '@app/shared';
import { ApiError } from './phase-config.service.js';

/**
 * Dựng dữ liệu biểu đồ Burndown — PRD §5.1, Phụ lục B.
 *
 * TOÀN BỘ file này là HÀM THUẦN: nhận snapshot đã nạp sẵn, trả về phản hồi.
 * Không đọc database, không đọc đồng hồ, không gọi engine dựng lịch sử.
 *
 * NGUYÊN TẮC SỐNG CÒN: API này KHÔNG BAO GIỜ tính lịch sử tại chỗ (PRD §9.1).
 * Đó chính là lý do đạt được mốc p95 ≤ 800ms. Thấy mình đang gọi tới engine
 * dựng lịch sử là đã đi sai hướng.
 */

const SECONDS_PER_HOUR = 3600;

/**
 * Đổi giây sang giờ — CHỈ Ở ĐÂY.
 *
 * Trong hệ thống mọi thứ lưu bằng giây (C-2). Đổi ở nhiều chỗ khác nhau thì sẽ
 * có ngày hai chỗ làm tròn khác nhau và tổng không khớp.
 */
export function toHours(seconds: number): number {
  return seconds / SECONDS_PER_HOUR;
}

export interface BuildChartArgs {
  readonly epicKey: string;
  readonly mode: ChartMode;
  /** Ngày làm việc trong khoảng, đã tính sẵn từ lịch. */
  readonly workdays: readonly DateOnly[];
  readonly snapshots: readonly SnapshotRow[];
  readonly rollups: readonly PhaseRollup[];
  readonly planShifts: readonly PlanShiftRecord[];
  /** Chỉ có nghĩa với chế độ `PHASE` và `COMPARE`. */
  readonly phaseCodes?: readonly string[];
  readonly labels?: Readonly<Record<string, { label: string; colorHex: string | null }>>;
  /** Tỉ lệ dữ liệu bẩn, đếm ở tầng repository. */
  readonly ratios: Omit<DataHealth, 'missingSnapshotDays'>;
}

export function buildChart(args: BuildChartArgs): BurndownResponse {
  const byDate = new Map(args.snapshots.map((s) => [s.snapshotDate, s]));

  const series =
    args.mode === 'EPIC'
      ? [
          epicSeries(args.workdays, byDate),
          // KÈM luôn chuỗi số của TỪNG Phase vào cùng một phản hồi Tổng Epic.
          // Màn hình Burndown dựng ô chọn Phase TỪ CHÍNH `series` này và đổi
          // Phase KHÔNG gọi lại API (xem `use-burndown.ts`: "một lần gọi cho cả
          // Epic"). Thiếu phần này thì ở chế độ Single Phase / Compare ô chọn
          // trống trơn — PM không có Phase nào để bấm.
          ...distinctPhaseCodes(args.rollups).map((code) =>
            phaseSeries(code, args.workdays, byDate, args.labels),
          ),
        ]
      : (args.phaseCodes ?? []).map((code) => phaseSeries(code, args.workdays, byDate, args.labels));

  return {
    epicKey: args.epicKey,
    mode: args.mode,
    from: args.workdays[0] ?? '',
    to: args.workdays[args.workdays.length - 1] ?? '',
    series,
    markers: buildMarkers(args.snapshots, args.planShifts),
    planShiftSummary: summarizeShifts(args.planShifts, args.rollups),
    dataHealth: {
      missingSnapshotDays: args.workdays.filter((d) => !byDate.has(d)),
      ...args.ratios,
    },
    planIsFloating: true,
    planNote: PLAN_FLOATING_NOTE,
  };
}

/**
 * Danh sách mã Phase của Epic, không trùng, GIỮ NGUYÊN thứ tự rollup.
 *
 * Rollup đã được tầng đọc sắp theo `display_order`; giữ nguyên thứ tự đó để ô
 * chọn Phase và các đường trên biểu đồ hiện theo đúng thứ tự PM đã cấu hình, và
 * để hai lần gọi cho ra thứ tự giống nhau (C-6).
 */
function distinctPhaseCodes(rollups: readonly PhaseRollup[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rollups) {
    if (!seen.has(r.phaseCode)) {
      seen.add(r.phaseCode);
      out.push(r.phaseCode);
    }
  }
  return out;
}

function point(date: DateOnly, planned: number | null, actual: number | null): ChartPoint {
  return {
    date,
    plannedRemainingHours: planned === null ? null : toHours(planned),
    actualRemainingHours: actual === null ? null : toHours(actual),
    varianceHours: planned === null || actual === null ? null : toHours(planned - actual),
  };
}

function epicSeries(
  workdays: readonly DateOnly[],
  byDate: ReadonlyMap<string, SnapshotRow>,
): ChartSeries {
  return {
    key: 'EPIC',
    label: 'Whole Epic',
    colorHex: null,
    points: workdays.map((date) => {
      const snap = byDate.get(date);
      // Ngày thiếu snapshot trả `null` — LỖ THỦNG NHÌN THẤY ĐƯỢC. Nối tắt hai
      // điểm bên cạnh trông đẹp hơn nhưng là bịa ra một tiến độ không có thật.
      return snap === undefined
        ? point(date, null, null)
        : point(date, snap.plannedRemainingS, snap.actualRemainingS);
    }),
  };
}

function phaseSeries(
  phaseCode: string,
  workdays: readonly DateOnly[],
  byDate: ReadonlyMap<string, SnapshotRow>,
  labels: BuildChartArgs['labels'],
): ChartSeries {
  return {
    key: phaseCode,
    label: labels?.[phaseCode]?.label ?? phaseCode,
    colorHex: labels?.[phaseCode]?.colorHex ?? null,
    points: workdays.map((date) => {
      const snap = byDate.get(date);
      if (snap === undefined) return point(date, null, null);

      // Số của Phase lấy TỪ `per_phase`, không lấy số mức Epic. Phase vắng mặt
      // trong ngày đó nghĩa là chưa có Sub-task nào — cũng là một lỗ thủng thật.
      const p = snap.perPhase.find((x) => x.phaseCode === phaseCode);
      if (p === undefined) return point(date, null, null);

      return point(date, p.plannedRemainingS, p.remainingS);
    }),
  };
}

// ---------------------------------------------------------------------------
// Dấu mốc
// ---------------------------------------------------------------------------

function buildMarkers(
  snapshots: readonly SnapshotRow[],
  shifts: readonly PlanShiftRecord[],
): ChartMarker[] {
  const markers: ChartMarker[] = [];

  for (const s of snapshots) {
    if (s.scopeAddedS > 0) {
      markers.push({
        date: s.snapshotDate,
        type: 'SCOPE_ADDED',
        amount: toHours(s.scopeAddedS),
        detail: `${formatHours(s.scopeAddedS)}h of work was added on this day.`,
        causedByKeys: [],
      });
    }
    if (s.scopeRemovedS > 0) {
      markers.push({
        date: s.snapshotDate,
        type: 'SCOPE_REMOVED',
        amount: toHours(s.scopeRemovedS),
        detail: `${formatHours(s.scopeRemovedS)}h of work was removed on this day.`,
        causedByKeys: [],
      });
    }
  }

  for (const shift of shifts) {
    const direction = shift.shiftedWorkdays >= 0 ? 'pushed out' : 'pulled in';
    markers.push({
      // Mốc dịch chuyển gắn vào NGÀY MỚI: đó là ngày người xem cần nhìn tới.
      date: shift.toDate ?? shift.fromDate ?? '',
      type: 'PLAN_SHIFTED',
      amount: shift.shiftedWorkdays,
      detail:
        `Phase ${shift.phaseCode}: the ${shift.shiftType === 'START_MOVED' ? 'start' : 'end'} date was ` +
        `${direction} from ${shift.fromDate ?? 'none'} to ${shift.toDate ?? 'none'} ` +
        `(${Math.abs(shift.shiftedWorkdays)} working days).`,
      causedByKeys: [...shift.causedByKeys],
    });
  }

  // Thứ tự ổn định để hai lần gọi cho kết quả giống nhau (C-6).
  return markers.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
}

function formatHours(seconds: number): string {
  return (seconds / SECONDS_PER_HOUR).toFixed(2).replace(/\.00$/, '');
}

/** Ngưỡng cảnh báo R-11: tổng số ngày lùi vượt 20% độ dài Phase. */
export const PLAN_SHIFT_WARN_RATIO = 0.2;

export function summarizeShifts(
  shifts: readonly PlanShiftRecord[],
  rollups: readonly PhaseRollup[],
): PlanShiftSummary {
  // CHỈ đếm chiều lùi ra xa. Cộng cả phần kéo sớm lên sẽ để một Phase về sớm
  // che mất một Phase đang trễ — đúng thứ R-11 sinh ra để phát hiện.
  const delayed = shifts.filter((s) => s.shiftedWorkdays > 0);
  const total = delayed.reduce((sum, s) => sum + s.shiftedWorkdays, 0);

  const planWorkdays = rollups.reduce((sum, r) => sum + (r.planWorkdays ?? 0), 0);
  const ratio = planWorkdays > 0 ? total / planWorkdays : 0;

  return {
    totalShiftedWorkdays: total,
    shiftCount: delayed.length,
    warningLevel:
      planWorkdays <= 0
        ? 'OK'
        : ratio > PLAN_SHIFT_WARN_RATIO * 2
          ? 'CRITICAL'
          : ratio > PLAN_SHIFT_WARN_RATIO
            ? 'WARN'
            : 'OK',
  };
}

// ---------------------------------------------------------------------------
// Kiểm tham số
// ---------------------------------------------------------------------------

/** Phase được chọn phải có thật trong Epic, và tối đa 4 cái. */
export function assertComparablePhases(
  requested: readonly string[],
  rollups: readonly PhaseRollup[],
): void {
  if (requested.length === 0) {
    throw new ApiError(400, 'NO_PHASE_SELECTED', 'Pick at least one Phase to compare.');
  }
  if (requested.length > MAX_COMPARE_PHASES) {
    throw new ApiError(
      400,
      'TOO_MANY_PHASES',
      `You can compare at most ${MAX_COMPARE_PHASES} Phases at once; ${requested.length} are selected. ` +
        'Deselect a few and try again.',
    );
  }
  assertPhasesExist(requested, rollups);
}

export function assertPhasesExist(
  requested: readonly string[],
  rollups: readonly PhaseRollup[],
): void {
  const known = new Set(rollups.map((r) => r.phaseCode));
  const unknown = requested.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw new ApiError(
      404,
      'PHASE_NOT_FOUND',
      `This Epic has no such Phase: ${unknown.join(', ')}. ` +
        `Phases it does have: ${[...known].sort().join(', ') || '(none yet)'}.`,
    );
  }
}

/**
 * Trục ngang của biểu đồ.
 *
 * Chế độ một Phase CO LẠI đúng khoảng của Phase đó; để nguyên khoảng của cả
 * Epic sẽ vẽ ra một đường nằm ngang dài lê thê ở hai đầu (PRD §5.1).
 */
export function resolveRange(
  mode: ChartMode,
  rollups: readonly PhaseRollup[],
  phaseCodes: readonly string[],
): { from: DateOnly | null; to: DateOnly | null } {
  const relevant =
    mode === 'EPIC' ? rollups : rollups.filter((r) => phaseCodes.includes(r.phaseCode));

  let from: DateOnly | null = null;
  let to: DateOnly | null = null;

  for (const r of relevant) {
    if (r.planStart !== null && (from === null || r.planStart < from)) from = r.planStart;
    if (r.planEnd !== null && (to === null || r.planEnd > to)) to = r.planEnd;
  }

  return { from, to };
}
