import type { HolidayImportMode, MakeupWorkday } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Ghi/đọc bảng `calendar_makeup_workday` — T-39.
 *
 * Song song với `calendar-holiday.repository.ts` nhưng NGƯỢC nghĩa: bảng này giữ
 * những ngày cuối tuần được xếp LÀM VIỆC (làm bù). Cùng khuôn transaction/khử
 * trùng để hành vi import giống hệt ngày lễ — người dùng chỉ cần học một lần.
 *
 * Cột `work_date` là `DATE`: Prisma nhận/trả mốc nửa đêm UTC. `'2026-04-25'` là
 * NGÀY DƯƠNG LỊCH ở mọi múi giờ dùng lịch này — tuyệt đối không đổi múi giờ.
 */

function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Ngày làm bù của một lịch, lọc theo năm nếu có. Sắp theo ngày tăng dần. */
export async function listMakeupWorkdays(
  prisma: PrismaClient,
  calendarId: string,
  year: number | null,
): Promise<MakeupWorkday[]> {
  const rows = await prisma.calendarMakeupWorkday.findMany({
    where: {
      calendarId,
      ...(year === null
        ? {}
        : { workDate: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) } }),
    },
    orderBy: { workDate: 'asc' },
  });
  return rows.map((r) => ({ date: toDateOnly(r.workDate), label: r.label }));
}

export interface ImportMakeupWorkdaysResult {
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
}

/**
 * Import ngày làm bù — MỘT transaction, tất cả hoặc không (C-6). Logic đếm và
 * hai chế độ MERGE / REPLACE_YEAR giống hệt `importHolidays`.
 */
export async function importMakeupWorkdays(
  prisma: PrismaClient,
  args: {
    calendarId: string;
    mode: HolidayImportMode;
    year: number | null;
    makeupWorkdays: readonly MakeupWorkday[];
  },
): Promise<ImportMakeupWorkdaysResult> {
  const { calendarId, mode, year } = args;

  // Khử trùng lặp trong input — dán từ Excel rất hay dính ngày lặp. Dòng SAU
  // thắng, khớp trực giác "sửa dòng dưới cùng là bản cuối".
  const byDate = new Map<string, MakeupWorkday>();
  for (const m of args.makeupWorkdays) byDate.set(m.date, m);
  const unique = [...byDate.values()];

  return prisma.$transaction(async (tx) => {
    const existing = await tx.calendarMakeupWorkday.findMany({
      where:
        mode === 'REPLACE_YEAR'
          ? {
              calendarId,
              workDate: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) },
            }
          : { calendarId, workDate: { in: unique.map((m) => toDbDate(m.date)) } },
      select: { workDate: true },
    });
    const existingDates = new Set(existing.map((r) => toDateOnly(r.workDate)));

    // Xoá rồi chèn lại thay vì upsert từng dòng: bảng khoá theo (calendar_id,
    // work_date) nên hai lệnh gộp này tương đương upsert mà chỉ tốn 2 câu SQL.
    await tx.calendarMakeupWorkday.deleteMany({
      where:
        mode === 'REPLACE_YEAR'
          ? {
              calendarId,
              workDate: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) },
            }
          : { calendarId, workDate: { in: unique.map((m) => toDbDate(m.date)) } },
    });

    await tx.calendarMakeupWorkday.createMany({
      data: unique.map((m) => ({
        calendarId,
        workDate: toDbDate(m.date),
        label: m.label,
      })),
    });

    const updated = unique.filter((m) => existingDates.has(m.date)).length;
    return {
      inserted: unique.length - updated,
      updated,
      deleted: mode === 'REPLACE_YEAR' ? existingDates.size - updated : 0,
    };
  });
}

/** Xoá một ngày làm bù. Trả `0` nếu ngày đó vốn không tồn tại — không ném lỗi. */
export async function deleteMakeupWorkday(
  prisma: PrismaClient,
  calendarId: string,
  date: string,
): Promise<number> {
  const result = await prisma.calendarMakeupWorkday.deleteMany({
    where: { calendarId, workDate: toDbDate(date) },
  });
  return result.count;
}
