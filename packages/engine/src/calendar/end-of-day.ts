import { DateTime } from 'luxon';
import type { DateOnly } from '@app/shared';

/**
 * Mốc chốt sổ của một ngày — PRD §9.4.
 *
 * "Ngày 10/03" của một Epic ở Việt Nam kết thúc lúc **23:59:59.999 giờ Việt
 * Nam**, tức 16:59:59.999 UTC. Cùng ngày đó với Epic ở Nhật lại kết thúc lúc
 * 14:59:59.999 UTC. Hai mốc khác nhau, và dùng nhầm sẽ kéo worklog của ngày này
 * sang ngày khác.
 */

export class InvalidDateError extends Error {
  constructor(
    message: string,
    public readonly value: string,
  ) {
    super(message);
    this.name = 'InvalidDateError';
  }
}

/**
 * Mốc chốt sổ, tính bằng mili-giây UTC.
 *
 * PHẢI gắn múi giờ NGAY LÚC phân tích chuỗi:
 *
 *   ✅ DateTime.fromISO(d, { zone: tz }).endOf('day')
 *   ❌ DateTime.fromISO(d).setZone(tz).endOf('day')
 *
 * Cách sai diễn giải `'2026-03-10'` theo giờ **máy chủ** rồi mới đổi múi — máy
 * chủ ở múi giờ khác sẽ ra lệch hẳn một ngày. Lỗi này không bao giờ lộ ra khi
 * dev chạy máy ở Việt Nam.
 */
export function endOfDayUtcMs(date: DateOnly, timezone: string): number {
  const dt = DateTime.fromISO(date, { zone: timezone });
  if (!dt.isValid) {
    throw new InvalidDateError(
      `Cannot parse the date "${date}" in timezone "${timezone}": ${dt.invalidReason ?? 'unknown reason'}.`,
      date,
    );
  }
  return dt.endOf('day').toUTC().toMillis();
}

/** Mốc BẮT ĐẦU ngày — cận dưới của khoảng chứa worklog thuộc ngày đó. */
export function startOfDayUtcMs(date: DateOnly, timezone: string): number {
  const dt = DateTime.fromISO(date, { zone: timezone });
  if (!dt.isValid) {
    throw new InvalidDateError(
      `Cannot parse the date "${date}" in timezone "${timezone}": ${dt.invalidReason ?? 'unknown reason'}.`,
      date,
    );
  }
  return dt.startOf('day').toUTC().toMillis();
}

/**
 * Một mốc thời gian UTC rơi vào NGÀY ĐỊA PHƯƠNG nào.
 *
 * Dùng để xếp worklog vào đúng ngày: worklog thuộc ngày `d` nếu `started` nằm
 * trong `[00:00:00, 23:59:59.999]` giờ địa phương của `d` (PRD §9.4).
 */
export function localDateOf(utcMs: number, timezone: string): DateOnly {
  return DateTime.fromMillis(utcMs, { zone: 'utc' }).setZone(timezone).toFormat('yyyy-MM-dd');
}
