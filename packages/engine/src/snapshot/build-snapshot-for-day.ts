import type {
  DailySnapshotData,
  DateOnly,
  PhaseRollup,
  PhaseSnapshot,
  StatusCategory,
  StatusIdMap,
  SubtaskRecord,
  WorkCalendar,
} from '@app/shared';
import { endOfDayUtcMs } from '../calendar/end-of-day.js';
import { computePlannedRemaining } from '../planned/compute-planned-remaining.js';
import { resolveHistoricalRemaining } from '../remaining/resolve-historical-remaining.js';
import { resolveOriginalEstimateAt } from '../remaining/resolve-original-estimate-at.js';
import { totalSpentTill } from '../remaining/total-spent-till.js';
import { resolveStatusCategoryAt } from '../status/resolve-status-category.js';

/**
 * Dựng một dòng `daily_snapshot` — PRD §2.4, §4.4.
 *
 * CỘNG DỒN KHÔNG LỌC BỎ GÌ CẢ (C-11, PRD §2.4). Mọi Sub-task thuộc Phase đều
 * được cộng vào, kể cả:
 *   • `sb_parse_status = UNPARSED` (tiêu đề đặt sai)
 *   • thiếu `wbs_start_date` / `wbs_end_date`
 *   • thuộc Phase `UNCLASSIFIED`
 *
 * Công việc là CÓ THẬT và giờ đã log là CÓ THẬT. Loại chúng ra "cho sạch dữ
 * liệu" sẽ làm tổng khối lượng Epic thiếu hụt và đường Burndown sai.
 */

/** Bộ đếm tạm khi cộng dồn — mutable, chỉ sống trong hàm. */
interface PhaseAccumulator {
  remainingS: number;
  spentS: number;
  originalS: number;
  countTodo: number;
  countInProgress: number;
  countDone: number;
}

function emptyAccumulator(): PhaseAccumulator {
  // PHẢI khởi tạo đủ mọi trường về 0. Thiếu một trường thì `undefined + 5` cho
  // `NaN`, và `NaN` lan ra toàn bộ tổng mà không có lỗi nào báo ra.
  return {
    remainingS: 0,
    spentS: 0,
    originalS: 0,
    countTodo: 0,
    countInProgress: 0,
    countDone: 0,
  };
}

export interface BuildSnapshotArgs {
  readonly epicKey: string;
  /**
   * TOÀN BỘ Sub-task của Epic, kể cả cái đã gỡ. Hàm tự lọc theo mốc thời gian —
   * lọc sẵn ở ngoài sẽ làm snapshot của những ngày cũ mất dữ liệu.
   */
  readonly subtasks: readonly SubtaskRecord[];
  readonly phaseRollups: readonly PhaseRollup[];
  readonly dateStr: DateOnly;
  readonly calendar: WorkCalendar;
  readonly statusIdMap: StatusIdMap;
  /** Mốc job ĐỌC dữ liệu từ Jira. Không phải mốc tính xong (E-19). */
  readonly sourceReadAtMs: number;
  /** Snapshot ngày hôm trước, để tính chênh lệch phạm vi. */
  readonly previousTotalScopeS?: number | undefined;
  readonly onWarning?: ((code: string, detail: string) => void) | undefined;
}

export function buildSnapshotForDay(args: BuildSnapshotArgs): DailySnapshotData {
  const { subtasks, phaseRollups, dateStr, calendar, statusIdMap } = args;

  const T = endOfDayUtcMs(dateStr, calendar.timezone);

  // Sub-task ĐANG HOẠT ĐỘNG tại T: đã tạo và chưa bị gỡ.
  //
  // `removedAtMs > T` chứ KHÔNG phải `>=`: dùng `>=` thì snapshot của đúng ngày
  // gỡ vẫn tính Sub-task đó — lệch một ngày.
  const active = subtasks.filter(
    (s) => s.createdAtMs <= T && (s.removedAtMs === null || s.removedAtMs > T),
  );

  const byPhase = new Map<string, PhaseAccumulator>();
  let actualRemainingS = 0;
  let totalSpentS = 0;
  let totalScopeS = 0;
  let countTodo = 0;
  let countInProgress = 0;
  let countDone = 0;

  for (const sub of active) {
    const remaining = resolveHistoricalRemaining(sub, T, statusIdMap, args.onWarning).seconds;
    const spent = totalSpentTill(sub, T);
    const original = resolveOriginalEstimateAt(sub, T, args.onWarning).seconds;
    const category = resolveStatusCategoryAt(sub.changelog, statusIdMap, T, args.onWarning);

    actualRemainingS += remaining;
    totalSpentS += spent;
    totalScopeS += original;

    // Cộng dồn theo `phaseCode` LẤY TỪ TASK CHA, không theo `[Phase]` trong
    // tiêu đề Sub-task (PRD §2.9.2).
    let acc = byPhase.get(sub.phaseCode);
    if (acc === undefined) {
      acc = emptyAccumulator();
      byPhase.set(sub.phaseCode, acc);
    }
    acc.remainingS += remaining;
    acc.spentS += spent;
    acc.originalS += original;

    switch (category) {
      case 'done':
        countDone += 1;
        acc.countDone += 1;
        break;
      case 'indeterminate':
        countInProgress += 1;
        acc.countInProgress += 1;
        break;
      default:
        countTodo += 1;
        acc.countTodo += 1;
        break;
    }
  }

  const planned = computePlannedRemaining(phaseRollups, totalScopeS, dateStr, calendar);

  // Đường Kế hoạch của TỪNG Phase: mỗi Phase tự tính trên phạm vi của chính nó.
  const rollupOf = new Map(phaseRollups.map((r) => [r.phaseCode, r]));
  const perPhase: PhaseSnapshot[] = [...byPhase.entries()]
    .map(([phaseCode, acc]) => {
      const rollup = rollupOf.get(phaseCode);
      const plannedForPhase =
        rollup === undefined
          ? null
          : computePlannedRemaining([rollup], acc.originalS, dateStr, calendar);

      return {
        phaseCode,
        remainingS: acc.remainingS,
        spentS: acc.spentS,
        originalS: acc.originalS,
        countTodo: acc.countTodo,
        countInProgress: acc.countInProgress,
        countDone: acc.countDone,
        // Phase bị bỏ qua vì thiếu ngày kế hoạch → `null`, không vẽ đường Kế
        // hoạch cho Phase đó (C-10).
        plannedRemainingS:
          plannedForPhase === null || plannedForPhase.skippedPhases.length > 0
            ? null
            : plannedForPhase.seconds,
      } satisfies PhaseSnapshot;
    })
    // Thứ tự ổn định để so hai lần chạy có giống nhau từng byte không (C-6).
    .sort((a, b) => a.phaseCode.localeCompare(b.phaseCode));

  const scope = diffScopeAgainstPreviousDay(args.previousTotalScopeS, totalScopeS);

  return {
    epicKey: args.epicKey,
    snapshotDate: dateStr,
    snapshotAtUtcMs: T,
    plannedRemainingS: planned.seconds,
    actualRemainingS,
    totalScopeS,
    totalSpentS,
    scopeAddedS: scope.addedS,
    scopeRemovedS: scope.removedS,
    countTodo,
    countInProgress,
    countDone,
    perPhase,
    sourceReadAtMs: args.sourceReadAtMs,
  };
}

/**
 * Chênh lệch phạm vi so với NGÀY HÔM TRƯỚC — không so với baseline.
 *
 * Ngày đầu tiên (chưa có snapshot trước) trả 0/0: coi toàn bộ phạm vi ban đầu
 * là "vừa phát sinh" sẽ tạo một dấu mốc giả to đùng ở ngày đầu biểu đồ.
 */
export function diffScopeAgainstPreviousDay(
  previousTotalScopeS: number | undefined,
  currentTotalScopeS: number,
): { addedS: number; removedS: number } {
  if (previousTotalScopeS === undefined) return { addedS: 0, removedS: 0 };

  const delta = currentTotalScopeS - previousTotalScopeS;
  return delta >= 0 ? { addedS: delta, removedS: 0 } : { addedS: 0, removedS: -delta };
}

/** Nhóm trạng thái sang tên cột đếm — dùng chung để khỏi lệch cách phân loại. */
export function countKeyOf(category: StatusCategory): 'countTodo' | 'countInProgress' | 'countDone' {
  if (category === 'done') return 'countDone';
  if (category === 'indeterminate') return 'countInProgress';
  return 'countTodo';
}
