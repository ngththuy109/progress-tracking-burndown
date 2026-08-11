import { describe, expect, it } from 'vitest';
import type { ChartSeries } from '@app/shared';
import { FALLBACK_COLORS, offDayRuns, plannedColorOf, toChartRows } from './burndown-chart.js';

/** Dựng một chuỗi số gọn cho test: mỗi phần tử là [ngày, kế hoạch, thực tế]. */
function series(key: string, pts: readonly [string, number | null, number | null][]): ChartSeries {
  return {
    key,
    label: key,
    colorHex: null,
    points: pts.map(([date, planned, actual]) => ({
      date,
      plannedRemainingHours: planned,
      actualRemainingHours: actual,
      varianceHours: planned === null || actual === null ? null : planned - actual,
    })),
  };
}

describe('toChartRows — ngày nghỉ lên trục, bôi xám thay vì biến mất', () => {
  it('chèn T7/CN giữa T6 và T2, đánh dấu offDay và kéo phẳng giá trị', () => {
    // 2026-08-07 là Thứ 6, 2026-08-10 là Thứ 2 — dữ liệu API chỉ có hai ngày
    // làm việc; 08 và 09 là cuối tuần phải được chèn vào cho trục liền mạch.
    const rows = toChartRows([series('EPIC', [['2026-08-07', 75, 80], ['2026-08-10', 70, 76]])]);

    expect(rows.map((r) => r.date)).toEqual(['2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10']);
    expect(rows.map((r) => r.offDay === true)).toEqual([false, true, true, false]);
    // Giá trị cuối tuần kéo phẳng từ Thứ 6 — đường liền mạch, không lỗ thủng.
    expect(rows[1]?.['EPIC__actual']).toBe(80);
    expect(rows[1]?.['EPIC__planned']).toBe(75);
    expect(rows[2]?.['EPIC__actual']).toBe(80);
  });

  it('hai ngày làm việc liền kề thì không chèn gì', () => {
    const rows = toChartRows([series('EPIC', [['2026-08-10', 70, 76], ['2026-08-11', 65, 72]])]);
    expect(rows).toHaveLength(2);
  });

  it('ngày làm việc thiếu snapshot vẫn là lỗ thủng, ngày nghỉ sau nó KHÔNG bịa số (E-12)', () => {
    // Thứ 6 thiếu snapshot (null) → cuối tuần kéo theo null: nối qua đó là vẽ
    // ra một tiến độ không có thật.
    const rows = toChartRows([series('EPIC', [['2026-08-07', null, null], ['2026-08-10', 70, 76]])]);

    expect(rows[1]?.offDay).toBe(true);
    expect(rows[1]?.['EPIC__actual']).toBeNull();
    expect(rows[2]?.['EPIC__planned']).toBeNull();
  });

  it('nhiều chuỗi kéo phẳng độc lập theo từng chuỗi', () => {
    const rows = toChartRows([
      series('A', [['2026-08-07', 10, 20], ['2026-08-10', 8, 16]]),
      series('B', [['2026-08-07', null, 40], ['2026-08-10', null, 30]]),
    ]);

    expect(rows[1]?.['A__actual']).toBe(20);
    expect(rows[1]?.['B__actual']).toBe(40);
    expect(rows[1]?.['B__planned']).toBeNull();
  });
});

describe('offDayRuns — gom ngày nghỉ liền nhau thành dải để tô xám', () => {
  it('T7+CN thành MỘT dải, hai cuối tuần khác nhau thành hai dải', () => {
    const rows = toChartRows([
      series('EPIC', [
        ['2026-08-07', 75, 80], // T6
        ['2026-08-10', 70, 76], // T2
        ['2026-08-14', 60, 68], // T6 tuần sau
        ['2026-08-17', 55, 64], // T2
      ]),
    ]);

    expect(offDayRuns(rows)).toEqual([
      { from: '2026-08-08', to: '2026-08-09' },
      { from: '2026-08-11', to: '2026-08-13' }, // 11–13 không có dữ liệu → coi là ngày nghỉ theo lịch
      { from: '2026-08-15', to: '2026-08-16' },
    ]);
  });

  it('không có ngày nghỉ thì không có dải nào', () => {
    const rows = toChartRows([series('EPIC', [['2026-08-10', 70, 76], ['2026-08-11', 65, 72]])]);
    expect(offDayRuns(rows)).toEqual([]);
  });
});

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
