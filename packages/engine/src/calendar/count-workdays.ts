import { DateTime } from 'luxon';
import type { DateOnly, WorkCalendar } from '@app/shared';
import { InvalidDateError } from './end-of-day.js';

/**
 * Đếm và liệt kê ngày làm việc — PRD §4.4, E-14.
 *
 * Vì sao phải loại ngày lễ: nếu đường Kế hoạch vẫn giảm đều trong tuần Tết thì
 * PM sẽ nhìn thấy một khoảng tụt dốc và tưởng team đang chậm nghiêm trọng —
 * trong khi cả công ty đang nghỉ.
 */

/** Chặn trên số ngày duyệt qua, phòng khoảng ngày vô lý làm treo vòng lặp. */
export const MAX_DAYS_IN_RANGE = 366 * 5;

function parse(date: DateOnly, timezone: string): DateTime {
  const dt = DateTime.fromISO(date, { zone: timezone });
  if (!dt.isValid) {
    throw new InvalidDateError(
      `Không đọc được ngày "${date}" ở múi giờ "${timezone}": ${dt.invalidReason ?? 'không rõ'}.`,
      date,
    );
  }
  return dt.startOf('day');
}

/**
 * Ngày này có phải ngày làm việc không.
 *
 * `dt.weekday` của luxon: T2 = 1 … CN = 7. Bit tương ứng là `weekday - 1`.
 * `Date.getDay()` của JavaScript đánh số khác (CN = 0) — dùng nhầm lệch cả tuần.
 *
 * Thứ tự ưu tiên:
 *  1. NGÀY LỄ luôn thắng → nghỉ, kể cả khi lỡ khai làm bù trùng ngày.
 *  2. NGÀY LÀM BÙ → làm việc, kể cả khi mask coi là cuối tuần (đó chính là mục
 *     đích: bù cho một ngày nghỉ khác). Đường Kế hoạch vẫn giảm trên ngày này.
 *  3. Còn lại theo mask ngày làm việc.
 */
export function isWorkday(date: DateOnly, calendar: WorkCalendar): boolean {
  if (calendar.holidays.has(date)) return false;
  if (calendar.makeupWorkdays?.has(date) === true) return true;
  const dt = parse(date, calendar.timezone);
  const bit = 1 << (dt.weekday - 1);
  return (calendar.workdaysMask & bit) !== 0;
}

/**
 * Liệt kê ngày làm việc trong khoảng, **bao gồm cả hai đầu**.
 *
 * `to < from` trả mảng rỗng, KHÔNG ném lỗi và cũng không đảo hai đầu: đảo ngầm
 * sẽ giấu mất lỗi ở chỗ gọi.
 */
export function listWorkdays(
  from: DateOnly,
  to: DateOnly,
  calendar: WorkCalendar,
): DateOnly[] {
  const start = parse(from, calendar.timezone);
  const end = parse(to, calendar.timezone);
  if (end < start) return [];

  const out: DateOnly[] = [];
  let cursor = start;
  let guard = 0;

  while (cursor <= end) {
    if (guard++ > MAX_DAYS_IN_RANGE) {
      throw new InvalidDateError(
        `Khoảng ${from} → ${to} dài quá ${MAX_DAYS_IN_RANGE} ngày. ` +
          `Nhiều khả năng là lỗi dữ liệu chứ không phải khoảng thật.`,
        `${from}..${to}`,
      );
    }
    // Định dạng lại từ chính `cursor` chứ không cộng chuỗi — luxon lo phần
    // chuyển ngày, kể cả qua mốc DST của những múi giờ có DST.
    const iso = cursor.toFormat('yyyy-MM-dd');
    if (isWorkday(iso, calendar)) out.push(iso);
    cursor = cursor.plus({ days: 1 });
  }

  return out;
}

/**
 * Liệt kê MỌI ngày lịch trong khoảng, bao gồm cả hai đầu — kể cả cuối tuần và
 * ngày lễ.
 *
 * Sinh ra cho quyết định 2026-08: snapshot được chốt cho CẢ ngày nghỉ để giờ
 * log vào Thứ 7/CN hiện đúng ngày trên đường Thực tế (trước đây dồn hết vào
 * sáng Thứ 2), và trục biểu đồ vẽ đủ ngày lịch với ngày nghỉ bôi xám.
 *
 * `to < from` trả mảng rỗng, cùng quy ước với `listWorkdays`.
 */
export function listCalendarDays(from: DateOnly, to: DateOnly, timezone: string): DateOnly[] {
  const start = parse(from, timezone);
  const end = parse(to, timezone);
  if (end < start) return [];

  const out: DateOnly[] = [];
  let cursor = start;
  let guard = 0;

  while (cursor <= end) {
    if (guard++ > MAX_DAYS_IN_RANGE) {
      throw new InvalidDateError(
        `Khoảng ${from} → ${to} dài quá ${MAX_DAYS_IN_RANGE} ngày. ` +
          `Nhiều khả năng là lỗi dữ liệu chứ không phải khoảng thật.`,
        `${from}..${to}`,
      );
    }
    out.push(cursor.toFormat('yyyy-MM-dd'));
    cursor = cursor.plus({ days: 1 });
  }

  return out;
}

/**
 * Đếm ngày làm việc, bao gồm cả hai đầu.
 *
 * `to < from` trả **0**, không trả số âm. Số âm sẽ khiến đường Kế hoạch ở T-16
 * đi LÊN thay vì xuống, mà không có lỗi nào báo ra.
 */
export function countWorkdays(from: DateOnly, to: DateOnly, calendar: WorkCalendar): number {
  return listWorkdays(from, to, calendar).length;
}

/**
 * Ngày làm việc thứ `n` tính từ `from` (n bắt đầu từ 0).
 *
 * `null` khi khoảng không đủ dài — chỗ gọi phải xử lý tường minh thay vì nhận
 * một ngày bịa ra.
 */
export function addWorkdays(
  from: DateOnly,
  workdays: number,
  calendar: WorkCalendar,
): DateOnly | null {
  if (workdays < 0) return null;

  let cursor = parse(from, calendar.timezone);
  let remaining = workdays;
  let guard = 0;

  for (;;) {
    if (guard++ > MAX_DAYS_IN_RANGE) return null;
    const iso = cursor.toFormat('yyyy-MM-dd');
    if (isWorkday(iso, calendar)) {
      if (remaining === 0) return iso;
      remaining -= 1;
    }
    cursor = cursor.plus({ days: 1 });
  }
}
