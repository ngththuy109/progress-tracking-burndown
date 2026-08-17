import { useState } from 'react';

/**
 * Chọn kỳ: This week / Last week / Custom.
 *
 * Tuần bắt đầu Thứ Hai (chuẩn VN, khớp `weekOf` của engine). Preset tính ngày ở
 * phía trình duyệt rồi đẩy vào URL; máy chủ mới là nguồn chân lý cho việc gom
 * worklog theo múi giờ từng Epic, nên phần hiển thị khoảng lấy theo echo của máy
 * chủ (`rangeFrom`/`rangeTo`).
 */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function iso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Tuần Thứ Hai → Chủ nhật chứa `d`, theo ngày địa phương của trình duyệt. */
export function weekOfLocal(d: Date): { from: string; to: string } {
  // getDay(): CN = 0 … T7 = 6. Đổi sang "số ngày kể từ Thứ Hai" (T2 = 0 … CN = 6).
  const fromMonday = (d.getDay() + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - fromMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { from: iso(monday), to: iso(sunday) };
}

export interface PeriodPickerProps {
  readonly from: string | null;
  readonly to: string | null;
  /** Khoảng máy chủ trả về — dùng để hiển thị khi URL chưa có from/to. */
  readonly rangeFrom: string;
  readonly rangeTo: string;
  readonly partialPeriod: boolean;
  readonly onChange: (from: string | null, to: string | null) => void;
}

export function PeriodPicker({ from, to, rangeFrom, rangeTo, partialPeriod, onChange }: PeriodPickerProps) {
  const now = new Date();
  const thisWeek = weekOfLocal(now);
  const lastWeek = weekOfLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));

  const active: 'this' | 'last' | 'custom' =
    (from === null && to === null) || (from === thisWeek.from && to === thisWeek.to)
      ? 'this'
      : from === lastWeek.from && to === lastWeek.to
        ? 'last'
        : 'custom';

  const [customFrom, setCustomFrom] = useState(from ?? rangeFrom);
  const [customTo, setCustomTo] = useState(to ?? rangeTo);

  const tab = (key: 'this' | 'last' | 'custom', label: string, onClick: () => void) => (
    <button
      type="button"
      className={`tab${active === key ? ' tab--active' : ''}`}
      aria-pressed={active === key}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div className="scope" role="group" aria-label="Period">
      <span className="scope__label">Period:</span>
      <div className="tabs">
        {tab('this', 'This week', () => onChange(thisWeek.from, thisWeek.to))}
        {tab('last', 'Last week', () => onChange(lastWeek.from, lastWeek.to))}
        {tab('custom', 'Custom', () => onChange(customFrom, customTo))}
      </div>

      {active === 'custom' && (
        <span className="field" style={{ marginTop: 0, gap: 6 }}>
          <input
            className="input"
            type="date"
            value={customFrom}
            max={customTo}
            aria-label="From date"
            onChange={(e) => {
              setCustomFrom(e.target.value);
              if (e.target.value !== '' && customTo !== '') onChange(e.target.value, customTo);
            }}
          />
          <span aria-hidden="true">→</span>
          <input
            className="input"
            type="date"
            value={customTo}
            min={customFrom}
            aria-label="To date"
            onChange={(e) => {
              setCustomTo(e.target.value);
              if (customFrom !== '' && e.target.value !== '') onChange(customFrom, e.target.value);
            }}
          />
        </span>
      )}

      <span className="muted">
        {rangeFrom} <span aria-hidden="true">→</span> {rangeTo}
        {partialPeriod ? ' · expected prorated to workdays elapsed' : ''}
      </span>
    </div>
  );
}
