import { DateTime } from 'luxon';
import type { DateOnly } from '@app/shared';
import { InvalidDateError } from './end-of-day.js';

/**
 * Khoảng TUẦN (Thứ Hai → Chủ nhật) chứa `date`.
 *
 * Chuẩn Việt Nam là tuần bắt đầu Thứ Hai — trùng với ISO week của luxon, nên
 * `startOf('week')` cho ra Thứ Hai và `+6` ngày là Chủ nhật.
 *
 * HÀM THUẦN, KHÔNG đọc đồng hồ: người gọi truyền vào ngày muốn tính (thường là
 * "hôm nay" đã đổi sang ngày địa phương ở tầng route qua `localDateOf`). Phân
 * tích ở múi giờ 'utc' vì đây chỉ là số học ngày — biên T2..CN như nhau ở mọi
 * múi giờ, và cố định 'utc' để không lỡ phụ thuộc giờ máy chủ.
 */
export function weekOf(date: DateOnly): { from: DateOnly; to: DateOnly } {
  const dt = DateTime.fromISO(date, { zone: 'utc' });
  if (!dt.isValid) {
    throw new InvalidDateError(
      `Không đọc được ngày "${date}": ${dt.invalidReason ?? 'không rõ'}.`,
      date,
    );
  }
  const monday = dt.startOf('week');
  const sunday = monday.plus({ days: 6 });
  return {
    from: monday.toFormat('yyyy-MM-dd'),
    to: sunday.toFormat('yyyy-MM-dd'),
  };
}
