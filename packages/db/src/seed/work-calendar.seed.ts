import type { PrismaClient } from '../client.js';

/**
 * Bitmask ngày làm việc — 7 bit.
 *
 * Bit 0 = Thứ Hai … bit 6 = Chủ nhật, theo cách đánh số của luxon (T2 = 1 … CN = 7).
 * KHÔNG giống `Date.getDay()` của JavaScript (Chủ nhật = 0) — nhầm chỗ này làm
 * lệch cả tuần và lỗi rất khó nhìn ra.
 *
 * T2–T6 = bit 0..4 = 0b0011111 = 31
 */
export const WORKDAYS_MON_TO_FRI = 0b0011111;

export const DEFAULT_CALENDARS = [
  {
    calendarId: 'VN_STANDARD',
    timezone: 'Asia/Ho_Chi_Minh',
    workdaysMask: WORKDAYS_MON_TO_FRI,
    hoursPerDay: 8.0,
  },
  {
    calendarId: 'JP_STANDARD',
    timezone: 'Asia/Tokyo',
    workdaysMask: WORKDAYS_MON_TO_FRI,
    hoursPerDay: 8.0,
  },
] as const;

/**
 * Seed hai lịch làm việc mặc định.
 *
 * Idempotent (CONVENTIONS.md C-6): chạy lại không nhân đôi.
 *
 * KHÔNG seed ngày lễ ở đây — bảng `calendar_holiday` do card vận hành nạp,
 * vì danh sách ngày lễ đổi theo năm và theo quốc gia.
 */
export async function seedWorkCalendars(prisma: PrismaClient): Promise<void> {
  for (const cal of DEFAULT_CALENDARS) {
    await prisma.workCalendar.upsert({
      where: { calendarId: cal.calendarId },
      create: { ...cal },
      update: {
        timezone: cal.timezone,
        workdaysMask: cal.workdaysMask,
        hoursPerDay: cal.hoursPerDay,
      },
    });
  }
}
