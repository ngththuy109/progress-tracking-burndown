import { describe, it, expect } from 'vitest';
import { weekOf } from './week-of.js';
import { InvalidDateError } from './end-of-day.js';

describe('weekOf — tuần Thứ Hai → Chủ nhật chứa một ngày', () => {
  it('ngày giữa tuần trả về đúng Thứ Hai đầu tuần và Chủ nhật cuối tuần', () => {
    // 2026-08-19 là Thứ Tư.
    expect(weekOf('2026-08-19')).toEqual({ from: '2026-08-17', to: '2026-08-23' });
  });

  it('chính Thứ Hai vẫn là đầu tuần đó (không lùi sang tuần trước)', () => {
    expect(weekOf('2026-08-17')).toEqual({ from: '2026-08-17', to: '2026-08-23' });
  });

  it('Chủ nhật thuộc CÙNG tuần với Thứ Hai đứng trước, không nhảy sang tuần sau', () => {
    // 2026-08-23 là Chủ nhật — vẫn khép về tuần bắt đầu 2026-08-17.
    expect(weekOf('2026-08-23')).toEqual({ from: '2026-08-17', to: '2026-08-23' });
  });

  it('tuần bắc qua ranh giới tháng vẫn liền mạch', () => {
    // 2026-09-01 là Thứ Ba → tuần 2026-08-31 (T2) .. 2026-09-06 (CN).
    expect(weekOf('2026-09-01')).toEqual({ from: '2026-08-31', to: '2026-09-06' });
  });

  it('tuần bắc qua ranh giới năm vẫn liền mạch', () => {
    // 2027-01-01 là Thứ Sáu → tuần 2026-12-28 (T2) .. 2027-01-03 (CN).
    expect(weekOf('2027-01-01')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });

  it('ngày không hợp lệ ném InvalidDateError, không trả kết quả bịa', () => {
    expect(() => weekOf('2026-02-30')).toThrow(InvalidDateError);
    expect(() => weekOf('khong-phai-ngay')).toThrow(InvalidDateError);
  });
});
