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
  type WorkCalendar,
} from '@app/shared';
import { computePlannedRemaining } from '@app/engine';
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
 *
 * NGOẠI LỆ DUY NHẤT: phần đường Kế hoạch SAU ngày snapshot cuối cùng. Tương lai
 * chưa có snapshot nào để đọc, nhưng đường Kế hoạch phải vẽ tới hết `plan_end`
 * để PM nhìn thấy kế hoạch dự kiến kết thúc khi nào. `computePlannedRemaining`
 * là hàm thuần trên rollup đã nạp sẵn — không phải engine dựng lịch sử, không
 * đụng tới changelog hay database.
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
  /** Ngày làm việc trong khoảng, đã tính sẵn từ lịch — dùng cho dataHealth. */
  readonly workdays: readonly DateOnly[];
  /**
   * TOÀN BỘ ngày lịch trong khoảng — trục vẽ (2026-08: ngày nghỉ lên trục,
   * bôi xám). Ngày nào không nằm trong `workdays` là ngày nghỉ; snapshot của
   * ngày nghỉ (worker chốt cho mọi ngày lịch) cho đường Thực tế giảm đúng hôm
   * team làm cuối tuần.
   */
  readonly days: readonly DateOnly[];
  readonly snapshots: readonly SnapshotRow[];
  readonly rollups: readonly PhaseRollup[];
  readonly planShifts: readonly PlanShiftRecord[];
  /** Lịch làm việc của Epic — cần cho phần đường Kế hoạch sau snapshot cuối. */
  readonly calendar: WorkCalendar;
  /** Chỉ có nghĩa với chế độ `PHASE` và `COMPARE`. */
  readonly phaseCodes?: readonly string[];
  readonly labels?: Readonly<Record<string, { label: string; colorHex: string | null }>>;
  /** Tỉ lệ dữ liệu bẩn, đếm ở tầng repository. */
  readonly ratios: Omit<DataHealth, 'missingSnapshotDays'>;
}

export function buildChart(args: BuildChartArgs): BurndownResponse {
  const byDate = new Map(args.snapshots.map((s) => [s.snapshotDate, s]));
  const workdaySet = new Set(args.workdays);

  // Bối cảnh cho phần đường Kế hoạch SAU snapshot cuối cùng: từ đó tới
  // `plan_end` chưa có snapshot nào, đường Kế hoạch được chiếu tiếp từ rollup
  // hiện tại — nhờ vậy PM nhìn được kế hoạch dự kiến kết thúc khi nào.
  const projection: PlanProjection = {
    calendar: args.calendar,
    rollups: args.rollups,
    firstSnapshot: earliestSnapshot(args.snapshots),
    lastSnapshot: latestSnapshot(args.snapshots),
  };

  const series =
    args.mode === 'EPIC'
      ? [
          epicSeries(args.days, workdaySet, byDate, projection),
          // KÈM luôn chuỗi số của TỪNG Phase vào cùng một phản hồi Tổng Epic.
          // Màn hình Burndown dựng ô chọn Phase TỪ CHÍNH `series` này và đổi
          // Phase KHÔNG gọi lại API (xem `use-burndown.ts`: "một lần gọi cho cả
          // Epic"). Thiếu phần này thì ở chế độ Single Phase / Compare ô chọn
          // trống trơn — PM không có Phase nào để bấm.
          ...distinctPhaseCodes(args.rollups).map((code) =>
            phaseSeries(code, args.days, workdaySet, byDate, args.labels, projection),
          ),
        ]
      : (args.phaseCodes ?? []).map((code) =>
          phaseSeries(code, args.days, workdaySet, byDate, args.labels, projection),
        );

  // Ngày thiếu snapshot chỉ tính LỖ THỦNG THẬT: ngày nằm TRONG tầm đã chốt sổ
  // (từ snapshot ĐẦU TIÊN tới snapshot CUỐI CÙNG) mà vẫn trống — dấu hiệu job
  // đêm bỏ lỡ (E-12).
  //
  // Hai đầu bị loại tường minh vì không phải lỗ thủng: ngày SAU snapshot cuối là
  // tương lai CHƯA TỚI, còn ngày TRƯỚC snapshot đầu là quá khứ TRƯỚC KHI Epic bắt
  // đầu được chốt sổ. Cả hai đều được đường Kế hoạch chiếu tiếp (xem `epicSeries`);
  // kêu "thiếu snapshot" ở đó là báo động giả khiến PM tưởng job đêm hỏng trong
  // khi mọi thứ vẫn ổn.
  const firstSnapshotDate = projection.firstSnapshot?.snapshotDate ?? null;
  const lastSnapshotDate = projection.lastSnapshot?.snapshotDate ?? null;
  const missingSnapshotDays =
    firstSnapshotDate === null || lastSnapshotDate === null
      ? []
      : args.workdays.filter(
          (d) => d >= firstSnapshotDate && d <= lastSnapshotDate && !byDate.has(d),
        );

  return {
    epicKey: args.epicKey,
    mode: args.mode,
    from: args.days[0] ?? '',
    to: args.days[args.days.length - 1] ?? '',
    series,
    markers: buildMarkers(args.snapshots, args.planShifts),
    planShiftSummary: summarizeShifts(args.planShifts, args.rollups),
    dataHealth: {
      missingSnapshotDays,
      ...args.ratios,
    },
    planIsFloating: true,
    planNote: PLAN_FLOATING_NOTE,
    calendarWarnings: [...args.calendar.warnings],
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

function point(
  date: DateOnly,
  planned: number | null,
  actual: number | null,
  isOffDay: boolean,
): ChartPoint {
  return {
    date,
    plannedRemainingHours: planned === null ? null : toHours(planned),
    actualRemainingHours: actual === null ? null : toHours(actual),
    varianceHours: planned === null || actual === null ? null : toHours(planned - actual),
    isOffDay,
  };
}

/**
 * Bối cảnh chiếu đường Kế hoạch cho những ngày NGOÀI khoảng snapshot — trước
 * snapshot đầu tiên và sau snapshot cuối cùng.
 *
 * Đường Thực tế chỉ có ở những ngày đã chốt snapshot; ngoài khoảng đó nó để
 * `null` — tương lai chưa xảy ra, quá khứ trước khi theo dõi thì không có số đo.
 * Nhưng đường Kế hoạch mà cũng dừng theo thì PM không thấy kế hoạch dự kiến kết
 * thúc khi nào (đuôi sau), lẫn kế hoạch của quãng trước khi Epic bắt đầu được
 * chốt snapshot (đuôi trước). Cả hai đuôi tính từ rollup hiện tại bằng đúng công
 * thức T-16 mà worker dùng khi dựng snapshot, nên nối liền mạch với điểm biên.
 */
interface PlanProjection {
  readonly calendar: WorkCalendar;
  readonly rollups: readonly PhaseRollup[];
  /** Snapshot SỚM NHẤT — mốc dưới của vùng chiếu ngược đường Kế hoạch. `null` = chưa có snapshot. */
  readonly firstSnapshot: SnapshotRow | null;
  readonly lastSnapshot: SnapshotRow | null;
}

function latestSnapshot(snapshots: readonly SnapshotRow[]): SnapshotRow | null {
  let latest: SnapshotRow | null = null;
  for (const s of snapshots) {
    if (latest === null || s.snapshotDate > latest.snapshotDate) latest = s;
  }
  return latest;
}

function earliestSnapshot(snapshots: readonly SnapshotRow[]): SnapshotRow | null {
  let earliest: SnapshotRow | null = null;
  for (const s of snapshots) {
    if (earliest === null || s.snapshotDate < earliest.snapshotDate) earliest = s;
  }
  return earliest;
}

/**
 * Ngày này nằm NGOÀI khoảng đã có snapshot — trước cái đầu tiên hoặc sau cái
 * cuối cùng — hay Epic chưa có snapshot nào?
 *
 * Ở vùng ngoài này đường Kế hoạch được CHIẾU từ rollup hiện tại (đường Thực tế
 * để `null`): phía sau cho thấy kế hoạch dự kiến kết thúc khi nào, phía trước vẽ
 * trọn kế hoạch của quãng trước khi Epic bắt đầu được chốt snapshot. Lỗ thủng
 * GIỮA hai đầu snapshot thì KHÔNG chiếu đè — giữ nguyên `null` (E-12).
 */
function isOutsideSnapshotRange(date: DateOnly, projection: PlanProjection): boolean {
  const { firstSnapshot, lastSnapshot } = projection;
  if (firstSnapshot === null || lastSnapshot === null) return true;
  return date < firstSnapshot.snapshotDate || date > lastSnapshot.snapshotDate;
}

/**
 * Tổng phạm vi để chiếu đường Kế hoạch ở vùng ngoài snapshot.
 *
 * Lấy theo snapshot MỚI NHẤT để cả hai đuôi chiếu — trước cái đầu và sau cái
 * cuối — cùng dựa trên một phạm vi: đường Kế hoạch phản ánh phạm vi HIỆN TẠI của
 * Epic, không phải phạm vi tại một mốc lịch sử. Epic chưa có snapshot nào thì lấy
 * tổng ước lượng từ rollup.
 */
function epicProjectionScope(projection: PlanProjection): number {
  return (
    projection.lastSnapshot?.totalScopeS ??
    projection.rollups.reduce((sum, r) => sum + r.totalOriginalS, 0)
  );
}

function epicSeries(
  days: readonly DateOnly[],
  workdaySet: ReadonlySet<DateOnly>,
  byDate: ReadonlyMap<string, SnapshotRow>,
  projection: PlanProjection,
): ChartSeries {
  return {
    key: 'EPIC',
    label: 'Whole Epic',
    colorHex: null,
    points: days.map((date) => {
      const isOffDay = !workdaySet.has(date);
      // Ngày nghỉ có snapshot mang SỐ THẬT: team làm Thứ 7/CN thì đường Thực tế
      // giảm đúng hôm đó (2026-08), không dồn vào sáng hôm sau.
      const snap = byDate.get(date);
      if (snap !== undefined) return point(date, snap.plannedRemainingS, snap.actualRemainingS, isOffDay);

      // NGOÀI khoảng snapshot — TRƯỚC cái đầu tiên hoặc SAU cái cuối cùng: chiếu
      // đường Kế hoạch từ rollup hiện tại, đường Thực tế để `null`. Phía sau cho
      // PM thấy kế hoạch dự kiến kết thúc khi nào; phía trước vẽ trọn kế hoạch
      // của quãng TRƯỚC snapshot đầu tiên — nếu bỏ trống, một Phase có plan_start
      // sớm hơn snapshot đầu sẽ thành khoảng trống ngay mép trái trục (trục lấy
      // MIN plan_start làm cận dưới, nhưng đường lại bắt đầu muộn hơn).
      if (isOutsideSnapshotRange(date, projection)) {
        const planned = computePlannedRemaining(
          projection.rollups,
          epicProjectionScope(projection),
          date,
          projection.calendar,
        );
        return point(date, planned.seconds, null, isOffDay);
      }

      // Thiếu snapshot GIỮA hai đầu đã chốt sổ trả `null` — LỖ THỦNG NHÌN THẤY
      // ĐƯỢC. Nối tắt hai điểm bên cạnh trông đẹp hơn nhưng là bịa ra một tiến độ
      // không có thật. (Ngày nghỉ chưa có snapshot cũng trả `null`: tầng hiển
      // thị tự kéo phẳng, API không bịa số hộ.)
      return point(date, null, null, isOffDay);
    }),
  };
}

function phaseSeries(
  phaseCode: string,
  days: readonly DateOnly[],
  workdaySet: ReadonlySet<DateOnly>,
  byDate: ReadonlyMap<string, SnapshotRow>,
  labels: BuildChartArgs['labels'],
  projection: PlanProjection,
): ChartSeries {
  const rollup = projection.rollups.find((r) => r.phaseCode === phaseCode) ?? null;

  return {
    key: phaseCode,
    label: labels?.[phaseCode]?.label ?? phaseCode,
    colorHex: labels?.[phaseCode]?.colorHex ?? null,
    points: days.map((date) => {
      const isOffDay = !workdaySet.has(date);
      const snap = byDate.get(date);
      if (snap !== undefined) {
        // Số của Phase lấy TỪ `per_phase`, không lấy số mức Epic. Phase vắng mặt
        // trong ngày đó nghĩa là chưa có Sub-task nào — cũng là một lỗ thủng thật.
        const p = snap.perPhase.find((x) => x.phaseCode === phaseCode);
        return p === undefined
          ? point(date, null, null, isOffDay)
          : point(date, p.plannedRemainingS, p.remainingS, isOffDay);
      }

      // NGOÀI khoảng snapshot (trước cái đầu / sau cái cuối): mỗi Phase tự chiếu
      // đường Kế hoạch trên phạm vi của chính nó, đúng cách worker tính
      // `per_phase.plannedRemainingS` (T-17). Phía trước vẽ như phía sau — xem
      // giải thích ở `epicSeries`.
      if (rollup !== null && isOutsideSnapshotRange(date, projection)) {
        const scopeS =
          projection.lastSnapshot?.perPhase.find((x) => x.phaseCode === phaseCode)?.originalS ??
          rollup.totalOriginalS;
        const planned = computePlannedRemaining([rollup], scopeS, date, projection.calendar);
        // Phase thiếu ngày kế hoạch → không đoán bừa (C-10), giữ nguyên `null`.
        return planned.skippedPhases.length > 0
          ? point(date, null, null, isOffDay)
          : point(date, planned.seconds, null, isOffDay);
      }

      // Lỗ thủng GIỮA hai đầu snapshot, hoặc Phase không có rollup → `null`.
      return point(date, null, null, isOffDay);
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
