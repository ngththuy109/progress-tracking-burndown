import type { StatusIdMap, SubtaskActualDates, SubtaskRecord } from '@app/shared';
import {
  currentStatusCategory,
  findFirstInProgressMs,
  findLastDoneMs,
} from '../status/resolve-status-category.js';
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
  // Ba nguồn theo thứ tự ưu tiên: worklog → lần đầu In Progress → ngày Done.
  //
  // Worklog là bằng chứng chắc chắn nhất (giờ đã log là việc đã thật sự làm),
  // nên nó thắng dù trạng thái hiện tại là gì — vì thế nó đứng đầu chuỗi `??`.
  //
  // Ca chuyển NHẦM sang In Progress rồi kéo lại về Open (To Do): dấu vết In
  // Progress vẫn nằm trong changelog, `findFirstInProgressMs` vẫn thấy — nhưng
  // nếu ticket HIỆN đã về To Do và CHƯA từng Done (không có worklog nào) thì coi
  // như CHƯA bắt đầu, bỏ dấu vết In Progress đó đi. Không chặn thì resync không
  // bao giờ xoá được `actual_start` "ma": biểu đồ vẫn vẽ đường Thực tế và
  // Signboard vẫn báo "đang làm" cho một task đang nằm ở To Do (§6.3, bước 4).
  //
  // Điều kiện phải là "chưa từng Done", KHÔNG chỉ "hiện là To Do": task
  // To Do→In Progress→Done→To Do (kéo về backlog sau khi đã xong) vẫn là việc
  // THẬT, phải giữ ngày bắt đầu chính xác từ lần In Progress đầu. `lastDoneMs`
  // là bằng chứng đã hoàn thành, tương đương worklog ở điểm này.
  //
  // Đã Done mà không có worklog lẫn lần chuyển In Progress (chuyển thẳng sang
  // Done, quên log giờ) thì coi như bắt đầu đúng ngày Done — task 0 ngày còn
  // hơn task không có ngày bắt đầu. Vì `lastDoneMs` vẫn khép chuỗi nên bất biến
  // "start = null ⟹ end = null" luôn đúng: start chỉ null khi lastDoneMs cũng null.
  const revertedToTodoUntouched =
    lastDoneMs === null && currentStatusCategory(sub.changelog, statusIdMap) === 'new';
  const inProgressMs = revertedToTodoUntouched
    ? null
    : findFirstInProgressMs(sub.changelog, statusIdMap);
  const startMs = firstWorklogMs ?? inProgressMs ?? lastDoneMs;

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
