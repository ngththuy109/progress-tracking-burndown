import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../client.js';
import {
  importHolidays,
  listCalendarsWithHolidayMeta,
} from './calendar-holiday.repository.js';

/**
 * Test repository ngày lễ — T-36, không cần PostgreSQL.
 *
 * Thứ đáng kiểm chứng: cách khử trùng lặp input, cách đếm thêm/ghi đè/xoá ở
 * hai chế độ MERGE / REPLACE_YEAR, và việc ngày dương lịch không bị đổi múi
 * giờ — không phải bản thân câu SQL.
 */

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Recorded {
  deletes: unknown[];
  creates: { calendarId: string; holidayDate: Date; label: string | null }[][];
}

/** Prisma giả: `$transaction(cb)` chạy thẳng callback với `tx` ghi lại lệnh. */
function fakePrisma(existingDates: string[], recorded: Recorded): PrismaClient {
  const tx = {
    calendarHoliday: {
      findMany: () => Promise.resolve(existingDates.map((d) => ({ holidayDate: day(d) }))),
      deleteMany: (args: unknown) => {
        recorded.deletes.push(args);
        return Promise.resolve({ count: existingDates.length });
      },
      createMany: (args: { data: Recorded['creates'][number] }) => {
        recorded.creates.push(args.data);
        return Promise.resolve({ count: args.data.length });
      },
    },
  };
  return { $transaction: (cb: (t: unknown) => unknown) => cb(tx) } as unknown as PrismaClient;
}

describe('importHolidays — MERGE', () => {
  it('đếm riêng ngày mới và ngày ghi đè; ngày trùng trong input thì dòng SAU thắng', async () => {
    const recorded: Recorded = { deletes: [], creates: [] };
    const result = await importHolidays(fakePrisma(['2026-02-17'], recorded), {
      calendarId: 'VN_STANDARD',
      mode: 'MERGE',
      year: null,
      holidays: [
        { date: '2026-02-17', label: 'nháp' },
        { date: '2026-02-17', label: 'Tết' }, // dòng sau thắng
        { date: '2026-02-18', label: null },
      ],
    });

    expect(result).toEqual({ inserted: 1, updated: 1, deleted: 0 });
    const created = recorded.creates[0]!;
    expect(created).toHaveLength(2);
    expect(created.find((c) => c.holidayDate.getTime() === day('2026-02-17').getTime())?.label).toBe('Tết');
  });

  it('ngày ghi vào DB giữ nguyên ngày dương lịch — mốc nửa đêm UTC, không đổi múi giờ', async () => {
    const recorded: Recorded = { deletes: [], creates: [] };
    await importHolidays(fakePrisma([], recorded), {
      calendarId: 'VN_STANDARD',
      mode: 'MERGE',
      year: null,
      holidays: [{ date: '2026-02-17', label: null }],
    });
    expect(recorded.creates[0]![0]!.holidayDate.toISOString()).toBe('2026-02-17T00:00:00.000Z');
  });
});

describe('importHolidays — REPLACE_YEAR', () => {
  it('ngày cũ của năm không có trong danh sách mới được đếm là deleted', async () => {
    const recorded: Recorded = { deletes: [], creates: [] };
    // Năm 2026 đang có 3 ngày; danh sách mới giữ 1, thêm 1 → xoá thật 2.
    const result = await importHolidays(
      fakePrisma(['2026-01-01', '2026-02-17', '2026-04-30'], recorded),
      {
        calendarId: 'VN_STANDARD',
        mode: 'REPLACE_YEAR',
        year: 2026,
        holidays: [
          { date: '2026-02-17', label: 'Tết' },
          { date: '2026-09-02', label: 'Quốc khánh' },
        ],
      },
    );
    expect(result).toEqual({ inserted: 1, updated: 1, deleted: 2 });
  });
});

describe('listCalendarsWithHolidayMeta', () => {
  it('gom số ngày lễ và danh sách năm (không trùng, tăng dần) cho từng lịch', async () => {
    const prisma = {
      workCalendar: {
        findMany: () =>
          Promise.resolve([
            {
              calendarId: 'VN_STANDARD',
              timezone: 'Asia/Ho_Chi_Minh',
              workdaysMask: 31,
              hoursPerDay: 8,
              holidays: [
                { holidayDate: day('2027-01-01') },
                { holidayDate: day('2026-02-17') },
                { holidayDate: day('2026-04-30') },
              ],
            },
          ]),
      },
    } as unknown as PrismaClient;

    const list = await listCalendarsWithHolidayMeta(prisma);
    expect(list[0]).toEqual({
      calendarId: 'VN_STANDARD',
      timezone: 'Asia/Ho_Chi_Minh',
      workdaysMask: 31,
      hoursPerDay: 8,
      holidayCount: 3,
      years: [2026, 2027],
    });
  });
});
