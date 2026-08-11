import { describe, expect, it } from 'vitest';
import { parseHolidayLines } from './parse-holiday-lines.js';

/** Test bộ đọc danh sách ngày nghỉ PM dán vào — T-36. */
describe('parseHolidayLines', () => {
  it('đọc được cả ba kiểu phân cách: phẩy, chấm phẩy, tab (dán từ Excel)', () => {
    const r = parseHolidayLines('2026-01-01, New Year\n2026-02-17; Tết\n2026-04-30\tGiải phóng');
    expect(r.errors).toHaveLength(0);
    expect(r.holidays).toEqual([
      { date: '2026-01-01', label: 'New Year' },
      { date: '2026-02-17', label: 'Tết' },
      { date: '2026-04-30', label: 'Giải phóng' },
    ]);
  });

  it('dòng chỉ có ngày thì label là null; dòng trống bỏ qua', () => {
    const r = parseHolidayLines('\n2026-09-02\n\n');
    expect(r.holidays).toEqual([{ date: '2026-09-02', label: null }]);
  });

  it('nhãn chứa dấu phẩy không bị cắt mất phần sau', () => {
    const r = parseHolidayLines('2026-02-17, Tết, mùng một');
    expect(r.holidays[0]?.label).toBe('Tết, mùng một');
  });

  it('dòng sai KHÔNG chặn dòng đúng, và báo đúng số dòng người dùng nhìn thấy', () => {
    const r = parseHolidayLines('2026-01-01\n17/02/2026, Tết\n2026-04-30');
    expect(r.holidays.map((h) => h.date)).toEqual(['2026-01-01', '2026-04-30']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.line).toBe(2);
  });

  it('ngày khớp định dạng nhưng không tồn tại trên lịch bị bắt — 2026-02-30', () => {
    const r = parseHolidayLines('2026-02-30, ngày ma');
    expect(r.holidays).toHaveLength(0);
    expect(r.errors[0]?.reason).toContain('2026-02-30');
  });
});
