import type {
  DateOnly,
  GroupRollup,
  PhaseRollup,
  StatusIdMap,
  SubtaskRecord,
  TierNodeSnapshot,
  WorkCalendar,
} from '@app/shared';
import { endOfDayUtcMs } from '../calendar/end-of-day.js';
import { computePlannedRemaining } from '../planned/compute-planned-remaining.js';
import { comparePaths, groupPathOf } from '../parser/group-path.js';
import { accumulateLeafAtDay } from './accumulate-leaf.js';

/**
 * Snapshot một ngày cho MỌI nút prefix N tầng — tổng quát phần `perPhase` của
 * `buildSnapshotForDay` (DYNAMIC-TIERS-DESIGN.md §5).
 *
 * CỘNG DỒN KHÔNG LỌC BỎ (C-11): mọi lá hoạt động tại T cộng vào MỌI nút prefix trên
 * đường đi tới gốc. Config mặc định (1 tầng) ⇒ mỗi lá chỉ một nút `[phaseCode]`, và nút
 * đó cho số liệu y hệt `perPhase` cùng phaseCode — bằng chứng "không đổi hành vi"
 * (kiểm ở build-tier-snapshot.test.ts).
 *
 * Đường Kế hoạch mỗi nút tính trên phạm vi CHÍNH nút đó (đối xứng `perPhase`), lấy ngày
 * kế hoạch từ `groupRollups`. Nút thiếu ngày / bị bỏ qua ⇒ `plannedRemainingS = null`.
 *
 * THUẦN: nhận `dateStr`, không đọc đồng hồ (C-12).
 */

/** Bộ đếm tạm khi cộng dồn một nút — mutable, chỉ sống trong hàm. */
interface NodeAccumulator {
  readonly groupPath: string[];
  remainingS: number;
  spentS: number;
  originalS: number;
  countTodo: number;
  countInProgress: number;
  countDone: number;
}

export interface BuildTierSnapshotArgs {
  /** TOÀN BỘ lá của Epic, kể cả đã gỡ. Hàm tự lọc theo mốc thời gian. */
  readonly subtasks: readonly SubtaskRecord[];
  /** Rollup N tầng (từ `computeGroupRollups`) — cấp ngày kế hoạch cho từng nút. */
  readonly groupRollups: readonly GroupRollup[];
  readonly dateStr: DateOnly;
  readonly calendar: WorkCalendar;
  readonly statusIdMap: StatusIdMap;
  readonly onWarning?: ((code: string, detail: string) => void) | undefined;
}

export function buildTierSnapshotForDay(args: BuildTierSnapshotArgs): TierNodeSnapshot[] {
  const { subtasks, groupRollups, dateStr, calendar, statusIdMap } = args;
  const T = endOfDayUtcMs(dateStr, calendar.timezone);

  // Lá ĐANG HOẠT ĐỘNG tại T: đã tạo và chưa bị gỡ. `removedAtMs > T` (không `>=`) để
  // snapshot của đúng ngày gỡ không còn tính lá đó — cùng luật `buildSnapshotForDay`.
  const active = subtasks.filter(
    (s) => s.createdAtMs <= T && (s.removedAtMs === null || s.removedAtMs > T),
  );

  const byNode = new Map<string, NodeAccumulator>();
  for (const sub of active) {
    const { remaining, spent, original, category } = accumulateLeafAtDay(
      sub,
      T,
      statusIdMap,
      args.onWarning,
    );

    // Cộng vào MỌI nút prefix của vectơ khoá (§2.2). Khoá Map = JSON.stringify(prefix).
    const path = groupPathOf(sub);
    for (let depth = 1; depth <= path.length; depth += 1) {
      const prefix = path.slice(0, depth);
      const key = JSON.stringify(prefix);
      let acc = byNode.get(key);
      if (acc === undefined) {
        acc = {
          groupPath: prefix,
          remainingS: 0,
          spentS: 0,
          originalS: 0,
          countTodo: 0,
          countInProgress: 0,
          countDone: 0,
        };
        byNode.set(key, acc);
      }
      acc.remainingS += remaining;
      acc.spentS += spent;
      acc.originalS += original;
      if (category === 'done') acc.countDone += 1;
      else if (category === 'indeterminate') acc.countInProgress += 1;
      else acc.countTodo += 1;
    }
  }

  // Đường Kế hoạch từng nút: mỗi nút tính trên phạm vi của chính nó, dùng rollup của nút.
  const rollupOf = new Map(groupRollups.map((r) => [JSON.stringify(r.groupPath), r]));

  const out: TierNodeSnapshot[] = [...byNode.values()].map((acc) => {
    const rollup = rollupOf.get(JSON.stringify(acc.groupPath));
    const plannedForNode =
      rollup === undefined
        ? null
        : computePlannedRemaining([asPhaseRollup(rollup)], acc.originalS, dateStr, calendar);

    return {
      tierOrder: acc.groupPath.length,
      groupPath: acc.groupPath,
      remainingS: acc.remainingS,
      spentS: acc.spentS,
      originalS: acc.originalS,
      countTodo: acc.countTodo,
      countInProgress: acc.countInProgress,
      countDone: acc.countDone,
      // Nút thiếu ngày kế hoạch → `null`, không vẽ đường Kế hoạch cho nút đó (C-10).
      plannedRemainingS:
        plannedForNode === null || plannedForNode.skippedPhases.length > 0
          ? null
          : plannedForNode.seconds,
    } satisfies TierNodeSnapshot;
  });

  return out.sort((a, b) => a.tierOrder - b.tierOrder || comparePaths(a.groupPath, b.groupPath));
}

/**
 * `GroupRollup` → hình dạng `PhaseRollup` để dùng lại `computePlannedRemaining` (vốn
 * viết cho tầng Phase). `phaseCode` tổng hợp từ path CHỈ để làm khoá — hàm chỉ đọc
 * `.seconds` và `.skippedPhases.length` của kết quả, không dùng tới khoá đó.
 */
function asPhaseRollup(r: GroupRollup): PhaseRollup {
  return {
    phaseCode: r.groupPath.join(' › '),
    planStart: r.planStart,
    planEnd: r.planEnd,
    planWorkdays: r.planWorkdays,
    actualStart: r.actualStart,
    actualEnd: r.actualEnd,
    actualEndIsProvisional: r.actualEndIsProvisional,
    totalOriginalS: r.totalOriginalS,
    subtaskCount: r.subtaskCount,
    missingDateCount: r.missingDateCount,
    warnings: r.warnings,
  };
}
