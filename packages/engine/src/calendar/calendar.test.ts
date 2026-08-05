import { describe, it, expect } from 'vitest';
import { DEFAULT_WORKDAYS_MASK, WORKDAY_BIT, type WorkCalendar } from '@app/shared';
import { endOfDayUtcMs, startOfDayUtcMs, localDateOf, InvalidDateError } from './end-of-day.js';
import { countWorkdays, listWorkdays, isWorkday, addWorkdays } from './count-workdays.js';

const cal = (over: Partial<WorkCalendar> = {}): WorkCalendar => ({
  calendarId: 'VN_STANDARD',
  timezone: 'Asia/Ho_Chi_Minh',
  workdaysMask: DEFAULT_WORKDAYS_MASK,
  hoursPerDay: 8,
  holidays: new Set<string>(),
  warnings: [],
  ...over,
});

const iso = (ms: number) => new Date(ms).toISOString();

describe('mốc chốt sổ', () => {
  it('mốc chốt sổ ngày 2026-03-10 giờ Việt Nam bằng 2026-03-10T16:59:59.999Z', () => {
    expect(iso(endOfDayUtcMs('2026-03-10', 'Asia/Ho_Chi_Minh'))).toBe('2026-03-10T16:59:59.999Z');
  });

  it('mốc chốt sổ cùng ngày giờ Nhật bằng 2026-03-10T14:59:59.999Z', () => {
    expect(iso(endOfDayUtcMs('2026-03-10', 'Asia/Tokyo'))).toBe('2026-03-10T14:59:59.999Z');
  });

  it('hai múi giờ khác nhau cho ra hai mốc UTC khác nhau cho cùng một ngày', () => {
    const vn = endOfDayUtcMs('2026-03-10', 'Asia/Ho_Chi_Minh');
    const jp = endOfDayUtcMs('2026-03-10', 'Asia/Tokyo');
    expect(vn).not.toBe(jp);
    // Nhật sớm hơn Việt Nam 2 giờ nên chốt sổ TRƯỚC
    expect(vn - jp).toBe(2 * 60 * 60 * 1000);
  });

  it('mốc bắt đầu ngày là 00:00:00.000 giờ địa phương', () => {
    expect(iso(startOfDayUtcMs('2026-03-10', 'Asia/Ho_Chi_Minh'))).toBe('2026-03-09T17:00:00.000Z');
  });

  it('khoảng một ngày dài đúng 24 giờ trừ 1 mili-giây', () => {
    const s = startOfDayUtcMs('2026-03-10', 'Asia/Tokyo');
    const e = endOfDayUtcMs('2026-03-10', 'Asia/Tokyo');
    expect(e - s).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it('ngày không hợp lệ ném InvalidDateError, KHÔNG trả NaN im lặng', () => {
    expect(() => endOfDayUtcMs('2026-02-30', 'Asia/Tokyo')).toThrow(InvalidDateError);
    expect(() => endOfDayUtcMs('khong-phai-ngay', 'Asia/Tokyo')).toThrow(InvalidDateError);
  });

  it('múi giờ không hợp lệ ném lỗi thay vì lặng lẽ dùng UTC', () => {
    expect(() => endOfDayUtcMs('2026-03-10', 'Khong/Co')).toThrow(InvalidDateError);
  });
});

describe('xếp mốc thời gian vào ngày địa phương', () => {
  it('worklog lúc 23:30 giờ Việt Nam thuộc về ngày hôm đó, không phải hôm sau', () => {
    // 2026-03-10T23:30 +07:00 = 2026-03-10T16:30Z
    expect(localDateOf(Date.parse('2026-03-10T16:30:00.000Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-03-10');
  });

  it('cùng một mốc UTC rơi vào hai ngày khác nhau ở hai múi giờ', () => {
    const utc = Date.parse('2026-03-10T16:30:00.000Z');
    expect(localDateOf(utc, 'Asia/Ho_Chi_Minh')).toBe('2026-03-10');
    expect(localDateOf(utc, 'America/New_York')).toBe('2026-03-10');
    // 16:30Z là 01:30 hôm sau ở Nhật
    expect(localDateOf(utc, 'Asia/Tokyo')).toBe('2026-03-11');
  });
});

describe('đếm ngày làm việc', () => {
  // 2026-03-09 là thứ Hai
  it('từ thứ Hai tới thứ Sáu cùng tuần đếm được 5 ngày', () => {
    expect(countWorkdays('2026-03-09', '2026-03-13', cal())).toBe(5);
  });

  it('khoảng vắt qua cuối tuần không đếm thứ Bảy và Chủ nhật', () => {
    // T2 09/03 → T2 16/03 = 8 ngày lịch, 6 ngày làm việc
    expect(countWorkdays('2026-03-09', '2026-03-16', cal())).toBe(6);
  });

  it('ngày lễ trong khoảng bị loại khỏi phép đếm', () => {
    const withHoliday = cal({ holidays: new Set(['2026-03-11']) });
    expect(countWorkdays('2026-03-09', '2026-03-13', withHoliday)).toBe(4);
  });

  it('Epic vắt qua Tết Nguyên đán đếm đúng, không tính 7 ngày nghỉ', () => {
    // Tết 2026: 17/02 (thứ Ba) là mùng 1. Nghỉ 16/02–20/02 (T2–T6).
    const tet = cal({
      holidays: new Set(['2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20']),
    });
    // 09/02 (T2) → 27/02 (T6): 15 ngày làm việc nếu không nghỉ, trừ 5 ngày Tết
    expect(countWorkdays('2026-02-09', '2026-02-27', cal())).toBe(15);
    expect(countWorkdays('2026-02-09', '2026-02-27', tet)).toBe(10);
  });

  it('từ ngày và tới ngày trùng nhau và là ngày làm việc thì đếm được 1', () => {
    expect(countWorkdays('2026-03-10', '2026-03-10', cal())).toBe(1);
  });

  it('từ ngày và tới ngày trùng nhau nhưng là Chủ nhật thì đếm được 0', () => {
    expect(countWorkdays('2026-03-15', '2026-03-15', cal())).toBe(0);
  });

  it('toDate nhỏ hơn fromDate trả 0, KHÔNG trả số âm', () => {
    // Số âm sẽ làm đường Kế hoạch ở T-16 đi LÊN mà không báo lỗi
    expect(countWorkdays('2026-03-13', '2026-03-09', cal())).toBe(0);
    expect(listWorkdays('2026-03-13', '2026-03-09', cal())).toEqual([]);
  });
});

describe('bitmask ngày làm việc', () => {
  it('bit 0 là thứ Hai theo cách đánh số của luxon, không phải Chủ nhật', () => {
    const onlyMonday = cal({ workdaysMask: WORKDAY_BIT.MONDAY });
    expect(isWorkday('2026-03-09', onlyMonday)).toBe(true); // thứ Hai
    expect(isWorkday('2026-03-08', onlyMonday)).toBe(false); // Chủ nhật
  });

  it('bit 6 là Chủ nhật', () => {
    const onlySunday = cal({ workdaysMask: WORKDAY_BIT.SUNDAY });
    expect(isWorkday('2026-03-15', onlySunday)).toBe(true); // Chủ nhật
    expect(isWorkday('2026-03-09', onlySunday)).toBe(false); // thứ Hai
  });

  it('lịch làm cả tuần đếm đủ 7 ngày', () => {
    const allWeek = cal({ workdaysMask: 0b1111111 });
    expect(countWorkdays('2026-03-09', '2026-03-15', allWeek)).toBe(7);
  });
});

describe('chống hồi quy múi giờ', () => {
  it('khoảng vắt qua ngày DST của một múi giờ có DST vẫn đếm đúng', () => {
    // Mỹ đổi giờ 08/03/2026. Cộng offset bằng tay sẽ lệch một ngày ở đây.
    // 02/03 (T2) → 13/03 (T6) = 10 ngày làm việc, bất kể có DST hay không.
    const ny = cal({ timezone: 'America/New_York' });
    expect(countWorkdays('2026-03-02', '2026-03-13', ny)).toBe(10);
  });

  it('mốc chốt sổ trước và sau ngày DST lệch nhau đúng 1 giờ tính theo UTC', () => {
    // Trước DST: UTC-5. Sau DST: UTC-4.
    const before = endOfDayUtcMs('2026-03-06', 'America/New_York');
    const after = endOfDayUtcMs('2026-03-09', 'America/New_York');
    const days = (after - before) / (24 * 60 * 60 * 1000);
    // 3 ngày lịch nhưng chỉ cách nhau 3 ngày TRỪ 1 giờ vì đồng hồ nhảy lên
    expect(days).toBeCloseTo(3 - 1 / 24, 6);
  });

  it('listWorkdays trả đúng danh sách ngày, không lệch một ngày ở hai đầu', () => {
    expect(listWorkdays('2026-03-09', '2026-03-13', cal())).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
  });

  it('listWorkdays ở múi giờ có DST không bỏ sót và không lặp ngày', () => {
    const ny = cal({ timezone: 'America/New_York' });
    const days = listWorkdays('2026-03-06', '2026-03-10', ny);
    expect(days).toEqual(['2026-03-06', '2026-03-09', '2026-03-10']);
    expect(new Set(days).size).toBe(days.length);
  });
});

describe('cộng ngày làm việc', () => {
  it('cộng 0 ngày làm việc từ thứ Hai trả về chính thứ Hai đó', () => {
    expect(addWorkdays('2026-03-09', 0, cal())).toBe('2026-03-09');
  });

  it('cộng 0 ngày làm việc từ thứ Bảy nhảy tới thứ Hai kế tiếp', () => {
    expect(addWorkdays('2026-03-14', 0, cal())).toBe('2026-03-16');
  });

  it('cộng 5 ngày làm việc từ thứ Hai ra thứ Hai tuần sau', () => {
    expect(addWorkdays('2026-03-09', 5, cal())).toBe('2026-03-16');
  });

  it('cộng ngày làm việc nhảy qua ngày lễ', () => {
    const withHoliday = cal({ holidays: new Set(['2026-03-11']) });
    expect(addWorkdays('2026-03-09', 2, withHoliday)).toBe('2026-03-12');
  });

  it('số ngày âm trả null thay vì đoán bừa', () => {
    expect(addWorkdays('2026-03-09', -1, cal())).toBeNull();
  });
});
