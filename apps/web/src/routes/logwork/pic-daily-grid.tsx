import { logworkDayWarning, type LogworkByPicRow } from '@app/shared';
import { useLogworkByPic } from '../../api/use-logwork.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/index.js';
import { PeriodPicker } from './period-picker.js';

/**
 * Báo cáo LƯỚI: PIC × ngày.
 *
 * Hàng là PIC (mọi người CÓ log giờ trong kỳ), cột là từng ngày lịch trong
 * khoảng đã chọn, ô là tổng giờ người đó log ngày đó. Ô được tô cảnh báo khi log
 * `<= 4h` (thiếu) hoặc `> 8h` (quá) — ngưỡng đến từ server (`underLimitHours`/
 * `overLimitHours`) và quyết định tô nằm ở `logworkDayWarning` (NGUỒN CHÂN LÝ
 * chung với API). Ngày không log để trống, không tô.
 *
 * Bảng cuộn ngang trong `.table-wrap`; cột PIC ghim trái để tên luôn thấy khi
 * kéo qua nhiều ngày.
 */

/** Bỏ số 0 thừa: `6.00` → `6`, `8.4` giữ nguyên. (Trùng nhỏ với màn member.) */
function formatHours(hours: number): string {
  return String(Number(hours.toFixed(2)));
}

const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Nhãn cột cho một ngày 'YYYY-MM-DD' + có phải cuối tuần không (để làm mờ cột). */
function dateColumn(iso: string): { weekday: string; label: string; weekend: boolean } {
  const [y, m, d] = iso.split('-').map(Number);
  // Dựng ở UTC để thứ trong tuần KHÔNG phụ thuộc múi giờ trình duyệt.
  const dow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return { weekday: WEEKDAY_ABBR[dow] ?? '', label: `${m}/${d}`, weekend: dow === 0 || dow === 6 };
}

/** Lớp CSS cho một ô theo số giờ: rỗng / thiếu / quá / bình thường. */
function cellClass(hours: number): string {
  if (hours <= 0) return 'logwork-grid__cell logwork-grid__cell--empty';
  const warn = logworkDayWarning(hours);
  if (warn === 'under') return 'logwork-grid__cell logwork-grid__cell--under';
  if (warn === 'over') return 'logwork-grid__cell logwork-grid__cell--over';
  return 'logwork-grid__cell';
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
  const totalWarnings = data.rows.reduce((acc, r) => acc + r.warnCount, 0);

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
          {totalWarnings} cell{totalWarnings === 1 ? '' : 's'} to review
        </p>
        {query.isFetching && (
          <span className="muted" role="status" aria-live="polite">
            Updating…
          </span>
        )}
      </div>

      <p className="muted">
        A cell is flagged when a PIC logs{' '}
        <span className="logwork-grid__swatch logwork-grid__swatch--under" /> ≤ {formatHours(data.underLimitHours)}h
        (under) or <span className="logwork-grid__swatch logwork-grid__swatch--over" /> &gt;{' '}
        {formatHours(data.overLimitHours)}h (over) in a day. Days with no worklog are left blank. Counts
        worklog across <strong>every synced Epic</strong> — all projects, any tracking status.
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
                    className={`logwork-grid__day${c.weekend ? ' logwork-grid__day--weekend' : ''}`}
                    title={data.dates[i]}
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
                  weekend={columns.map((c) => c.weekend)}
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
                    className={`logwork-grid__foot${columns[i]?.weekend ? ' logwork-grid__day--weekend' : ''}`}
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
  weekend,
}: {
  readonly row: LogworkByPicRow;
  readonly dates: readonly string[];
  readonly weekend: readonly boolean[];
}) {
  return (
    <tr>
      <th scope="row" className="logwork-grid__sticky logwork-grid__pic" title={row.accountId}>
        {row.displayName ?? <code>{row.accountId}</code>}
      </th>
      {row.hoursByDate.map((h, i) => (
        <td key={dates[i]} className={`${cellClass(h)}${weekend[i] ? ' logwork-grid__day--weekend' : ''}`}>
          {h > 0 ? formatHours(h) : ''}
        </td>
      ))}
      <td className="logwork-grid__row-total">{formatHours(row.totalHours)}</td>
    </tr>
  );
}
