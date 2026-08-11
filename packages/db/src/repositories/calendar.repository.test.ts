import { describe, it, expect } from 'vitest';
import { DEFAULT_WORKDAYS_MASK } from '@app/shared';
import { getCalendar, CalendarCache, FALLBACK_TIMEZONE } from './calendar.repository.js';
import type { PrismaClient } from '../client.js';

/**
 * Chỉ giả đúng một phương thức mà `getCalendar` dùng tới.
 *
 * Không cần PostgreSQL: thứ đáng kiểm chứng ở đây là cách gộp ngày lễ và cách
 * xử lý khi thiếu lịch, không phải bản thân câu SQL.
 */
function fakePrisma(row: unknown, onCall?: () => void): PrismaClient {
  return {
    workCalendar: {
      findUnique: () => {
        onCall?.();
        return Promise.resolve(row);
      },
    },
  } as unknown as PrismaClient;
}

const holidayRow = (d: string) => ({ holidayDate: new Date(`${d}T00:00:00.000Z`) });

describe('đọc lịch làm việc', () => {
  it('repository gộp đúng ngày lễ vào WorkCalendar', async () => {
    const cal = await getCalendar(
      fakePrisma({
        calendarId: 'VN_STANDARD',
        timezone: 'Asia/Ho_Chi_Minh',
        workdaysMask: DEFAULT_WORKDAYS_MASK,
        hoursPerDay: 8,
        holidays: [holidayRow('2026-02-17'), holidayRow('2026-04-30')],
      }),
      'VN_STANDARD',
    );

    expect(cal.holidays.has('2026-02-17')).toBe(true);
    expect(cal.holidays.has('2026-04-30')).toBe(true);
    expect(cal.holidays.size).toBe(2);
    expect(cal.timezone).toBe('Asia/Ho_Chi_Minh');
  });

  it('ngày lễ giữ nguyên ngày dương lịch, không bị đổi múi giờ', async () => {
    // `2026-02-17` là ngày lễ ở mọi múi giờ dùng lịch này, không phải một
    // khoảnh khắc cụ thể — đổi múi giờ ở đây sẽ làm nó lùi thành 16/02
    const cal = await getCalendar(
      fakePrisma({
        calendarId: 'JP_STANDARD',
        timezone: 'Asia/Tokyo',
        workdaysMask: DEFAULT_WORKDAYS_MASK,
        hoursPerDay: 8,
        holidays: [holidayRow('2026-02-17')],
      }),
      'JP_STANDARD',
    );
    expect([...cal.holidays]).toEqual(['2026-02-17']);
  });

  it('mask thiếu Thứ Hai (vết trượt 1-indexed) sinh cảnh báo, không im lặng', async () => {
    // Lỗi thật: lịch tạo tay mask 126 làm mọi Thứ Hai biến mất khỏi biểu đồ.
    // Database mới đã có CHECK chặn, nhưng DB chưa áp migration vẫn phải kêu to.
    const cal = await getCalendar(
      fakePrisma({
        calendarId: 'BAD_MASK',
        timezone: 'Asia/Ho_Chi_Minh',
        workdaysMask: 126,
        hoursPerDay: 8,
        holidays: [holidayRow('2026-02-17')],
      }),
      'BAD_MASK',
    );

    expect(cal.warnings.some((w) => w.includes('Monday'))).toBe(true);
    expect(cal.warnings.some((w) => w.includes('63'))).toBe(true);
  });

  it('thiếu dữ liệu lịch thì mặc định T2 tới T6 và ghi cảnh báo', async () => {
    const cal = await getCalendar(fakePrisma(null), 'KHONG_CO');

    expect(cal.workdaysMask).toBe(DEFAULT_WORKDAYS_MASK);
    expect(cal.timezone).toBe(FALLBACK_TIMEZONE);
    expect(cal.holidays.size).toBe(0);
    // Trả mặc định trong im lặng sẽ khiến Epic cấu hình sai vẫn vẽ ra biểu đồ
    // trông bình thường (C-10)
    expect(cal.warnings).toHaveLength(1);
    expect(cal.warnings[0]).toContain('KHONG_CO');
  });

  it('lịch không có ngày lễ nào cũng sinh cảnh báo', async () => {
    const cal = await getCalendar(
      fakePrisma({
        calendarId: 'VN_STANDARD',
        timezone: 'Asia/Ho_Chi_Minh',
        workdaysMask: DEFAULT_WORKDAYS_MASK,
        hoursPerDay: 8,
        holidays: [],
      }),
      'VN_STANDARD',
    );
    expect(cal.warnings.some((w) => w.includes('E-14'))).toBe(true);
  });

  it('hoursPerDay kiểu Decimal của Prisma được đổi sang number', async () => {
    const cal = await getCalendar(
      fakePrisma({
        calendarId: 'VN_STANDARD',
        timezone: 'Asia/Ho_Chi_Minh',
        workdaysMask: DEFAULT_WORKDAYS_MASK,
        // Prisma trả Decimal, không phải number thuần
        hoursPerDay: { toString: () => '7.50' },
        holidays: [],
      }),
      'VN_STANDARD',
    );
    expect(cal.hoursPerDay).toBe(7.5);
    expect(typeof cal.hoursPerDay).toBe('number');
  });
});

describe('bộ nhớ đệm lịch', () => {
  it('lần gọi thứ hai lấy từ đệm, không chạm database', async () => {
    const cache = new CalendarCache();
    let calls = 0;
    const prisma = fakePrisma(
      {
        calendarId: 'VN_STANDARD',
        timezone: 'Asia/Ho_Chi_Minh',
        workdaysMask: DEFAULT_WORKDAYS_MASK,
        hoursPerDay: 8,
        holidays: [],
      },
      () => calls++,
    );

    await getCalendar(prisma, 'VN_STANDARD', cache);
    await getCalendar(prisma, 'VN_STANDARD', cache);
    expect(calls).toBe(1);
  });

  it('làm mới đệm thì lần sau đọc lại database', async () => {
    // Thêm ngày lễ mà worker chạy suốt không khởi động lại thì lịch cũ vẫn
    // được dùng — đây là cách thoát
    const cache = new CalendarCache();
    let calls = 0;
    const prisma = fakePrisma(
      {
        calendarId: 'VN_STANDARD',
        timezone: 'Asia/Ho_Chi_Minh',
        workdaysMask: DEFAULT_WORKDAYS_MASK,
        hoursPerDay: 8,
        holidays: [],
      },
      () => calls++,
    );

    await getCalendar(prisma, 'VN_STANDARD', cache);
    cache.invalidate('VN_STANDARD');
    await getCalendar(prisma, 'VN_STANDARD', cache);
    expect(calls).toBe(2);
  });

  it('làm mới không truyền id thì xoá sạch mọi lịch', async () => {
    const cache = new CalendarCache();
    const prisma = fakePrisma({
      calendarId: 'X',
      timezone: 'Asia/Tokyo',
      workdaysMask: DEFAULT_WORKDAYS_MASK,
      hoursPerDay: 8,
      holidays: [],
    });
    await getCalendar(prisma, 'A', cache);
    await getCalendar(prisma, 'B', cache);
    expect(cache.size).toBe(2);
    cache.invalidate();
    expect(cache.size).toBe(0);
  });
});
