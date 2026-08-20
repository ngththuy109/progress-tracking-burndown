import { describe, it, expect } from 'vitest';
import {
  LOGWORK_OVER_LIMIT_HOURS,
  LOGWORK_UNDER_LIMIT_HOURS,
  logworkDayWarning,
} from './api-logwork.js';

/**
 * `logworkDayWarning` là NGUỒN CHÂN LÝ chung cho cả web (tô ô) lẫn API (đếm
 * warnCount). Khoá đúng các mốc biên `4h` và `8h` để hai bên không lệch.
 */
describe('logworkDayWarning', () => {
  it('ngưỡng mặc định: thiếu <= 4h, quá > 8h', () => {
    expect(LOGWORK_UNDER_LIMIT_HOURS).toBe(4);
    expect(LOGWORK_OVER_LIMIT_HOURS).toBe(8);
  });

  it('0h (chưa log) → null: ngày trống không phải một lần log', () => {
    expect(logworkDayWarning(0)).toBeNull();
    // Số âm (dữ liệu lạ) cũng coi như không có gì để tô.
    expect(logworkDayWarning(-1)).toBeNull();
  });

  it('0 < h <= 4 → "under" (kể cả 4 chẵn)', () => {
    expect(logworkDayWarning(0.5)).toBe('under');
    expect(logworkDayWarning(3.9)).toBe('under');
    expect(logworkDayWarning(4)).toBe('under');
  });

  it('4 < h <= 8 → null (khoảng lành, kể cả 8 chẵn)', () => {
    expect(logworkDayWarning(4.1)).toBeNull();
    expect(logworkDayWarning(6)).toBeNull();
    expect(logworkDayWarning(8)).toBeNull();
  });

  it('h > 8 → "over"', () => {
    expect(logworkDayWarning(8.01)).toBe('over');
    expect(logworkDayWarning(12)).toBe('over');
  });
});
