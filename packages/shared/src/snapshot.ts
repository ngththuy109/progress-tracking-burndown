import type { DateOnly } from './calendar.js';

/**
 * Snapshot chốt sổ một ngày — PRD §2.4, §4.4.
 *
 * Khớp cột bảng `daily_snapshot` (T-02). Mọi giá trị thời lượng là **giây** (C-2).
 */

export interface PhaseSnapshot {
  readonly phaseCode: string;
  readonly remainingS: number;
  readonly spentS: number;
  readonly originalS: number;
  readonly countTodo: number;
  readonly countInProgress: number;
  readonly countDone: number;
  /** `null` khi Phase thiếu ngày kế hoạch — không vẽ đường Kế hoạch cho Phase đó. */
  readonly plannedRemainingS: number | null;
}

export interface DailySnapshotData {
  readonly epicKey: string;
  readonly snapshotDate: DateOnly;
  /** 23:59:59.999 giờ địa phương của ngày đó, quy về UTC. */
  readonly snapshotAtUtcMs: number;

  readonly plannedRemainingS: number;
  readonly actualRemainingS: number;

  /**
   * Tổng ước lượng của Sub-task ĐANG HOẠT ĐỘNG tại mốc này.
   *
   * KHÔNG phải "phạm vi đóng băng" — baseline đã bị bỏ (PRD §4.3).
   */
  readonly totalScopeS: number;
  readonly totalSpentS: number;

  /** Chênh lệch so với snapshot NGÀY HÔM TRƯỚC, không so với baseline. */
  readonly scopeAddedS: number;
  readonly scopeRemovedS: number;

  readonly countTodo: number;
  readonly countInProgress: number;
  readonly countDone: number;

  readonly perPhase: readonly PhaseSnapshot[];

  /**
   * Mốc job ĐỌC dữ liệu từ Jira — khác với lúc TÍNH xong.
   *
   * Dùng để chống ghi đè bằng dữ liệu cũ (E-19): job đọc lúc 00:01 nhưng ghi
   * sau job đọc lúc 00:03 thì KHÔNG được thắng.
   */
  readonly sourceReadAtMs: number;
}
