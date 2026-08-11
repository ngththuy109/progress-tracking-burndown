import { useMemo, type ReactElement } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
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

/** Nền ngày nghỉ: xám nhạt, đủ nhận ra dải nghỉ mà không đè lên hai đường dữ liệu. */
const OFF_DAY_FILL = '#9ca3af';
const OFF_DAY_FILL_OPACITY = 0.18;

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
  /** `true` = ngày nghỉ theo lịch (cuối tuần / ngày lễ), chèn thêm cho trục liền mạch. */
  readonly offDay?: boolean;
  readonly [key: string]: string | number | null | boolean | undefined;
}

const DAY_MS = 86_400_000;

/** Các ngày lịch nằm GIỮA hai ngày `'YYYY-MM-DD'`, không tính hai đầu. Tính theo UTC nên không dính DST. */
function calendarDaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`) + DAY_MS; t < Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Ghép nhiều chuỗi số vào một mảng dòng theo ngày, RỒI chèn thêm ngày nghỉ.
 *
 * Dữ liệu API chỉ có NGÀY LÀM VIỆC (T-18) — mọi ngày lịch bị khuyết giữa hai
 * điểm liên tiếp chính là ngày nghỉ theo lịch của Epic. Trước đây trục bỏ hẳn
 * những ngày đó để khỏi sinh đoạn nằm ngang giả, nhưng người đọc lại thấy
 * "biểu đồ mất ngày": Thứ 7/CN biến mất và khó đối chiếu với lịch thật.
 *
 * Quyết định mới (2026-08, theo yêu cầu người dùng): ngày nghỉ VẪN LÊN TRỤC,
 * giá trị kéo phẳng từ ngày làm việc liền trước — đoạn nằm ngang giờ là chủ
 * đích, và được BÔI XÁM (xem `offDayRuns`) để ai cũng đọc ra "ngày nghỉ" chứ
 * không phải "đội đứng yên".
 *
 * Hai điều KHÔNG đổi:
 *  • Ngày làm việc thiếu snapshot vẫn là LỖ THỦNG `null`, và ngày nghỉ ngay
 *    sau nó cũng giữ `null` — tuyệt đối không bịa số (E-12).
 *  • Không đụng API: đây là quyết định trình bày, thuộc tầng hiển thị.
 */
export function toChartRows(series: readonly ChartSeries[]): Row[] {
  const byDate = new Map<string, Record<string, string | number | null | boolean>>();

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

  const workRows = [...byDate.values()].sort((a, b) =>
    String(a['date']).localeCompare(String(b['date'])),
  );

  const rows: Row[] = [];
  for (let i = 0; i < workRows.length; i += 1) {
    const cur = workRows[i]!;
    rows.push(cur as Row);

    const next = workRows[i + 1];
    if (next === undefined) continue;

    for (const day of calendarDaysBetween(String(cur['date']), String(next['date']))) {
      const off: Record<string, string | number | null | boolean> = { date: day, offDay: true };
      for (const s of series) {
        // Kéo phẳng từ ngày làm việc liền trước. Ngày trước là lỗ thủng thì
        // ngày nghỉ cũng là lỗ thủng — nối qua đó là bịa ra dữ liệu.
        off[`${s.key}__actual`] = (cur[`${s.key}__actual`] as number | null | undefined) ?? null;
        off[`${s.key}__planned`] = (cur[`${s.key}__planned`] as number | null | undefined) ?? null;
      }
      rows.push(off as Row);
    }
  }

  return rows;
}

/**
 * Gom các ngày nghỉ LIỀN NHAU thành từng dải để tô một khối xám cho cả dải
 * (T7+CN là một dải, tuần nghỉ Tết là một dải dài).
 *
 * Hạn chế đã biết: trục category của Recharts đặt mỗi ngày ở MỘT ĐIỂM, nên dải
 * chỉ có một ngày (ngày lễ lẻ giữa tuần) rộng 0px — không nhìn thấy khối xám,
 * nhưng vẫn còn nhãn tooltip "day off" và điểm dữ liệu bị ẩn.
 */
export function offDayRuns(rows: readonly Row[]): { from: string; to: string }[] {
  const runs: { from: string; to: string }[] = [];
  let open: { from: string; to: string } | null = null;

  for (const r of rows) {
    if (r.offDay === true) {
      if (open === null) {
        open = { from: r.date, to: r.date };
        runs.push(open);
      } else {
        open.to = r.date;
      }
    } else {
      open = null;
    }
  }
  return runs;
}

/**
 * Chấm dữ liệu tự vẽ: GIẤU chấm trên ngày nghỉ. Giá trị ngày nghỉ chỉ là kéo
 * phẳng từ ngày làm việc trước đó — vẽ chấm ở đó trông như có số liệu đo thật.
 */
function workdayOnlyDot(props: {
  key?: string | number;
  cx?: number;
  cy?: number;
  stroke?: string;
  payload?: Row;
}): ReactElement {
  const { cx, cy, stroke, payload } = props;
  if (payload?.offDay === true || typeof cx !== 'number' || typeof cy !== 'number' || !Number.isFinite(cx) || !Number.isFinite(cy)) {
    return <g key={props.key} />;
  }
  return <circle key={props.key} cx={cx} cy={cy} r={3} stroke={stroke} strokeWidth={1} fill="#fff" />;
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
  const offRuns = useMemo(() => offDayRuns(rows), [rows]);
  const offDays = useMemo(
    () => new Set(rows.filter((r) => r.offDay === true).map((r) => r.date)),
    [rows],
  );

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
        // Ngày nghỉ không có snapshot — mở bảng giải thích cho nó chỉ ra một
        // màn hình "lệch số" vô nghĩa.
        if (typeof label === 'string' && !offDays.has(label) && onPointClick) onPointClick(label);
      }}
    >
      <CartesianGrid strokeDasharray="3 3" />

      {/* Dải xám cho ngày nghỉ — vẽ TRƯỚC các đường để nằm dưới chúng. */}
      {offRuns.map((r) => (
        <ReferenceArea
          key={`off-${r.from}`}
          x1={r.from}
          x2={r.to}
          fill={OFF_DAY_FILL}
          fillOpacity={OFF_DAY_FILL_OPACITY}
          stroke="none"
        />
      ))}

      <XAxis dataKey="date" />
      <YAxis label={{ value: 'Hours remaining', angle: -90, position: 'insideLeft' }} />
      <Tooltip
        labelFormatter={(label) =>
          offDays.has(String(label)) ? `${String(label)} — day off` : String(label)
        }
      />
      <Legend />

      {/*
        CẦU NỐI cho đường Thực tế: cùng dữ liệu nhưng `connectNulls`, nét đứt
        mờ, vẽ TRƯỚC để nằm DƯỚI đường chính. Ở đâu có dữ liệu thật, đường chính
        đè khít lên nó; chỗ thiếu snapshot chỉ còn nét đứt mờ hiện ra — người
        xem thấy MẠCH LIỀN (yêu cầu 2026-08) nhưng vẫn phân biệt được đoạn nào
        là nối ước lượng chứ không phải số đo thật (E-12 giữ theo tinh thần:
        đoạn thiếu trông KHÁC hẳn, kèm banner đỏ liệt kê đúng những ngày thiếu).
      */}
      {series.map((s, i) => (
        <Line
          key={`${s.key}-actual-bridge`}
          type="monotone"
          dataKey={`${s.key}__actual`}
          stroke={s.colorHex ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]}
          strokeWidth={1.5}
          strokeOpacity={0.55}
          strokeDasharray="4 4"
          connectNulls
          dot={false}
          activeDot={false}
          // Không vào chú giải lẫn tooltip: đây là nét phụ trợ của chính đường
          // Thực tế, không phải một chuỗi số riêng.
          legendType="none"
          tooltipType="none"
        />
      ))}

      {series.map((s, i) => (
        <Line
          key={`${s.key}-actual`}
          type="monotone"
          dataKey={`${s.key}__actual`}
          name={`${s.label} · Actual`}
          stroke={s.colorHex ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]}
          strokeWidth={2}
          // `connectNulls={false}` trên ĐƯỜNG CHÍNH: đoạn qua ngày thiếu
          // snapshot không được vẽ nét liền — nét liền là cam kết "số đo thật".
          // Mạch liền mà người xem thấy do CẦU NỐI nét đứt phía trên đảm nhận;
          // ngày nghỉ thì không tạo lỗ thủng vì đã kéo phẳng trong
          // `toChartRows` (E-12).
          connectNulls={false}
          dot={workdayOnlyDot}
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
