import { describe, expect, it } from 'vitest';
import { FALLBACK_COLORS, plannedColorOf } from './burndown-chart.js';

describe('plannedColorOf', () => {
  it('đường Kế hoạch KHÔNG BAO GIỜ trùng màu đường Thực tế', () => {
    // PM từng nhầm hai đường vì trước đây chúng chỉ khác mỗi nét đứt.
    for (const color of [...FALLBACK_COLORS, '#4A90D9']) {
      expect(plannedColorOf(color).toLowerCase()).not.toBe(color.toLowerCase());
    }
  });

  it('vẫn cùng tông với màu gốc — pha về phía trắng, không đổi sắc', () => {
    // #b45309 (nâu cam) → mỗi kênh chỉ được sáng lên, thứ tự đậm nhạt giữa các
    // kênh giữ nguyên để mắt vẫn gom được cặp Kế hoạch / Thực tế cùng Phase.
    expect(plannedColorOf('#b45309')).toBe('#ddb290');
  });

  it('trả về mã hex hợp lệ đủ 6 chữ số, kể cả khi kênh màu nhỏ', () => {
    // Kênh nhỏ mà thiếu padStart sẽ ra chuỗi 5 ký tự và trình duyệt bỏ màu.
    expect(plannedColorOf('#000000')).toMatch(/^#[0-9a-f]{6}$/);
    expect(plannedColorOf('#ffffff')).toBe('#ffffff');
  });

  it('màu cấu hình không đọc được thì dùng xám trung tính, không ném lỗi', () => {
    expect(plannedColorOf('đỏ')).toBe('#9ca3af');
    expect(plannedColorOf('#abc')).toBe('#9ca3af');
  });
});
