import { useMemo } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartMarker, ChartSeries } from '@app/shared';

/**
 * Bọc Recharts lại thành component riêng của dự án.
 *
 * Component nghiệp vụ KHÔNG được import Recharts trực tiếp. Đổi thư viện biểu đồ
 * sau này chỉ phải sửa đúng thư mục này thay vì mọi màn hình.
 */

/** Màu mặc định theo thứ tự, dùng cho Phase chưa đặt màu trong cấu hình. */
export const FALLBACK_COLORS = ['#2563eb', '#16a34a', '#b45309', '#7c3aed'] as const;

/** Màu dùng khi màu cấu hình không đọc được — xám trung tính, vẫn nhìn thấy trên nền trắng. */
const PLANNED_FALLBACK = '#9ca3af';

/**
 * Màu của đường Kế hoạch, suy ra từ màu đường Thực tế cùng Phase.
 *
 * Pha 55% về phía trắng: hai đường RÕ RÀNG khác màu (PM từng nhầm vì trước đây
 * chỉ khác mỗi nét đứt), nhưng vẫn cùng tông để mắt gom được cặp Kế hoạch /
 * Thực tế của cùng một Phase khi có nhiều Phase trên biểu đồ.
 */
export function plannedColorOf(actualHex: string): string {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(actualHex.trim())?.[1];
  if (hex === undefined) return PLANNED_FALLBACK;

  const rgb = parseInt(hex, 16);
  const toward = (channel: number): number => Math.round(channel + (255 - channel) * 0.55);
  const r = toward((rgb >> 16) & 0xff);
  const g = toward((rgb >> 8) & 0xff);
  const b = toward(rgb & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export interface BurndownChartProps {
  readonly series: readonly ChartSeries[];
  readonly markers: readonly ChartMarker[];
  /** Hiện cả đường Kế hoạch. Chế độ so sánh chỉ vẽ đường Thực tế. */
  readonly showPlanned: boolean;
  readonly onPointClick?: ((date: string) => void) | undefined;
  readonly width?: number;
  readonly height?: number;
}

interface Row {
  readonly date: string;
  readonly [key: string]: string | number | null;
}

/**
 * Ghép nhiều chuỗi số vào một mảng dòng theo ngày.
 *
 * Trục thời gian lấy từ chính dữ liệu, và dữ liệu từ T-18 vốn CHỈ CÓ ngày làm
 * việc. Tự sinh trục theo ngày lịch sẽ tạo những đoạn nằm ngang giả vào mỗi cuối
 * tuần, và biểu đồ trông như đội nghỉ giữa chừng.
 */
export function toChartRows(series: readonly ChartSeries[]): Row[] {
  const byDate = new Map<string, Record<string, string | number | null>>();

  for (const s of series) {
    for (const p of s.points) {
      let row = byDate.get(p.date);
      if (row === undefined) {
        row = { date: p.date };
        byDate.set(p.date, row);
      }
      // `null` giữ nguyên: Recharts sẽ để LỖ THỦNG thay vì nối tắt hai điểm.
      row[`${s.key}__actual`] = p.actualRemainingHours;
      row[`${s.key}__planned`] = p.plannedRemainingHours;
    }
  }

  return [...byDate.values()].sort((a, b) => String(a['date']).localeCompare(String(b['date']))) as Row[];
}

export function BurndownChart({
  series,
  markers,
  showPlanned,
  onPointClick,
  width = 900,
  height = 380,
}: BurndownChartProps) {
  // Recharts vẽ lại toàn bộ khi props đổi tham chiếu; thiếu `useMemo` là biểu đồ
  // giật mỗi lần rê chuột.
  const rows = useMemo(() => toChartRows(series), [series]);

  return (
    // Kích thước cố định thay vì `ResponsiveContainer`: container đo kích thước
    // cha lúc chạy, và trong môi trường test kích thước đó bằng 0 nên biểu đồ
    // không vẽ gì cả — test xanh mà màn hình trống.
    <LineChart
      width={width}
      height={height}
      data={rows}
      onClick={(state: { activeLabel?: string | number }) => {
        const label = state.activeLabel;
        if (typeof label === 'string' && onPointClick) onPointClick(label);
      }}
    >
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="date" />
      <YAxis label={{ value: 'Hours remaining', angle: -90, position: 'insideLeft' }} />
      <Tooltip />
      <Legend />

      {series.map((s, i) => (
        <Line
          key={`${s.key}-actual`}
          type="monotone"
          dataKey={`${s.key}__actual`}
          name={`${s.label} · Actual`}
          stroke={s.colorHex ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]}
          strokeWidth={2}
          // `connectNulls={false}`: ngày thiếu snapshot phải là LỖ THỦNG NHÌN
          // THẤY ĐƯỢC. Nối tắt qua đó trông đẹp hơn nhưng là bịa ra một tiến độ
          // không có thật (E-12).
          connectNulls={false}
          dot
        />
      ))}

      {showPlanned &&
        series.map((s, i) => (
          <Line
            key={`${s.key}-planned`}
            type="monotone"
            dataKey={`${s.key}__planned`}
            name={`${s.label} · Planned`}
            // Màu khác đường Thực tế — chỉ khác nét đứt thôi thì hai đường dính
            // nhau vẫn không phân biệt nổi.
            stroke={plannedColorOf(s.colorHex ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length] ?? FALLBACK_COLORS[0])}
            strokeDasharray="6 4"
            connectNulls={false}
            dot={false}
          />
        ))}

      {markers.map((m, i) => (
        <ReferenceLine
          key={`${m.type}-${m.date}-${i}`}
          x={m.date}
          stroke={m.type === 'PLAN_SHIFTED' ? '#dc2626' : '#b45309'}
          strokeDasharray="2 2"
          label={{ value: m.type === 'PLAN_SHIFTED' ? '⚑' : '↑', position: 'top' }}
        />
      ))}
    </LineChart>
  );
}
