import { describe, it, expect } from 'vitest';
import {
  LOGWORK_OVER_LIMIT_HOURS,
  LOGWORK_UNDER_LIMIT_HOURS,
  logworkCellFlag,
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

/**
 * `logworkCellFlag` gộp cảnh báo số giờ với hai dấu theo LỊCH — cũng là NGUỒN
 * CHÂN LÝ chung cho web (tô ô) và API (đếm số ô cần soát).
 */
describe('logworkCellFlag', () => {
  const WORK_PAST = { working: true, past: true } as const;

  it('ngày làm việc CÓ log: giữ nguyên ngưỡng under/over, khoảng lành → null', () => {
    expect(logworkCellFlag(3, true, true)).toBe('under');
    expect(logworkCellFlag(4, true, false)).toBe('under'); // đã qua hay chưa không đổi khi CÓ log
    expect(logworkCellFlag(6, true, true)).toBeNull();
    expect(logworkCellFlag(8, true, true)).toBeNull();
    expect(logworkCellFlag(9, true, true)).toBe('over');
  });

  it('ngày làm việc đã QUA mà KHÔNG log → "missing"', () => {
    expect(logworkCellFlag(0, true, true)).toBe('missing');
  });

  it('ngày làm việc hôm nay/tương lai (chưa qua) để trống → null (chưa tới hạn log)', () => {
    expect(logworkCellFlag(0, true, false)).toBeNull();
  });

  it('ngày NGHỈ mà có log → "offday" bất kể ít/nhiều giờ (không rơi vào under/over)', () => {
    expect(logworkCellFlag(2, false, true)).toBe('offday'); // ít giờ vẫn offday, KHÔNG phải under
    expect(logworkCellFlag(10, false, true)).toBe('offday'); // nhiều giờ vẫn offday, KHÔNG phải over
  });

  it('ngày NGHỈ không log → null (cuối tuần/lễ trống là bình thường)', () => {
    expect(logworkCellFlag(0, false, true)).toBeNull();
    expect(logworkCellFlag(0, false, false)).toBeNull();
    // Đảm bảo dùng đúng WORK_PAST như một cấu hình đọc được.
    expect(logworkCellFlag(0, WORK_PAST.working, WORK_PAST.past)).toBe('missing');
  });
});
