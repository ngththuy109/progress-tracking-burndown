import { useEffect, useState } from 'react';

/**
 * Chọn kỳ: This week / Last week / Custom.
 *
 * Tuần bắt đầu Thứ Hai (chuẩn VN, khớp `weekOf` của engine). Preset tính ngày ở
 * phía trình duyệt rồi đẩy vào URL; máy chủ mới là nguồn chân lý cho việc gom
 * worklog theo múi giờ từng Epic, nên phần hiển thị khoảng lấy theo echo của máy
 * chủ (`rangeFrom`/`rangeTo`).
 *
 * "Custom" cho nhập KHOẢNG NGÀY TUỲ Ý: hai ô ngày chỉ sửa bản nháp tại chỗ, phải
 * bấm "Search" (hoặc Enter) mới áp dụng. Trước đây mỗi lần chạm một ô là đổi URL
 * ngay → đổi queryKey → cả màn hình chớp sang khung "đang tải" và bộ chọn biến
 * mất giữa chừng, nên gần như không đặt nổi hai đầu của một khoảng. Tách "sửa" ra
 * khỏi "tìm" chữa đúng chỗ đó; kiểm tra hợp lệ ngay tại trình duyệt để không bắn
 * một request chắc chắn hỏng.
 */

/** Chặn quét worklog cả năm do nhập khoảng vô lý — KHỚP `MAX_RANGE_DAYS` của API. */
const MAX_RANGE_DAYS = 366;

type Mode = 'this' | 'last' | 'custom';

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

/**
 * Số ngày giữa hai chuỗi `YYYY-MM-DD` (bao gồm cả hai đầu ở tầng API, ở đây là
 * hiệu thuần). Trả `null` khi một trong hai không đọc được thành ngày.
 */
function spanDays(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Câu báo lỗi cho một khoảng nháp, hoặc `null` khi hợp lệ để tìm. */
export function customRangeError(from: string, to: string): string | null {
  if (from === '' || to === '') return 'Pick both a start and an end date.';
  // So chuỗi 'YYYY-MM-DD' là đúng cho thứ tự ngày.
  if (to < from) return 'The end date must be on or after the start date.';
  const span = spanDays(from, to);
  if (span !== null && span > MAX_RANGE_DAYS) {
    return `That range is longer than ${MAX_RANGE_DAYS} days — pick a shorter window.`;
  }
  return null;
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

  // Kỳ ĐANG áp dụng: từ URL nếu có, không thì lấy echo của máy chủ.
  const appliedFrom = from ?? rangeFrom;
  const appliedTo = to ?? rangeTo;
  const appliedMode: Mode =
    (from === null && to === null) || (appliedFrom === thisWeek.from && appliedTo === thisWeek.to)
      ? 'this'
      : appliedFrom === lastWeek.from && appliedTo === lastWeek.to
        ? 'last'
        : 'custom';

  // Tab đang chọn + bản nháp của khoảng Custom. Là trạng thái GIAO DIỆN: bấm
  // "Custom" mở panel mà chưa tìm; gõ ngày chỉ đổi nháp, chưa đổi URL.
  const [mode, setMode] = useState<Mode>(appliedMode);
  const [draftFrom, setDraftFrom] = useState(appliedFrom);
  const [draftTo, setDraftTo] = useState(appliedTo);
  const [error, setError] = useState<string | null>(null);

  // Khi kỳ ĐÃ ÁP DỤNG đổi (bấm preset, Search, hay back/forward trình duyệt), đồng
  // bộ tab + nháp theo nó. Chỉ phụ thuộc khoảng đã áp dụng — KHÔNG phụ thuộc
  // `mode` — nên bấm "Custom" (không đổi URL) không bị hiệu ứng này đóng lại.
  useEffect(() => {
    setMode(appliedMode);
    setDraftFrom(appliedFrom);
    setDraftTo(appliedTo);
    setError(null);
    // Chỉ chạy lại khi khoảng ĐÃ ÁP DỤNG đổi; `appliedMode` được suy ra từ chính
    // hai giá trị này nên đọc từ closure là đủ và đúng.
  }, [appliedFrom, appliedTo]);

  const search = (): void => {
    const message = customRangeError(draftFrom, draftTo);
    if (message !== null) {
      setError(message);
      return;
    }
    setError(null);
    onChange(draftFrom, draftTo);
  };

  const tab = (key: Mode, label: string, onClick: () => void) => (
    <button
      type="button"
      className={`tab${mode === key ? ' tab--active' : ''}`}
      aria-pressed={mode === key}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div className="scope" role="group" aria-label="Period">
      <span className="scope__label">Period:</span>
      <div className="tabs">
        {tab('this', 'This week', () => {
          setMode('this');
          onChange(thisWeek.from, thisWeek.to);
        })}
        {tab('last', 'Last week', () => {
          setMode('last');
          onChange(lastWeek.from, lastWeek.to);
        })}
        {tab('custom', 'Custom', () => {
          setError(null);
          setMode('custom');
        })}
      </div>

      {mode === 'custom' && (
        <form
          className="field"
          style={{ marginTop: 0, gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <input
            className="input"
            type="date"
            value={draftFrom}
            aria-label="From date"
            onChange={(e) => {
              setDraftFrom(e.target.value);
              setError(null);
            }}
          />
          <span aria-hidden="true">→</span>
          <input
            className="input"
            type="date"
            value={draftTo}
            aria-label="To date"
            onChange={(e) => {
              setDraftTo(e.target.value);
              setError(null);
            }}
          />
          <button type="submit" className="button button--primary">
            Search
          </button>
          {error !== null && (
            <span className="notice notice--warning" role="alert">
              {error}
            </span>
          )}
        </form>
      )}

      <span className="muted">
        {rangeFrom} <span aria-hidden="true">→</span> {rangeTo}
        {partialPeriod ? ' · expected prorated to workdays elapsed' : ''}
      </span>
    </div>
  );
}
