import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChartSeries } from '@app/shared';
import { BurndownChart } from './burndown-chart.js';

/**
 * Test render thật (jsdom) cho CẦU NỐI của đường Thực tế.
 *
 * Yêu cầu 2026-08: đường Thực tế phải nhìn LIỀN MẠCH kể cả khi có ngày thiếu
 * snapshot — nhưng nét liền vẫn là cam kết "số đo thật" (E-12). Giải pháp: hai
 * lớp đường cùng dữ liệu — đường chính nét liền ĐỨT tại lỗ thủng, cầu nối nét
 * đứt mờ `connectNulls` vẽ bên dưới nối qua. Test này khoá đúng hình học đó
 * bằng cách đếm subpath (`M`) trong thuộc tính `d` của từng đường.
 *
 * Lưu ý jsdom: animation của Recharts chưa chạy xong nên chấm dữ liệu chưa
 * render và `stroke-dasharray` bị đè tạm — nhận diện cầu nối bằng
 * `stroke-opacity` (0.55) thay vì nét đứt.
 */

/** Thứ 6 có số liệu, Thứ 2 thiếu snapshot (lỗ thủng thật), Thứ 3 có số liệu. */
const WITH_HOLE: ChartSeries = {
  key: 'EPIC',
  label: 'Whole Epic',
  colorHex: null,
  points: [
    { date: '2026-08-07', plannedRemainingHours: 68, actualRemainingHours: 80, varianceHours: -12 },
    { date: '2026-08-10', plannedRemainingHours: null, actualRemainingHours: null, varianceHours: null },
    { date: '2026-08-11', plannedRemainingHours: 52, actualRemainingHours: 70, varianceHours: -18 },
  ],
};

const BRIDGE_OPACITY = '0.55';

function curvesOf(container: HTMLElement): { bridge: Element[]; main: Element[] } {
  const all = [...container.querySelectorAll('path.recharts-line-curve')];
  return {
    bridge: all.filter((c) => c.getAttribute('stroke-opacity') === BRIDGE_OPACITY),
    main: all.filter((c) => c.getAttribute('stroke-opacity') !== BRIDGE_OPACITY),
  };
}

const subpathCount = (el: Element): number => (el.getAttribute('d')?.match(/M/g) ?? []).length;

describe('BurndownChart — cầu nối đường Thực tế qua ngày thiếu snapshot', () => {
  it('đường chính ĐỨT tại lỗ thủng, cầu nối LIỀN MẠCH nối qua', () => {
    const { container } = render(
      <BurndownChart series={[WITH_HOLE]} markers={[]} showPlanned={false} />,
    );

    const { bridge, main } = curvesOf(container);
    expect(bridge).toHaveLength(1);
    expect(main).toHaveLength(1);

    // Cầu nối: MỘT subpath duy nhất — mắt nhìn thấy mạch liền không đứt quãng.
    expect(subpathCount(bridge[0]!)).toBe(1);
    // Đường chính: HAI subpath — khoảng thiếu snapshot không được vẽ nét liền.
    expect(subpathCount(main[0]!)).toBe(2);
  });

  it('cầu nối không chen vào chú giải — mỗi chuỗi vẫn chỉ một mục Actual', () => {
    render(<BurndownChart series={[WITH_HOLE]} markers={[]} showPlanned={false} />);
    expect(screen.getAllByText('Whole Epic · Actual')).toHaveLength(1);
  });

  it('bật đường Kế hoạch thì có đúng 3 đường: cầu nối + Thực tế + Kế hoạch', () => {
    const { container } = render(
      <BurndownChart series={[WITH_HOLE]} markers={[]} showPlanned={true} />,
    );
    expect(container.querySelectorAll('path.recharts-line-curve')).toHaveLength(3);
  });

  it('dữ liệu không có lỗ thủng thì cầu nối trùng khít dưới đường chính (cùng một subpath)', () => {
    const full: ChartSeries = {
      ...WITH_HOLE,
      points: WITH_HOLE.points.map((p) => ({
        ...p,
        plannedRemainingHours: 60,
        actualRemainingHours: 75,
      })),
    };
    const { container } = render(<BurndownChart series={[full]} markers={[]} showPlanned={false} />);

    const { bridge, main } = curvesOf(container);
    expect(subpathCount(bridge[0]!)).toBe(1);
    expect(subpathCount(main[0]!)).toBe(1);
    // Cùng dữ liệu, cùng nội suy — hai đường phải cùng một hình học.
    expect(bridge[0]!.getAttribute('d')).toBe(main[0]!.getAttribute('d'));
  });
});
