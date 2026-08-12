import type { DateOnly } from './calendar.js';

/**
 * Tổng hợp N tầng theo `group_path` — DYNAMIC-TIERS-DESIGN.md §4.3, §5.
 *
 * Tổng quát hoá `PhaseRollup`/`PhaseSnapshot` (khoá theo MỘT `phaseCode`) sang một
 * NÚT bất kỳ trong cây tầng, khoá theo TIỀN TỐ (prefix) của vectơ `group_path`. Cây
 * phân tầng = mọi prefix của vectơ; số liệu của lá cộng vào MỌI nút prefix trên đường
 * đi tới gốc (§2.2). Nút prefix độ dài 1 (tầng Phase, config mặc định) cho số liệu y
 * hệt `PhaseRollup`/`PhaseSnapshot` — đó là bằng chứng "không đổi hành vi".
 *
 * Vòng 2: engine TÍNH được các type này (thêm `computeGroupRollups` /
 * `buildTierSnapshotForDay`); persist + API + UI drill-down để Vòng 3/4.
 */

/** Ngày plan/actual + tổng của MỘT nút prefix — tổng quát `PhaseRollup`. */
export interface GroupRollup {
  /** Độ sâu nút (1 = tầng trên cùng). Luôn bằng `groupPath.length`. */
  readonly tierOrder: number;
  /** Prefix khoá nhóm, độ dài === `tierOrder`. Nút = mọi lá có vectơ bắt đầu bằng prefix này. */
  readonly groupPath: readonly string[];

  /** MIN(`wbsStartDate`) của lá đang hoạt động dưới nút. `null` = mọi lá đều thiếu ngày. */
  readonly planStart: DateOnly | null;
  readonly planEnd: DateOnly | null;
  /** Số ngày làm việc từ `planStart` tới `planEnd`. `null` khi thiếu mốc. */
  readonly planWorkdays: number | null;

  readonly actualStart: DateOnly | null;
  readonly actualEnd: DateOnly | null;
  /** `true` khi CÒN BẤT KỲ lá nào chưa Done. */
  readonly actualEndIsProvisional: boolean;

  readonly totalOriginalS: number;
  readonly subtaskCount: number;
  /** Số lá thiếu `wbsStartDate` HOẶC `wbsEndDate`. */
  readonly missingDateCount: number;

  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

/** Snapshot một ngày của MỘT nút prefix — tổng quát `PhaseSnapshot`. */
export interface TierNodeSnapshot {
  readonly tierOrder: number;
  readonly groupPath: readonly string[];
  readonly remainingS: number;
  readonly spentS: number;
  readonly originalS: number;
  readonly countTodo: number;
  readonly countInProgress: number;
  readonly countDone: number;
  /** `null` khi nút thiếu ngày kế hoạch — không vẽ đường Kế hoạch cho nút đó. */
  readonly plannedRemainingS: number | null;
}
