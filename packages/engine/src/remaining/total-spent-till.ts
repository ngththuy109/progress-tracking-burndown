import type { SubtaskRecord, WorklogRecord } from '@app/shared';

/**
 * Tổng số giây đã log tới mốc `tMs` — PRD §4.3.2.
 *
 * Lọc theo `startedAtMs`, tức trường `started` của Jira, KHÔNG phải `created`
 * (C-1, PRD E-03). Đây là ngày người dùng khai đã làm việc; nhờ vậy giờ log bù
 * cho tuần trước tự động rơi vào đúng tuần trước.
 */
export function totalSpentTill(sub: SubtaskRecord, tMs: number): number {
  let total = 0;

  for (const w of sub.worklogs) {
    // Mảng đã sắp tăng dần theo `startedAtMs` nên vượt mốc là dừng được.
    if (w.startedAtMs > tMs) break;
    // Worklog bị xoá trên Jira vẫn còn dòng trong DB để điều tra (E-17), nhưng
    // KHÔNG còn là giờ có hiệu lực.
    if (w.isDeleted) continue;
    total += w.timeSpentSeconds;
  }

  return total;
}

/**
 * Tổng số giây log trong đúng khoảng `[fromMs, toMs]`.
 *
 * Dùng để tính phần giờ bỏ ra trong MỘT ngày, không phải luỹ kế.
 */
export function spentBetween(
  worklogs: readonly WorklogRecord[],
  fromMs: number,
  toMs: number,
): number {
  let total = 0;
  for (const w of worklogs) {
    if (w.startedAtMs > toMs) break;
    if (w.startedAtMs < fromMs || w.isDeleted) continue;
    total += w.timeSpentSeconds;
  }
  return total;
}
