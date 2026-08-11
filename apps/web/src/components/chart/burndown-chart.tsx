import { useMemo, type ReactElement } from 'react';
import {
  CartesianGrid,
  Customized,
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

/** Nền ngày nghỉ: xám nhạt, đủ nhận ra dải nghỉ mà không đè lên hai đường dữ liệu. */
const OFF_DAY_FILL = '#9ca3af';
const OFF_DAY_FILL_OPACITY = 0.18;

/** Đường Kế hoạch làm ĐẬM hơn màu Thực tế bao nhiêu — pha 40% về phía đen. */
const PLANNED_DARKEN = 0.4;

/**
 * Màu của đường Kế hoạch, suy ra từ màu đường Thực tế cùng Phase.
 *
 * Pha 40% về phía ĐEN: đường Kế hoạch trước đây pha về trắng nên quá nhạt, gần
 * như chìm vào nền (PM báo khó nhìn). Nay làm ĐẬM hơn hẳn màu Thực tế — vẫn
 * cùng tông để mắt gom được cặp Kế hoạch / Thực tế của cùng một Phase, nhưng
 * nổi rõ; nét đứt đậm bên dưới lo phần phân biệt với đường Thực tế.
 */
export function plannedColorOf(actualHex: string): string {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(actualHex.trim())?.[1];
  if (hex === undefined) return PLANNED_FALLBACK;

  const rgb = parseInt(hex, 16);
  const toward = (channel: number): number => Math.round(channel * (1 - PLANNED_DARKEN));
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
  /** `true` = ngày nghỉ theo lịch (cuối tuần / ngày lễ). */
  readonly offDay?: boolean;
  /** Ngày này có SỐ ĐO THẬT (snapshot với actual ≠ null) — team làm cuối tuần. */
  readonly hasData?: boolean;
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
 * Ghép nhiều chuỗi số vào một mảng dòng theo ngày — trục vẽ ĐỦ ngày lịch,
 * ngày nghỉ bôi xám (quyết định 2026-08).
 *
 * Ngày nghỉ có hai dạng:
 *  • CÓ snapshot (team làm Thứ 7/CN): API phát điểm `isOffDay` kèm SỐ THẬT —
 *    vẽ y như ngày thường (đường giảm đúng hôm làm, có chấm dữ liệu), chỉ khác
 *    là nằm trong dải xám.
 *  • KHÔNG có số liệu (nghỉ thật, hoặc phản hồi cũ trong cache chưa phát ngày
 *    nghỉ): kéo phẳng từ dòng liền trước và đánh dấu `__carried` — đoạn nằm
 *    ngang chủ đích, không chấm, không bấm được.
 *
 * KHÔNG đổi: ngày làm việc thiếu snapshot vẫn là LỖ THỦNG `null`, và ngày nghỉ
 * ngay sau nó cũng giữ `null` — tuyệt đối không bịa số (E-12).
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
      if (p.isOffDay === true) row['offDay'] = true;
      // Ngày có SỐ ĐO THẬT: chấm dữ liệu hiện và bấm mở bảng giải thích được.
      if (p.actualRemainingHours !== null) row['hasData'] = true;
    }
  }

  const sorted = [...byDate.values()].sort((a, b) =>
    String(a['date']).localeCompare(String(b['date'])),
  );

  // Chèn ngày lịch còn khuyết giữa hai điểm liên tiếp — đường lui cho phản hồi
  // CŨ trong cache (chưa phát ngày nghỉ). Phản hồi mới đã phát đủ ngày lịch nên
  // vòng này không chèn gì.
  const rows: Record<string, string | number | null | boolean>[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const cur = sorted[i]!;
    rows.push(cur);

    const next = sorted[i + 1];
    if (next === undefined) continue;

    for (const day of calendarDaysBetween(String(cur['date']), String(next['date']))) {
      const off: Record<string, string | number | null | boolean> = { date: day, offDay: true };
      for (const s of series) {
        off[`${s.key}__actual`] = null;
        off[`${s.key}__planned`] = null;
      }
      rows.push(off);
    }
  }

  // Kéo phẳng ngày nghỉ CHƯA có số liệu từ dòng liền trước (kể cả giá trị đã
  // kéo — chuỗi T7 rồi CN nối tiếp nhau). Dòng trước là lỗ thủng thì ngày nghỉ
  // cũng là lỗ thủng: nối qua đó là bịa ra dữ liệu.
  const keys = series.map((s) => s.key);
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row['offDay'] !== true) continue;
    const prev = rows[i - 1]!;

    for (const key of keys) {
      for (const field of [`${key}__actual`, `${key}__planned`]) {
        if (row[field] == null && typeof prev[field] === 'number') {
          row[field] = prev[field];
          row[`${field}__carried`] = true;
        }
      }
    }
  }

  return rows as Row[];
}

/**
 * Gom các ngày nghỉ LIỀN NHAU thành từng dải để tô một khối xám cho cả dải
 * (T7+CN là một dải, tuần nghỉ Tết là một dải dài).
 *
 * Dải MỘT ngày (ngày lễ lẻ giữa tuần) vẫn hợp lệ: `OffDayBands` tô theo pixel,
 * nới nửa ô mỗi bên nên dải một ngày rộng đúng một ô và NHÌN THẤY được — trước
 * đây tô bằng `ReferenceArea` từ điểm-tới-điểm thì dải một ngày rộng 0px, mất hút.
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
 * Chấm dữ liệu tự vẽ: GIẤU chấm trên giá trị KÉO PHẲNG (`__carried`) — đó không
 * phải số đo thật. Ngày nghỉ mà team có làm (snapshot thật) thì chấm VẪN hiện:
 * chấm là dấu hiệu "có số đo", không phải "là ngày làm việc".
 */
export function measuredOnlyDot(props: {
  key?: string | number;
  cx?: number;
  cy?: number;
  stroke?: string;
  dataKey?: string | number;
  payload?: Row;
}): ReactElement {
  const { cx, cy, stroke, dataKey, payload } = props;

  const carried =
    typeof dataKey === 'string'
      ? payload?.[`${dataKey}__carried`] === true
      : // Recharts đời khác không truyền dataKey: lùi về quy tắc thô — ngày nghỉ
        // không có số đo thật thì ẩn chấm.
        payload?.offDay === true && payload?.hasData !== true;

  if (carried || typeof cx !== 'number' || typeof cy !== 'number' || !Number.isFinite(cx) || !Number.isFinite(cy)) {
    return <g key={props.key} />;
  }
  return <circle key={props.key} cx={cx} cy={cy} r={3} stroke={stroke} strokeWidth={1} fill="#fff" />;
}

/**
 * Bề rộng gần đúng một nhãn ngày `YYYY-MM-DD` cần để không chồng lên nhau (px).
 * Dùng để giãn nhãn cho thưa; VẠCH LƯỚI vẫn một vạch mỗi ngày.
 */
const DAY_LABEL_WIDTH_PX = 78;

/**
 * Chọn tập ngày ĐƯỢC GHI NHÃN sao cho nhãn không chồng nhau, giãn đều.
 *
 * Trục vẫn có MỘT tick mỗi ngày (`interval={0}` bên dưới) nên lưới phân định đều
 * từng ngày; chỉ nhãn là thưa bớt. Ẩn nhãn KHÔNG làm mất vạch lưới vì lưới bám
 * theo vị trí tick, không theo việc có vẽ chữ hay không.
 */
export function labelledDates(dates: readonly string[], plotWidthPx: number): Set<string> {
  const maxLabels = Math.max(2, Math.floor(plotWidthPx / DAY_LABEL_WIDTH_PX));
  const step = Math.max(1, Math.ceil(dates.length / maxLabels));
  return new Set(dates.filter((_, i) => i % step === 0));
}

/**
 * Nhãn trục ngày: chỉ vẽ chữ cho ngày nằm trong `shown`, còn lại trả về nhóm
 * rỗng. Tick (và vạch lưới) của mọi ngày vẫn do Recharts vẽ như thường.
 */
export function dayAxisTick(
  props: { x?: number; y?: number; payload?: { value?: string | number } },
  shown: ReadonlySet<string>,
): ReactElement {
  const { x, y, payload } = props;
  const value = String(payload?.value ?? '');
  if (!shown.has(value) || typeof x !== 'number' || typeof y !== 'number') return <g />;
  return (
    <g transform={`translate(${x},${y})`}>
      <text dy={12} textAnchor="middle" fontSize={11} fill="#4b5563">
        {value}
      </text>
    </g>
  );
}

/** Trục X mà Recharts bơm vào `<Customized>` — chỉ khai phần dải ngày nghỉ dùng. */
interface InjectedAxis {
  readonly scale?: (value: string) => number | undefined;
}

interface OffDayBandsProps {
  readonly runs: readonly { from: string; to: string }[];
  readonly rows: readonly Row[];
  // Recharts tự bơm hai prop dưới đây vào con của `<Customized>` lúc chạy.
  readonly xAxisMap?: Record<string, InjectedAxis>;
  readonly offset?: {
    readonly top?: number;
    readonly left?: number;
    readonly width?: number;
    readonly height?: number;
  };
}

/**
 * Tô xám ngày nghỉ theo PIXEL — mỗi ngày đúng MỘT ô, kể cả ngày lễ LẺ giữa tuần.
 *
 * `ReferenceArea` cũ tô từ điểm ngày đầu đến điểm ngày cuối của dải, nên dải chỉ
 * một ngày (ngày lễ lẻ, hai bên là ngày làm việc) rộng 0px và biến mất. Ở đây lấy
 * hàm `scale` của trục để biết bề rộng một ô rồi nới mỗi dải NỬA Ô ra hai bên:
 * cuối tuần phủ trọn hai ô T7+CN, còn ngày lễ lẻ vẫn được một ô đầy đủ — nhìn rõ.
 *
 * Là con của `<Customized>` nên Recharts tự bơm `xAxisMap` và `offset`; hai prop
 * `runs`/`rows` thì màn hình truyền thẳng vào.
 */
export function OffDayBands({ runs, rows, xAxisMap, offset }: OffDayBandsProps): ReactElement | null {
  const axisId = xAxisMap === undefined ? undefined : Object.keys(xAxisMap)[0];
  const scale = axisId === undefined ? undefined : xAxisMap?.[axisId]?.scale;
  const { top, left, width: plotWidth, height: plotHeight } = offset ?? {};

  if (
    typeof scale !== 'function' ||
    typeof top !== 'number' ||
    typeof left !== 'number' ||
    typeof plotWidth !== 'number' ||
    typeof plotHeight !== 'number' ||
    rows.length === 0
  ) {
    // Chưa đo được trục (lần vẽ đầu / môi trường không có layout): bỏ qua, để
    // biểu đồ vẫn chạy — chỉ là chưa có dải xám.
    return null;
  }

  // Bề rộng một ô suy TỪ CHÍNH scale (khoảng cách hai ngày liền nhau) nên đúng
  // với mọi kiểu trục và mọi lề. Chỉ có đúng một ngày thì lấy cả vùng vẽ.
  const firstX = scale(rows[0]!.date);
  const secondX = rows.length >= 2 ? scale(rows[1]!.date) : undefined;
  const slot =
    typeof firstX === 'number' && typeof secondX === 'number' ? Math.abs(secondX - firstX) : plotWidth;
  const plotRight = left + plotWidth;

  return (
    // `pointerEvents="none"`: dải chỉ để trang trí, không được nuốt cú bấm/rê
    // chuột — Recharts vẫn nhận đúng sự kiện để mở bảng giải thích và tooltip.
    <g className="recharts-offday-bands" pointerEvents="none">
      {runs.map((run) => {
        const a = scale(run.from);
        const b = scale(run.to);
        if (typeof a !== 'number' || typeof b !== 'number') return null;
        // Nới nửa ô ra hai đầu để một ngày cũng có bề rộng bằng một ô; kẹp trong
        // vùng vẽ để ngày nghỉ ở sát mép không tràn ra ngoài.
        const x1 = Math.max(left, Math.min(a, b) - slot / 2);
        const x2 = Math.min(plotRight, Math.max(a, b) + slot / 2);
        if (x2 <= x1) return null;
        return (
          <rect
            key={`off-${run.from}`}
            className="offday-band"
            x={x1}
            y={top}
            width={x2 - x1}
            height={plotHeight}
            fill={OFF_DAY_FILL}
            fillOpacity={OFF_DAY_FILL_OPACITY}
          />
        );
      })}
    </g>
  );
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
  // Ngày KHÔNG bấm được: ngày nghỉ không có số đo thật — bảng giải thích không
  // có snapshot nào để giải thích. Ngày nghỉ team CÓ làm thì bấm bình thường.
  const unclickableDays = useMemo(
    () => new Set(rows.filter((r) => r.offDay === true && r.hasData !== true).map((r) => r.date)),
    [rows],
  );
  // Nhãn ngày giãn theo bề rộng vẽ được (trừ hao trục Y + lề) để khỏi chồng chữ;
  // vạch lưới thì vẫn một vạch mỗi ngày nhờ `interval={0}` trên XAxis.
  const labelDates = useMemo(
    () => labelledDates(rows.map((r) => r.date), Math.max(120, width - 90)),
    [rows, width],
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
        if (typeof label === 'string' && !unclickableDays.has(label) && onPointClick) onPointClick(label);
      }}
    >
      <CartesianGrid strokeDasharray="3 3" />

      {/*
        Dải xám ngày nghỉ — khai TRƯỚC các đường để nằm DƯỚI chúng. Tô theo PIXEL
        qua `<Customized>` (mỗi ngày một ô) thay cho `<ReferenceArea>` cũ vốn làm
        ngày lễ lẻ giữa tuần rộng 0px và biến mất.
      */}
      <Customized component={OffDayBands} runs={offRuns} rows={rows} />

      {/*
        `interval={0}`: MỘT tick — và do đó MỘT vạch lưới — cho MỖI ngày, để các
        đường phân định ngày đều nhau (trước đây Recharts tự bỏ bớt tick nên chỗ
        có chỗ không). Nhãn ngày vẫn thưa qua `dayAxisTick` cho khỏi chồng chữ.
      */}
      <XAxis
        dataKey="date"
        interval={0}
        tick={(props: { x?: number; y?: number; payload?: { value?: string | number } }) =>
          dayAxisTick(props, labelDates)
        }
      />
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
          // ngày nghỉ thì không tạo lỗ thủng vì hoặc có snapshot thật (team làm
          // cuối tuần) hoặc đã kéo phẳng trong `toChartRows` (E-12).
          connectNulls={false}
          dot={measuredOnlyDot}
        />
      ))}

      {showPlanned &&
        series.map((s, i) => (
          <Line
            key={`${s.key}-planned`}
            type="monotone"
            dataKey={`${s.key}__planned`}
            name={`${s.label} · Planned`}
            // Màu ĐẬM hơn đường Thực tế + nét ĐẬM + nét đứt to: đường Kế hoạch cũ
            // pha trắng mảnh nên gần như vô hình (PM báo khó nhìn). Nay dày và tối
            // để đọc rõ, nét đứt to vẫn phân biệt được với đường Thực tế nét liền.
            stroke={plannedColorOf(s.colorHex ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length] ?? FALLBACK_COLORS[0])}
            strokeWidth={2.5}
            strokeDasharray="8 4"
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
