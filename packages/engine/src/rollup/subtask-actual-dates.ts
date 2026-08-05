import type { StatusIdMap, SubtaskActualDates, SubtaskRecord } from '@app/shared';
import { findFirstInProgressMs, findLastDoneMs } from '../status/resolve-status-category.js';
import { localDateOf } from '../calendar/end-of-day.js';

/**
 * Ngày bắt đầu / kết thúc THỰC TẾ của một Sub-task — PRD §2.7.2.
 *
 * Jira không có sẵn hai trường này, phải suy ra từ lịch sử.
 *
 * VÌ SAO KẾT HỢP CẢ TRẠNG THÁI LẪN WORKLOG: chỉ dùng trạng thái thì team quên
 * chuyển trạng thái sẽ không có ngày; chỉ dùng worklog thì task xong mà quên log
 * giờ cũng không có ngày. Lấy nguồn nào sớm hơn phủ được cả hai ca.
 */
export function resolveSubtaskActualDates(
  sub: SubtaskRecord,
  statusIdMap: StatusIdMap,
  timezone: string,
): SubtaskActualDates {
  const firstInProgressMs = findFirstInProgressMs(sub.changelog, statusIdMap);
  const firstWorklogMs = firstActiveWorklogMs(sub);
  const lastWorklogMs = lastActiveWorklogMs(sub);

  // --- actual_start: mốc SỚM HƠN trong hai nguồn ---
  const startMs = minDefined(firstInProgressMs, firstWorklogMs);

  // --- actual_end: lần chuyển sang Done CUỐI CÙNG ---
  //
  // Phải là lần CUỐI, không phải lần đầu. Task Done 12/03, mở lại 13/03, Done
  // lại 16/03 thì ngày kết thúc thật là 16/03 (E-13). Lấy lần đầu sẽ mất trắng
  // 4 ngày làm lại — và lỗi đó im lặng, biểu đồ vẫn vẽ ra bình thường.
  const lastDoneMs = findLastDoneMs(sub.changelog, statusIdMap);

  // Đã Done thì lấy ĐÚNG ngày Done, kể cả khi worklog cuối sớm hơn: task Done
  // ngày 16/03 mà worklog cuối 14/03 thì kết thúc vẫn là 16/03.
  const endMs = lastDoneMs ?? lastWorklogMs;

  return {
    actualStart: startMs === null ? null : localDateOf(startMs, timezone),
    actualEnd: endMs === null ? null : localDateOf(endMs, timezone),
    // Chưa từng Done thì `actualEnd` chỉ là ngày worklog cuối — một phỏng đoán.
    actualEndIsProvisional: lastDoneMs === null,
  };
}

/** Worklog đầu tiên còn hiệu lực. Mảng đã sắp tăng dần theo `startedAtMs`. */
function firstActiveWorklogMs(sub: SubtaskRecord): number | null {
  for (const w of sub.worklogs) {
    if (!w.isDeleted) return w.startedAtMs;
  }
  return null;
}

function lastActiveWorklogMs(sub: SubtaskRecord): number | null {
  for (let i = sub.worklogs.length - 1; i >= 0; i--) {
    const w = sub.worklogs[i]!;
    if (!w.isDeleted) return w.startedAtMs;
  }
  return null;
}

/**
 * Mốc nhỏ hơn trong hai giá trị có thể `null`.
 *
 * `Math.min(null, x)` cho ra 0 vì `null` bị ép thành 0 — nghĩa là ngày
 * 1970-01-01. Phải xử lý `null` tường minh.
 */
function minDefined(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
