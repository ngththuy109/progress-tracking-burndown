import type { PrismaClient } from '@app/db';
import {
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
 * route (quyền theo tenant, lan truyền cache) và repository (transaction import).
 */
export function createCalendarStore(prisma: PrismaClient): CalendarStore {
  return {
    list: (forProject) => listCalendarsWithHolidayMeta(prisma, forProject),
    // `owner` thay cho `exists` cũ: multi-tenant cần biết lịch là built-in
    // (project_key NULL) hay của dự án nào để quyết ai nhìn thấy / ai sửa được.
    async owner(calendarId) {
      const row = await prisma.workCalendar.findUnique({
        where: { calendarId },
        select: { projectKey: true },
      });
      return row === null ? null : { projectKey: row.projectKey };
    },
    holidays: (calendarId, year) => listHolidays(prisma, calendarId, year),
    importHolidays: (args) => importHolidays(prisma, args),
    deleteHoliday: (calendarId, date) => deleteHoliday(prisma, calendarId, date),
    makeupWorkdays: (calendarId, year) => listMakeupWorkdays(prisma, calendarId, year),
    importMakeupWorkdays: (args) => importMakeupWorkdays(prisma, args),
    deleteMakeupWorkday: (calendarId, date) => deleteMakeupWorkday(prisma, calendarId, date),
    epicsUsing: (calendarId) => epicKeysUsingCalendar(prisma, calendarId),
  };
}
