import {
  logworkCellFlag,
  type LogworkByPicRow,
  type LogworkCellFlag,
  type LogworkCellTicket,
} from '@app/shared';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLogworkByPic } from '../../api/use-logwork.js';
import { IssueLink } from '../../components/issue-link/index.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/index.js';
import { PeriodPicker } from './period-picker.js';

/**
 * Báo cáo LƯỚI: PIC × ngày.
 *
 * Hàng là PIC (mọi người CÓ log giờ trong kỳ), cột là từng ngày lịch trong
 * khoảng đã chọn, ô là tổng giờ người đó log ngày đó. Bốn dấu (NGUỒN CHÂN LÝ
 * chung `logworkCellFlag`, khớp với API):
 *   - `under` (`<= 4h`) / `over` (`> 8h`): ngày làm việc nhưng log lệch ngưỡng.
 *   - `missing`: ngày LÀM VIỆC đã qua mà KHÔNG log gì (ô trống có gạch chéo).
 *   - `offday`: ngày NGHỈ (cuối tuần/lễ) mà LẠI có log (ô xanh dương).
 * Ngày làm việc/ngày nghỉ đến từ `workingDays` của server (đã tính cả ngày lễ +
 * ngày làm bù của lịch tham chiếu), không chỉ đoán theo Thứ Bảy/Chủ Nhật.
 *
 * Rê chuột (hoặc Tab tới) một ô CÓ log → mở thẻ nổi liệt kê ticket đã log ngày
 * đó, mỗi mã là link mở thẳng sang Jira.
 *
 * Bảng cuộn ngang trong `.table-wrap`; cột PIC ghim trái để tên luôn thấy khi
 * kéo qua nhiều ngày. Thẻ nổi portal ra `<body>` (`position: fixed`) để KHÔNG bị
 * `.table-wrap` (overflow) cắt mất ở hàng/cột cuối.
 */

/** Bỏ số 0 thừa: `6.00` → `6`, `8.4` giữ nguyên. (Trùng nhỏ với màn member.) */
function formatHours(hours: number): string {
  return String(Number(hours.toFixed(2)));
}

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Nhãn cột cho một ngày 'YYYY-MM-DD'. */
function dateColumn(iso: string): { weekday: string; label: string } {
  const [y, m, d] = iso.split('-').map(Number);
  // Dựng ở UTC để thứ trong tuần KHÔNG phụ thuộc múi giờ trình duyệt.
  const dow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return { weekday: WEEKDAY_ABBR[dow] ?? '', label: `${m}/${d}` };
}

/** Lớp CSS cho một ô theo dấu của nó. Ô không dấu, không giờ → mờ đi (`--empty`). */
function cellClass(flag: LogworkCellFlag, hasHours: boolean): string {
  const base = 'logwork-grid__cell';
  switch (flag) {
    case 'under':
      return `${base} logwork-grid__cell--under`;
    case 'over':
      return `${base} logwork-grid__cell--over`;
    case 'missing':
      return `${base} logwork-grid__cell--missing`;
    case 'offday':
      return `${base} logwork-grid__cell--offday`;
    default:
      return hasHours ? base : `${base} logwork-grid__cell--empty`;
  }
}

export function PicDailyGrid({
  from,
  to,
  onChangePeriod,
}: {
  readonly from: string | null;
  readonly to: string | null;
  readonly onChangePeriod: (from: string | null, to: string | null) => void;
}) {
  const query = useLogworkByPic(from, to);

  if (query.isPending) return <LoadingState label="Loading log work…" rows={5} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load the log-work grid"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const data = query.data;
  const columns = data.dates.map(dateColumn);
  const dayOff = data.workingDays.map((w) => !w);
  const totalWarn = data.rows.reduce((acc, r) => acc + r.warnCount, 0);
  const totalMissing = data.rows.reduce((acc, r) => acc + r.missingCount, 0);
  const totalOffday = data.rows.reduce((acc, r) => acc + r.offdayCount, 0);
  const totalFlags = totalWarn + totalMissing + totalOffday;

  return (
    <>
      <PeriodPicker
        from={from}
        to={to}
        rangeFrom={data.from}
        rangeTo={data.to}
        partialPeriod={false}
        onChange={onChangePeriod}
      />

      <div className="scope">
        <p className="muted" style={{ margin: 0 }}>
          {data.rows.length} PIC{data.rows.length === 1 ? '' : 's'} · {data.dates.length} day
          {data.dates.length === 1 ? '' : 's'} · {formatHours(data.grandTotal)}h logged ·{' '}
          {totalFlags} cell{totalFlags === 1 ? '' : 's'} to review
        </p>
        {query.isFetching && (
          <span className="muted" role="status" aria-live="polite">
            Updating…
          </span>
        )}
      </div>

      <p className="muted">
        A working day is flagged when a PIC logs{' '}
        <span className="logwork-grid__swatch logwork-grid__swatch--under" /> ≤ {formatHours(data.underLimitHours)}h
        (under) or <span className="logwork-grid__swatch logwork-grid__swatch--over" /> &gt;{' '}
        {formatHours(data.overLimitHours)}h (over), or{' '}
        <span className="logwork-grid__swatch logwork-grid__swatch--missing" /> nothing at all on a past working
        day (missing). A day off with any worklog is flagged{' '}
        <span className="logwork-grid__swatch logwork-grid__swatch--offday" /> (logged on a day off). Hover a
        logged cell to open the tickets logged that day. Counts worklog across{' '}
        <strong>every synced Epic</strong> — all projects, any tracking status.
      </p>

      {data.warnings.map((w) => (
        <p key={w} className="notice notice--warning">
          {w}
        </p>
      ))}

      {data.rows.length === 0 ? (
        <EmptyState
          icon="🗓️"
          title="No worklog in this period"
          description="No synced Epic has any worklog in the selected range. Pick another period."
        />
      ) : (
        <div className="table-wrap">
          <table className="table logwork-grid">
            <caption className="table__caption">
              Hours logged per PIC per day ({data.from} → {data.to})
            </caption>
            <thead>
              <tr>
                <th scope="col" className="logwork-grid__sticky logwork-grid__corner">
                  PIC
                </th>
                {columns.map((c, i) => (
                  <th
                    key={data.dates[i]}
                    scope="col"
                    className={`logwork-grid__day${dayOff[i] ? ' logwork-grid__day--weekend' : ''}`}
                    title={`${data.dates[i]}${dayOff[i] ? ' · day off' : ''}`}
                  >
                    <span className="logwork-grid__weekday">{c.weekday}</span>
                    <span className="logwork-grid__date">{c.label}</span>
                  </th>
                ))}
                <th scope="col" className="logwork-grid__total-head">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <GridRow
                  key={row.accountId}
                  row={row}
                  dates={data.dates}
                  workingDays={data.workingDays}
                  today={data.today}
                  dayOff={dayOff}
                  columns={columns}
                />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="logwork-grid__sticky logwork-grid__foot-label">
                  Total
                </th>
                {data.dailyTotals.map((t, i) => (
                  <td
                    key={data.dates[i]}
                    className={`logwork-grid__foot${dayOff[i] ? ' logwork-grid__day--weekend' : ''}`}
                  >
                    {t > 0 ? formatHours(t) : ''}
                  </td>
                ))}
                <td className="logwork-grid__foot logwork-grid__foot--grand">{formatHours(data.grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}

function GridRow({
  row,
  dates,
  workingDays,
  today,
  dayOff,
  columns,
}: {
  readonly row: LogworkByPicRow;
  readonly dates: readonly string[];
  readonly workingDays: readonly boolean[];
  readonly today: string;
  readonly dayOff: readonly boolean[];
  readonly columns: readonly { weekday: string; label: string }[];
}) {
  const who = row.displayName ?? row.accountId;
  return (
    <tr>
      <th scope="row" className="logwork-grid__sticky logwork-grid__pic" title={row.accountId}>
        {row.displayName ?? <code>{row.accountId}</code>}
      </th>
      {row.hoursByDate.map((h, i) => {
        const iso = dates[i] ?? '';
        const flag = logworkCellFlag(h, workingDays[i] ?? true, iso < today);
        const col = columns[i];
        return (
          <DayCell
            key={iso}
            hours={h}
            flag={flag}
            dayOff={dayOff[i] ?? false}
            iso={iso}
            dayLabel={col === undefined ? iso : `${col.weekday} ${col.label}`}
            tickets={row.ticketsByDate[i] ?? []}
            who={who}
          />
        );
      })}
      <td className="logwork-grid__row-total">{formatHours(row.totalHours)}</td>
    </tr>
  );
}

function DayCell({
  hours,
  flag,
  dayOff,
  iso,
  dayLabel,
  tickets,
  who,
}: {
  readonly hours: number;
  readonly flag: LogworkCellFlag;
  readonly dayOff: boolean;
  readonly iso: string;
  readonly dayLabel: string;
  readonly tickets: readonly LogworkCellTicket[];
  readonly who: string;
}) {
  const className = `${cellClass(flag, hours > 0)}${dayOff ? ' logwork-grid__day--weekend' : ''}`;

  // Ô CÓ log → thẻ nổi liệt kê ticket. (Ô `offday` luôn có log nên vào nhánh này.)
  if (hours > 0 && tickets.length > 0) {
    return (
      <DayHovercard
        className={className}
        hours={hours}
        iso={iso}
        dayLabel={dayLabel}
        tickets={tickets}
        who={who}
        isOffday={flag === 'offday'}
      />
    );
  }

  // Ô KHÔNG log: `missing` để một gạch ngang mờ (nền gạch chéo báo "đáng lẽ có
  // log"); còn lại để trống.
  const title =
    flag === 'missing' ? `${who} logged nothing on ${dayLabel} (${iso}), a working day` : undefined;
  return (
    <td className={className} title={title}>
      {flag === 'missing' ? <span aria-hidden="true">–</span> : hours > 0 ? formatHours(hours) : ''}
    </td>
  );
}

// --- Thẻ nổi "ticket đã log ngày đó" ---------------------------------------
//
// Cùng khuôn với hovercard ô Signboard (portal + position:fixed để thoát overflow
// của .table-wrap): rê vào ô nghỉ một nhịp mới mở (quét ngang bảng không bung
// hàng loạt), rời ô có ân hạn để kịp đưa chuột sang thẻ. Trùng nhỏ có chủ đích —
// dữ liệu và nội dung thẻ khác hẳn nên tách riêng cho gọn.

/** Rê vào phải NGHỈ một nhịp mới mở — quét chuột ngang bảng không bung hàng loạt. */
const HOVER_OPEN_MS = 140;
/** Rời ô có một khoảng ân hạn để kịp đưa chuột sang thẻ mà không bị đóng. */
const HOVER_CLOSE_MS = 140;
/** Khoảng hở giữa ô và thẻ. */
const CARD_GAP = 6;
/** Chừa mép màn hình khi ghim thẻ vào trong khung nhìn. */
const VIEWPORT_MARGIN = 8;

interface CardPosition {
  readonly top: number;
  readonly left: number;
  readonly placement: 'below' | 'above';
}

function DayHovercard({
  className,
  hours,
  iso,
  dayLabel,
  tickets,
  who,
  isOffday,
}: {
  readonly className: string;
  readonly hours: number;
  readonly iso: string;
  readonly dayLabel: string;
  readonly tickets: readonly LogworkCellTicket[];
  readonly who: string;
  readonly isOffday: boolean;
}): ReactNode {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pos, setPos] = useState<CardPosition | null>(null);
  const hostRef = useRef<HTMLTableCellElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cardId = useId();
  const open = hovered || focused;

  const clearTimers = (): void => {
    if (openTimer.current !== undefined) clearTimeout(openTimer.current);
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
  };

  // Chuột: mở sau HOVER_OPEN_MS, đóng sau HOVER_CLOSE_MS. Gắn cho CẢ ô lẫn thẻ để
  // di chuột từ ô sang thẻ không rơi vào "khoảng không" làm đóng mất.
  const onPointerEnter = (): void => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => setHovered(true), HOVER_OPEN_MS);
  };
  const onPointerLeave = (): void => {
    if (openTimer.current !== undefined) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setHovered(false), HOVER_CLOSE_MS);
  };

  const onFocus = (): void => {
    clearTimers();
    setFocused(true);
  };
  const onBlur = (e: { relatedTarget: EventTarget | null }): void => {
    const rt = e.relatedTarget as Node | null;
    if (hostRef.current?.contains(rt) || cardRef.current?.contains(rt)) return;
    setFocused(false);
  };

  const close = (): void => {
    clearTimers();
    setHovered(false);
    setFocused(false);
  };

  useEffect(() => () => clearTimers(), []);

  // Định vị thẻ: mở XUỐNG DƯỚI ô, LẬT LÊN khi chạm mép dưới màn hình, ghim vào
  // trong khung nhìn theo chiều ngang. Bám theo cuộn (capture để bắt cả cuộn BÊN
  // TRONG .table-wrap) và đổi cỡ cửa sổ.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = (): void => {
      const host = hostRef.current;
      if (host === null) return;
      const r = host.getBoundingClientRect();
      const card = cardRef.current;
      const cardH = card?.offsetHeight ?? 0;
      const cardW = card?.offsetWidth ?? 0;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = r.bottom + CARD_GAP;
      const flipUp = below + cardH > vh - VIEWPORT_MARGIN && r.top - CARD_GAP - cardH > VIEWPORT_MARGIN;
      const top = flipUp ? r.top - CARD_GAP - cardH : below;
      let left = r.left;
      if (left + cardW > vw - VIEWPORT_MARGIN) left = Math.max(VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - cardW);
      if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
      setPos({ top, left, placement: flipUp ? 'above' : 'below' });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  const label = `${who} · ${tickets.length} ticket${tickets.length === 1 ? '' : 's'} on ${iso}`;

  const card =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={cardRef}
            id={cardId}
            role="dialog"
            aria-label={label}
            className="cell-card"
            style={{
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos === null ? 'hidden' : 'visible',
            }}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                close();
                triggerRef.current?.focus();
              }
            }}
          >
            <div className="cell-card__meta">
              <span>{who}</span>
              <span>
                {dayLabel} · {formatHours(hours)}h{isOffday ? ' · logged on a day off' : ''}
              </span>
            </div>
            <ul className="cell-card__tickets">
              {tickets.map((t) => (
                <li key={t.issueKey} className="logwork-card__ticket">
                  <span className="cell-card__key">
                    <IssueLink issueKey={t.issueKey} />
                  </span>
                  {t.summary !== null && <span className="cell-card__status">{t.summary}</span>}
                  <span className="logwork-card__hours">{formatHours(t.hours)}h</span>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )
      : null;

  return (
    <td
      ref={hostRef}
      className={`${className} logwork-grid__cell--interactive`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          close();
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="logwork-cell__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={label}
        onClick={() => (open ? close() : setFocused(true))}
      >
        {formatHours(hours)}
      </button>
      {card}
    </td>
  );
}
