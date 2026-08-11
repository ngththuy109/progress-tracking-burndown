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

/** Tên ngắn của từng ngày, đúng thứ tự bit 0..6 (T2..CN) — để hiển thị mask. */
export const WORKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * Giải mã mask thành `"Mon, Tue, …"` để người dùng NHÌN THẤY lịch thật sự nói
 * gì. Mask chỉ là một con số — 63 và 126 trông vô hại như nhau cho tới khi
 * từng ngày được viết ra.
 */
export function describeWorkdaysMask(mask: number): string {
  const names = WORKDAY_NAMES.filter((_, bit) => (mask & (1 << bit)) !== 0);
  return names.length === 0 ? '(no working day)' : names.join(', ');
}

/**
 * Phát hiện mask khả nghi — C-10: cấu hình lịch sai không được im lặng.
 *
 * Hai dấu hiệu:
 *  1. Ngoài khoảng 7 bit (1..127) — bit thứ 7 trở lên không mang nghĩa gì.
 *  2. Thiếu Thứ Hai. Mọi tuần làm việc của hệ thống này đều có Thứ Hai, còn
 *     mask tính theo bit 1-indexed (T2=1<<1 … CN=1<<7) thì LUÔN mất Thứ Hai —
 *     đúng lỗi thực tế đã làm mọi Thứ Hai biến mất khỏi biểu đồ Burndown mà
 *     không một cảnh báo nào kêu lên.
 *
 * Migration `20260811140000_workdays_mask_guard` chặn cả hai ở tầng database;
 * cảnh báo này đỡ cho database chưa áp migration và cho dữ liệu test/fake.
 */
export function workdaysMaskWarning(mask: number): string | null {
  if (!Number.isInteger(mask) || mask < 1 || mask > 127) {
    return (
      `Work calendar has an invalid workdays_mask (${mask}); the valid range is 1–127 ` +
      'with bit 0 = Monday … bit 6 = Sunday. Use 31 for Mon–Fri or 63 for Mon–Sat.'
    );
  }
  if ((mask & WORKDAY_BIT.MONDAY) === 0) {
    return (
      `Work calendar mask ${mask} treats Monday as a day off (working days: ${describeWorkdaysMask(mask)}). ` +
      'This is the signature of a mask computed with 1-indexed weekday bits — the system counts ' +
      'bit 0 = Monday … bit 6 = Sunday, so Mon–Fri is 31 and Mon–Sat is 63. Until the mask is fixed, ' +
      'every Monday silently disappears from the Burndown chart.'
    );
  }
  return null;
}

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
