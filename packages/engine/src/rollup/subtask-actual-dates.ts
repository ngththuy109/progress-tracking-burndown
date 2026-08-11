import type { StatusIdMap, SubtaskActualDates, SubtaskRecord } from '@app/shared';
import { findFirstInProgressMs, findLastDoneMs } from '../status/resolve-status-category.js';
import { localDateOf } from '../calendar/end-of-day.js';

/**
 * Ngày bắt đầu / kết thúc THỰC TẾ của một Sub-task — PRD §2.7.2.
 *
 * Jira không có sẵn hai trường này, phải suy ra từ lịch sử. Worklog là nguồn
 * đáng tin nhất (giờ được log là việc đã thật sự làm), changelog trạng thái chỉ
 * dùng khi không có worklog nào.
 *
 *   actual_start: worklog sớm nhất → lần đầu In Progress → ngày Done (nếu đã
 *                 Done mà không có cả hai nguồn kia).
 *   actual_end:   CHƯA Done → null, không tạm tính. Đã Done → worklog muộn
 *                 nhất; không có worklog thì lấy ngày Done.
 */
export function resolveSubtaskActualDates(
  sub: SubtaskRecord,
  statusIdMap: StatusIdMap,
  timezone: string,
): SubtaskActualDates {
  const firstWorklogMs = firstActiveWorklogMs(sub);
  const lastWorklogMs = lastActiveWorklogMs(sub);

  // Lần chuyển sang Done CUỐI CÙNG, không phải lần đầu. Task Done 12/03, mở
  // lại 13/03, Done lại 16/03 thì ngày Done thật là 16/03 (E-13). Lấy lần đầu
  // sẽ mất trắng 4 ngày làm lại — và lỗi đó im lặng, biểu đồ vẫn vẽ bình thường.
  const lastDoneMs = findLastDoneMs(sub.changelog, statusIdMap);

  // --- actual_start ---
  // Đã Done mà không có worklog lẫn lần chuyển In Progress (chuyển thẳng sang
  // Done, quên log giờ) thì coi như bắt đầu đúng ngày Done — task 0 ngày còn
  // hơn task không có ngày bắt đầu.
  const startMs =
    firstWorklogMs ?? findFirstInProgressMs(sub.changelog, statusIdMap) ?? lastDoneMs;

  // --- actual_end ---
  // Chưa Done thì KHÔNG tạm tính ngày kết thúc — trả null, tầng hiển thị ghi
  // "chưa tính". Đã Done thì tin worklog muộn nhất hơn ngày bấm Done: log cuối
  // 14/03 mà 16/03 mới bấm Done nghĩa là việc xong từ 14/03.
  const endMs = lastDoneMs === null ? null : (lastWorklogMs ?? lastDoneMs);

  return {
    actualStart: startMs === null ? null : localDateOf(startMs, timezone),
    actualEnd: endMs === null ? null : localDateOf(endMs, timezone),
    // `true` = chưa từng Done. Khi đó `actualEnd` luôn là null.
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
