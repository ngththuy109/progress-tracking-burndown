import type { Holiday, HolidayImportMode } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Ghi/đọc bảng `calendar_holiday` — T-36.
 *
 * Đây là "card vận hành" mà T-02 và T-12 còn nợ: hai card đó tạo bảng và đọc
 * bảng, nhưng chưa có đường nào NẠP dữ liệu vào. Hệ quả là danh sách ngày lễ
 * luôn rỗng và đường Kế hoạch cháy đều qua cả tuần nghỉ Tết (E-14).
 *
 * Cột `holiday_date` là `DATE`: Prisma nhận/trả mốc nửa đêm UTC. Quy ước ở đây
 * giống `calendar.repository.ts` — `'2026-02-17'` là NGÀY DƯƠNG LỊCH ở mọi múi
 * giờ dùng lịch này, không phải một khoảnh khắc; tuyệt đối không đổi múi giờ.
 */

function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface CalendarWithHolidayMeta {
  readonly calendarId: string;
  readonly timezone: string;
  readonly workdaysMask: number;
  readonly hoursPerDay: number;
  readonly holidayCount: number;
  readonly years: number[];
  readonly makeupWorkdayCount: number;
  readonly makeupYears: number[];
}

/**
 * Danh sách lịch kèm số ngày lễ & ngày làm bù đã khai — cho `GET /api/calendars`.
 *
 * `forProject` (multi-tenant, tuỳ chọn — bỏ qua = mọi lịch, giữ hành vi cũ):
 *   - `null`  → chỉ lịch built-in (`project_key IS NULL`);
 *   - `'PAY'` → built-in + lịch riêng của dự án PAY.
 */
export async function listCalendarsWithHolidayMeta(
  prisma: PrismaClient,
  forProject?: string | null,
): Promise<CalendarWithHolidayMeta[]> {
  const rows = await prisma.workCalendar.findMany({
    ...(forProject === undefined
      ? {}
      : {
          where: {
            OR: [
              { projectKey: null },
              ...(forProject === null ? [] : [{ projectKey: forProject }]),
            ],
          },
        }),
    include: {
      holidays: { select: { holidayDate: true } },
      makeupWorkdays: { select: { workDate: true } },
    },
    orderBy: { calendarId: 'asc' },
  });

  return rows.map((r) => ({
    calendarId: r.calendarId,
    timezone: r.timezone,
    workdaysMask: r.workdaysMask,
    hoursPerDay: Number(r.hoursPerDay),
    holidayCount: r.holidays.length,
    years: [...new Set(r.holidays.map((h) => h.holidayDate.getUTCFullYear()))].sort(
      (a, b) => a - b,
    ),
    makeupWorkdayCount: r.makeupWorkdays.length,
    makeupYears: [...new Set(r.makeupWorkdays.map((m) => m.workDate.getUTCFullYear()))].sort(
      (a, b) => a - b,
    ),
  }));
}

export async function calendarExists(prisma: PrismaClient, calendarId: string): Promise<boolean> {
  const row = await prisma.workCalendar.findUnique({
    where: { calendarId },
    select: { calendarId: true },
  });
  return row !== null;
}

/** Ngày lễ của một lịch, lọc theo năm nếu có. Sắp theo ngày tăng dần. */
export async function listHolidays(
  prisma: PrismaClient,
  calendarId: string,
  year: number | null,
): Promise<Holiday[]> {
  const rows = await prisma.calendarHoliday.findMany({
    where: {
      calendarId,
      ...(year === null
        ? {}
        : { holidayDate: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) } }),
    },
    orderBy: { holidayDate: 'asc' },
  });
  return rows.map((r) => ({ date: toDateOnly(r.holidayDate), label: r.label }));
}

export interface ImportHolidaysResult {
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
}

/**
 * Import ngày lễ — MỘT transaction, tất cả hoặc không (C-6).
 *
 * `MERGE`: ghi đè từng ngày có trong danh sách (đổi được nhãn), giữ nguyên
 * những ngày không nhắc tới. `REPLACE_YEAR`: xoá sạch ngày lễ của `year` rồi
 * chèn lại — import lại một năm không bị sót ngày đã bỏ khỏi danh sách.
 *
 * Chạy lại cùng một danh sách cho ra cùng kết quả cuối — idempotent theo nghĩa
 * trạng thái, còn số đếm trả về phản ánh đúng những gì lần chạy đó làm.
 */
export async function importHolidays(
  prisma: PrismaClient,
  args: {
    calendarId: string;
    mode: HolidayImportMode;
    year: number | null;
    holidays: readonly Holiday[];
  },
): Promise<ImportHolidaysResult> {
  const { calendarId, mode, year } = args;

  // Khử trùng lặp trong input — dán từ Excel rất hay dính ngày lặp. Dòng SAU
  // thắng, khớp trực giác "sửa dòng dưới cùng là bản cuối".
  const byDate = new Map<string, Holiday>();
  for (const h of args.holidays) byDate.set(h.date, h);
  const unique = [...byDate.values()];

  return prisma.$transaction(async (tx) => {
    const existing = await tx.calendarHoliday.findMany({
      where:
        mode === 'REPLACE_YEAR'
          ? {
              calendarId,
              holidayDate: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) },
            }
          : { calendarId, holidayDate: { in: unique.map((h) => toDbDate(h.date)) } },
      select: { holidayDate: true },
    });
    const existingDates = new Set(existing.map((r) => toDateOnly(r.holidayDate)));

    // Xoá rồi chèn lại thay vì upsert từng dòng: bảng khoá theo (calendar_id,
    // holiday_date) nên hai lệnh gộp này tương đương upsert mà chỉ tốn 2 câu SQL.
    await tx.calendarHoliday.deleteMany({
      where:
        mode === 'REPLACE_YEAR'
          ? {
              calendarId,
              holidayDate: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) },
            }
          : { calendarId, holidayDate: { in: unique.map((h) => toDbDate(h.date)) } },
    });

    await tx.calendarHoliday.createMany({
      data: unique.map((h) => ({
        calendarId,
        holidayDate: toDbDate(h.date),
        label: h.label,
      })),
    });

    const updated = unique.filter((h) => existingDates.has(h.date)).length;
    return {
      inserted: unique.length - updated,
      updated,
      // Chỉ REPLACE_YEAR mới thực sự làm mất ngày: những ngày cũ của năm đó
      // không có mặt trong danh sách mới.
      deleted: mode === 'REPLACE_YEAR' ? existingDates.size - updated : 0,
    };
  });
}

/** Xoá một ngày lễ. Trả `0` nếu ngày đó vốn không tồn tại — không ném lỗi. */
export async function deleteHoliday(
  prisma: PrismaClient,
  calendarId: string,
  date: string,
): Promise<number> {
  const result = await prisma.calendarHoliday.deleteMany({
    where: { calendarId, holidayDate: toDbDate(date) },
  });
  return result.count;
}

/**
 * Epic đang dùng một lịch — để sau khi sửa ngày lễ biết phải xoá cache biểu đồ
 * và đánh dấu tính lại cho những Epic nào.
 */
export async function epicKeysUsingCalendar(
  prisma: PrismaClient,
  calendarId: string,
): Promise<{ all: string[]; active: string[] }> {
  const rows = await prisma.trackedEpic.findMany({
    where: { calendarId },
    select: { epicKey: true, status: true },
    orderBy: { epicKey: 'asc' },
  });
  return {
    all: rows.map((r) => r.epicKey),
    active: rows.filter((r) => r.status === 'ACTIVE').map((r) => r.epicKey),
  };
}
