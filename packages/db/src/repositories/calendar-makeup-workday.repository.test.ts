import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../client.js';
import { importMakeupWorkdays } from './calendar-makeup-workday.repository.js';

/**
 * Test repository ngày làm bù — T-39, không cần PostgreSQL.
 *
 * Song song với test ngày lễ: khử trùng lặp input, đếm thêm/ghi đè/xoá ở hai
 * chế độ MERGE / REPLACE_YEAR, và ngày dương lịch không bị đổi múi giờ.
 */

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Recorded {
  deletes: unknown[];
  creates: { calendarId: string; workDate: Date; label: string | null }[][];
}

/** Prisma giả: `$transaction(cb)` chạy thẳng callback với `tx` ghi lại lệnh. */
function fakePrisma(existingDates: string[], recorded: Recorded): PrismaClient {
  const tx = {
    calendarMakeupWorkday: {
      findMany: () => Promise.resolve(existingDates.map((d) => ({ workDate: day(d) }))),
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

describe('importMakeupWorkdays — MERGE', () => {
  it('đếm riêng ngày mới và ngày ghi đè; ngày trùng trong input thì dòng SAU thắng', async () => {
    const recorded: Recorded = { deletes: [], creates: [] };
    const result = await importMakeupWorkdays(fakePrisma(['2026-04-25'], recorded), {
      calendarId: 'VN_STANDARD',
      mode: 'MERGE',
      year: null,
      makeupWorkdays: [
        { date: '2026-04-25', label: 'nháp' },
        { date: '2026-04-25', label: 'Làm bù 30/4' }, // dòng sau thắng
        { date: '2026-05-30', label: null },
      ],
    });

    expect(result).toEqual({ inserted: 1, updated: 1, deleted: 0 });
    const created = recorded.creates[0]!;
    expect(created).toHaveLength(2);
    expect(created.find((c) => c.workDate.getTime() === day('2026-04-25').getTime())?.label).toBe(
      'Làm bù 30/4',
    );
  });

  it('ngày ghi vào DB giữ nguyên ngày dương lịch — mốc nửa đêm UTC, không đổi múi giờ', async () => {
    const recorded: Recorded = { deletes: [], creates: [] };
    await importMakeupWorkdays(fakePrisma([], recorded), {
      calendarId: 'VN_STANDARD',
      mode: 'MERGE',
      year: null,
      makeupWorkdays: [{ date: '2026-04-25', label: null }],
    });
    expect(recorded.creates[0]![0]!.workDate.toISOString()).toBe('2026-04-25T00:00:00.000Z');
  });
});

describe('importMakeupWorkdays — REPLACE_YEAR', () => {
  it('ngày cũ của năm không có trong danh sách mới được đếm là deleted', async () => {
    const recorded: Recorded = { deletes: [], creates: [] };
    const result = await importMakeupWorkdays(
      fakePrisma(['2026-04-25', '2026-05-30', '2026-08-29'], recorded),
      {
        calendarId: 'VN_STANDARD',
        mode: 'REPLACE_YEAR',
        year: 2026,
        makeupWorkdays: [
          { date: '2026-04-25', label: 'giữ' },
          { date: '2026-09-05', label: 'thêm' },
        ],
      },
    );
    expect(result).toEqual({ inserted: 1, updated: 1, deleted: 2 });
  });
});
