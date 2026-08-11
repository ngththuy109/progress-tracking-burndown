import type { PrismaClient } from '@app/db';
import {
  calendarExists,
  deleteHoliday,
  deleteMakeupWorkday,
  epicKeysUsingCalendar,
  importHolidays,
  importMakeupWorkdays,
  listCalendarsWithHolidayMeta,
  listHolidays,
  listMakeupWorkdays,
} from '@app/db';
import type { CalendarStore } from '../routes/calendars.routes.js';

/**
 * Nối cổng lịch làm việc vào Prisma. Mỏng cố ý — toàn bộ phần đáng test nằm ở
 * route (quyền, lan truyền cache) và repository (transaction import).
 */
export function createCalendarStore(prisma: PrismaClient): CalendarStore {
  return {
    list: () => listCalendarsWithHolidayMeta(prisma),
    exists: (calendarId) => calendarExists(prisma, calendarId),
    holidays: (calendarId, year) => listHolidays(prisma, calendarId, year),
    importHolidays: (args) => importHolidays(prisma, args),
    deleteHoliday: (calendarId, date) => deleteHoliday(prisma, calendarId, date),
    makeupWorkdays: (calendarId, year) => listMakeupWorkdays(prisma, calendarId, year),
    importMakeupWorkdays: (args) => importMakeupWorkdays(prisma, args),
    deleteMakeupWorkday: (calendarId, date) => deleteMakeupWorkday(prisma, calendarId, date),
    epicsUsing: (calendarId) => epicKeysUsingCalendar(prisma, calendarId),
  };
}
