import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  describeWorkdaysMask,
  workdaysMaskWarning,
} from './calendar.js';

/**
 * Quy ước bit của `workdays_mask` — chống hồi quy cho lỗi thực tế: bản ghi
 * lịch tạo tay với mask 126 (tính bit 1-indexed thay vì 0-indexed) làm mọi
 * Thứ Hai biến mất khỏi biểu đồ Burndown mà không một cảnh báo nào kêu lên.
 */

describe('describeWorkdaysMask', () => {
  it('giải mã đúng T2–T6 (31) và T2–T7 (63)', () => {
    expect(describeWorkdaysMask(31)).toBe('Mon, Tue, Wed, Thu, Fri');
    expect(describeWorkdaysMask(63)).toBe('Mon, Tue, Wed, Thu, Fri, Sat');
  });

  it('126 (lỗi 1-indexed) đọc ra là T3–CN — nhìn phát biết sai', () => {
    expect(describeWorkdaysMask(126)).toBe('Tue, Wed, Thu, Fri, Sat, Sun');
  });

  it('mask rỗng nói thẳng là không có ngày làm việc nào', () => {
    expect(describeWorkdaysMask(0)).toBe('(no working day)');
  });
});

describe('workdaysMaskWarning', () => {
  it('mask hợp lệ (có Thứ Hai, trong 7 bit) thì im lặng', () => {
    expect(workdaysMaskWarning(DEFAULT_WORKDAYS_MASK)).toBeNull();
    expect(workdaysMaskWarning(63)).toBeNull(); // T2–T7
    expect(workdaysMaskWarning(127)).toBeNull(); // cả tuần
    expect(workdaysMaskWarning(1)).toBeNull(); // chỉ Thứ Hai
  });

  it('mask thiếu Thứ Hai cảnh báo kèm giá trị đúng để sửa (31 / 63)', () => {
    // 126 = 63 << 1 và 62 = 31 << 1 — hai vết trượt 1-indexed đã gặp thật.
    for (const bad of [126, 62]) {
      const warning = workdaysMaskWarning(bad);
      expect(warning).not.toBeNull();
      expect(warning).toContain('Monday');
      expect(warning).toContain('63');
      expect(warning).toContain('31');
    }
  });

  it('cảnh báo nêu rõ danh sách ngày mà mask đang mô tả', () => {
    expect(workdaysMaskWarning(126)).toContain('Tue, Wed, Thu, Fri, Sat, Sun');
  });

  it('mask ngoài khoảng 7 bit (0, 128, 254) bị coi là không hợp lệ', () => {
    for (const bad of [0, -1, 128, 254]) {
      const warning = workdaysMaskWarning(bad);
      expect(warning).not.toBeNull();
      expect(warning).toContain('127');
    }
  });

  it('mask không nguyên cũng không lọt qua', () => {
    expect(workdaysMaskWarning(31.5)).not.toBeNull();
  });
});
