/**
 * Lịch làm việc — PRD §9.4, E-14.
 *
 * PRD gọi múi giờ là "nguồn gốc của phần lớn lỗi khó tìm trong hệ thống
 * time-series". Mọi phép tính ngày của engine đều đi qua đây.
 */

/**
 * Bitmask ngày làm việc, 7 bit.
 *
 * Bit 0 = Thứ Hai … bit 6 = Chủ nhật, theo cách đánh số của **luxon**
 * (`weekday`: T2 = 1 … CN = 7).
 *
 * KHÔNG giống `Date.getDay()` của JavaScript (Chủ nhật = 0). Nhầm chỗ này làm
 * lệch cả tuần, và lỗi nhìn ra rất khó vì kết quả vẫn "có vẻ hợp lý".
 */
export const WORKDAY_BIT = {
  MONDAY: 1 << 0,
  TUESDAY: 1 << 1,
  WEDNESDAY: 1 << 2,
  THURSDAY: 1 << 3,
  FRIDAY: 1 << 4,
  SATURDAY: 1 << 5,
  SUNDAY: 1 << 6,
} as const;

/** T2–T6 = 0b0011111 = 31. Mặc định khi thiếu dữ liệu lịch. */
export const DEFAULT_WORKDAYS_MASK =
  WORKDAY_BIT.MONDAY |
  WORKDAY_BIT.TUESDAY |
  WORKDAY_BIT.WEDNESDAY |
  WORKDAY_BIT.THURSDAY |
  WORKDAY_BIT.FRIDAY;

export const DEFAULT_HOURS_PER_DAY = 8;

export interface WorkCalendar {
  readonly calendarId: string;
  /** Múi giờ IANA, ví dụ `Asia/Ho_Chi_Minh`. */
  readonly timezone: string;
  readonly workdaysMask: number;
  readonly hoursPerDay: number;
  /** Ngày lễ dạng `'YYYY-MM-DD'`. Bỏ qua khi đếm ngày làm việc (E-14). */
  readonly holidays: ReadonlySet<string>;
  /**
   * Cảnh báo phát sinh lúc dựng lịch — ví dụ không tìm thấy lịch nên phải dùng
   * mặc định. Đi kèm dữ liệu chứ không chỉ nằm trong log, để tầng trên hiện được
   * cho người dùng (C-10).
   */
  readonly warnings: readonly string[];
}

/** Ngày thuần, không kèm giờ. Luôn dùng chuỗi `'YYYY-MM-DD'`, không dùng `Date`. */
export type DateOnly = string;

export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(s: string): s is DateOnly {
  return DATE_ONLY_PATTERN.test(s);
}
