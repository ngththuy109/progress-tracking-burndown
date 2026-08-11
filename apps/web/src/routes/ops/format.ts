/**
 * Ngày giờ ở màn hình Monitoring hiện theo MÚI GIỜ CỦA MÁY NGƯỜI XEM.
 *
 * API trả ISO UTC (`2026-03-10T02:00:00.000Z`) — hiện nguyên chuỗi đó thì người
 * trực ở Hà Nội đọc "2 giờ sáng" trong khi máy họ đang 9 giờ, và mọi suy luận
 * "job chạy lúc nào" lệch đi 7 tiếng. Chuỗi ISO gốc vẫn giữ trong tooltip để
 * đối chiếu với log máy chủ (log ghi UTC).
 */

export interface FormatOptions {
  /** Ghi đè để test không phụ thuộc múi giờ của máy chạy CI. */
  readonly timeZone?: string;
  readonly locale?: string;
}

export function formatLocalDateTime(iso: string, options: FormatOptions = {}): string {
  const date = new Date(iso);
  // Chuỗi không đọc được thì trả nguyên văn — hiện "Invalid Date" là giấu mất
  // manh mối (chuỗi gốc) đúng lúc cần điều tra.
  if (Number.isNaN(date.getTime())) return iso;

  return new Intl.DateTimeFormat(options.locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(options.timeZone !== undefined ? { timeZone: options.timeZone } : {}),
  }).format(date);
}
