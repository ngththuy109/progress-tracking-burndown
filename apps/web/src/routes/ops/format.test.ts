import { describe, expect, it } from 'vitest';
import { formatLocalDateTime } from './format.js';

describe('formatLocalDateTime — hiện theo múi giờ của máy người xem', () => {
  it('đổi ISO UTC sang giờ địa phương (Asia/Ho_Chi_Minh = UTC+7)', () => {
    const out = formatLocalDateTime('2026-03-10T02:00:00.000Z', {
      timeZone: 'Asia/Ho_Chi_Minh',
      locale: 'en-GB',
    });
    // 02:00 UTC = 09:00 tại Hà Nội.
    expect(out).toContain('09:00:00');
    expect(out).toContain('10/03/2026');
  });

  it('múi giờ khác cho ra giờ khác — không phải chuỗi UTC cứng', () => {
    const hn = formatLocalDateTime('2026-03-10T02:00:00.000Z', { timeZone: 'Asia/Ho_Chi_Minh', locale: 'en-GB' });
    const tokyo = formatLocalDateTime('2026-03-10T02:00:00.000Z', { timeZone: 'Asia/Tokyo', locale: 'en-GB' });
    expect(hn).not.toBe(tokyo);
    expect(tokyo).toContain('11:00:00');
  });

  it('chuỗi không đọc được → trả NGUYÊN VĂN, không hiện "Invalid Date"', () => {
    expect(formatLocalDateTime('not-a-date')).toBe('not-a-date');
  });
});
