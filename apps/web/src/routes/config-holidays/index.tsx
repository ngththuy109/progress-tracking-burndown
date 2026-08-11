import { useMemo, useState, type ChangeEvent } from 'react';
import { describeWorkdaysMask, workdaysMaskWarning, type CalendarSummary, type HolidayImportMode } from '@app/shared';
import {
  isBuiltinCalendar,
  useCalendars,
  useDeleteHoliday,
  useDeleteMakeupWorkday,
  useHolidays,
  useImportHolidays,
  useImportMakeupWorkdays,
  useMakeupWorkdays,
} from '../../api/use-calendars.js';
import { useProject } from '../../project/project-context.js';
import { Badge, DataTable, EmptyState, ErrorState, LoadingState, type Column } from '../../components/ui/index.js';
import { parseHolidayLines } from './parse-holiday-lines.js';

/**
 * Màn hình "Ngày nghỉ" — T-36.
 *
 * Hai phía làm việc nghỉ khác ngày nhau: người VN làm theo lịch VN_STANDARD,
 * khách hàng JP review theo lịch JP_STANDARD. Màn hình này là nơi DUY NHẤT nạp
 * ngày lễ cho cả hai — thiếu dữ liệu ở đây thì đường Kế hoạch cháy đều qua
 * ngày nghỉ (E-14) và báo cáo plan-conflicts không bắt được gì.
 *
 * Phân quyền multi-tenant: lịch BUILT-IN (VN_STANDARD/JP_STANDARD) dùng chung
 * mọi dự án nên chỉ ADMIN sửa được (qua `/api/admin/calendars/...`); lịch riêng
 * của dự án thì PM của dự án sửa được (qua `/api/projects/:key/calendars/...`).
 * API tự chặn — ẩn nút ở đây chỉ là trải nghiệm.
 */

// TODO(multi-tenant): "Nhân bản lịch built-in thành lịch riêng của dự án" —
// chưa làm được vì `@app/shared` chưa có schema/endpoint clone lịch. Khi API
// bổ sung (ví dụ POST /api/projects/:key/calendars/clone), thêm nút ở đây để
// PM tự tách lịch riêng thay vì nhờ ADMIN sửa lịch chung.

/**
 * Tên thân thiện của hai lịch chuẩn; lịch khác (nếu có) hiện mã trần.
 *
 * Chỉ ghi TÊN NƯỚC — hai tab đã đủ phân biệt lịch VN với lịch Nhật. Không chú
 * thích vai trò (ai làm / ai review) vì đặt cạnh "Days off" dễ đọc nhầm là ngày
 * nghỉ lại "đi làm".
 */
const CALENDAR_LABEL: Record<string, string> = {
  VN_STANDARD: 'Vietnam',
  JP_STANDARD: 'Japan',
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function weekdayOf(date: string): string {
  return WEEKDAY[new Date(`${date}T00:00:00.000Z`).getUTCDay()] ?? '';
}

export function HolidaysScreen() {
  const calendars = useCalendars();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (calendars.isPending) return <LoadingState label="Loading calendars…" rows={3} />;
  if (calendars.isError) {
    return (
      <ErrorState
        error={calendars.error}
        title="Could not load the calendars"
        onRetry={() => void calendars.refetch()}
      />
    );
  }

  const list = calendars.data.calendars;
  if (list.length === 0) {
    return (
      <EmptyState
        icon="📅"
        title="No work calendar exists"
        description="Run the database seed (pnpm db:seed) to create the VN_STANDARD and JP_STANDARD calendars."
      />
    );
  }

  const active = list.find((c) => c.calendarId === selectedId) ?? list[0]!;

  return (
    <div className="stack">
      <div className="scope">
        <span className="scope__label">Calendar:</span>
        {list.map((c) => (
          <button
            key={c.calendarId}
            type="button"
            className={`button${c.calendarId === active.calendarId ? ' button--primary' : ''}`}
            onClick={() => setSelectedId(c.calendarId)}
          >
            {CALENDAR_LABEL[c.calendarId] ?? c.calendarId}
          </button>
        ))}
      </div>

      <CalendarPanel key={active.calendarId} calendar={active} />
    </div>
  );
}

function CalendarPanel({ calendar }: { readonly calendar: CalendarSummary }) {
  const scope = useProject();
  // Lịch built-in: chỉ ADMIN. Lịch riêng của dự án: PM của dự án cũng sửa được.
  const canEdit = isBuiltinCalendar(calendar.calendarId)
    ? scope.isAdmin
    : scope.isAdmin || scope.role === 'PM';
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);

  const holidays = useHolidays(calendar.calendarId, year);
  const del = useDeleteHoliday();

  // Năm chưa có ngày lễ nào là đúng tình huống E-14 — cảnh báo ngay tại chỗ.
  const yearIsEmpty = !calendar.years.includes(year);

  const yearOptions = useMemo(() => {
    const base = new Set<number>([
      currentYear - 1,
      currentYear,
      currentYear + 1,
      ...calendar.years,
      ...calendar.makeupYears,
    ]);
    return [...base].sort((a, b) => a - b);
  }, [calendar.years, calendar.makeupYears, currentYear]);

  const columns: readonly Column<{ date: string; label: string | null }>[] = [
    { key: 'date', header: 'Date', render: (h) => <code>{h.date}</code>, sortKey: (h) => h.date },
    { key: 'weekday', header: 'Weekday', render: (h) => weekdayOf(h.date) },
    {
      key: 'label',
      header: 'Holiday',
      render: (h) => (h.label === null ? <span className="muted">—</span> : h.label),
    },
    ...(canEdit
      ? ([
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (h: { date: string; label: string | null }) => (
              <button
                type="button"
                className="button button--danger"
                disabled={del.isPending}
                onClick={() => del.mutate({ calendarId: calendar.calendarId, date: h.date })}
              >
                Delete
              </button>
            ),
          },
        ] as const)
      : []),
  ];

  return (
    <>
      <section className="panel" aria-labelledby="holidays-title">
        <h2 className="panel__title" id="holidays-title">
          📅 Days off — {CALENDAR_LABEL[calendar.calendarId] ?? calendar.calendarId}
        </h2>
        <p className="panel__hint">
          {/* Giải mã mask ra từng ngày thay vì gán cứng "Mon–Fri": mask sai
              (như 126) phải NHÌN THẤY ĐƯỢC ngay ở đây, không phải đợi biểu đồ
              thiếu ngày rồi mới đi dò database. */}
          Working days come from the calendar itself (
          <strong>{describeWorkdaysMask(calendar.workdaysMask)}</strong> · {calendar.timezone}).
          This list holds the
          <strong> public holidays</strong> on top of that. The Planned line of every Epic using this
          calendar skips these days, and planned start/end dates falling on them are flagged on the
          Sub-tasks screen.
        </p>

        {workdaysMaskWarning(calendar.workdaysMask) !== null && (
          <p className="notice notice--error" role="alert">
            📅 {workdaysMaskWarning(calendar.workdaysMask)}
          </p>
        )}

        <div className="scope">
          <span className="scope__label">Year:</span>
          {yearOptions.map((y) => (
            <button
              key={y}
              type="button"
              className={`button${y === year ? ' button--primary' : ''}`}
              onClick={() => setYear(y)}
            >
              {y}
            </button>
          ))}
        </div>

        {yearIsEmpty && (
          <p className="notice notice--error" role="alert">
            No holiday is registered for <strong>{year}</strong> on this calendar. Until they are
            imported, the Planned line treats holiday weeks as working days (it looks like the team
            is behind when everyone is simply off).
          </p>
        )}

        {holidays.isPending ? (
          <LoadingState label="Loading holidays…" rows={3} />
        ) : holidays.isError ? (
          <ErrorState
            error={holidays.error}
            title="Could not load the holidays"
            onRetry={() => void holidays.refetch()}
          />
        ) : (
          <DataTable
            caption={`Holidays in ${year}`}
            columns={columns}
            rows={[...holidays.data.holidays]}
            rowKey={(h) => h.date}
            empty={
              <EmptyState
                title={`No holidays in ${year} yet`}
                description="Paste the year's holidays in the import box below."
              />
            }
          />
        )}
        {del.isError && <ErrorState error={del.error} title="Could not delete the holiday" />}
      </section>

      {canEdit ? (
        <ImportPanel calendarId={calendar.calendarId} year={year} />
      ) : (
        <p className="muted">
          {isBuiltinCalendar(calendar.calendarId)
            ? 'Lịch dùng chung này chỉ quản trị viên sửa được — nó ảnh hưởng đường Kế hoạch của mọi dự án.'
            : 'Chỉ PM của dự án (hoặc quản trị viên) sửa được ngày nghỉ — chúng ảnh hưởng đường Kế hoạch của mọi Epic dùng lịch này.'}
        </p>
      )}

      <MakeupWorkdaysSection calendarId={calendar.calendarId} year={year} canEdit={canEdit} />
    </>
  );
}

/**
 * Ngày LÀM BÙ — mục song song với ngày lễ nhưng NGƯỢC nghĩa: những ngày cuối
 * tuần được xếp làm việc. Đường Kế hoạch tính như ngày thường và biểu đồ KHÔNG
 * bôi xám. Dùng chung năm đang chọn với mục ngày lễ ở trên.
 */
function MakeupWorkdaysSection({
  calendarId,
  year,
  canEdit,
}: {
  readonly calendarId: string;
  readonly year: number;
  readonly canEdit: boolean;
}) {
  const makeup = useMakeupWorkdays(calendarId, year);
  const del = useDeleteMakeupWorkday();

  const columns: readonly Column<{ date: string; label: string | null }>[] = [
    { key: 'date', header: 'Date', render: (m) => <code>{m.date}</code>, sortKey: (m) => m.date },
    { key: 'weekday', header: 'Weekday', render: (m) => weekdayOf(m.date) },
    {
      key: 'label',
      header: 'Reason',
      render: (m) => (m.label === null ? <span className="muted">—</span> : m.label),
    },
    ...(canEdit
      ? ([
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (m: { date: string; label: string | null }) => (
              <button
                type="button"
                className="button button--danger"
                disabled={del.isPending}
                onClick={() => del.mutate({ calendarId, date: m.date })}
              >
                Delete
              </button>
            ),
          },
        ] as const)
      : []),
  ];

  return (
    <>
      <section className="panel" aria-labelledby="makeup-title">
        <h2 className="panel__title" id="makeup-title">
          🛠️ Make-up workdays (làm bù) — {year}
        </h2>
        <p className="panel__hint">
          Weekend days the team works to make up for another day off (common around Tết). The Planned
          line burns down on these days like a normal working day, and the Burndown chart does{' '}
          <strong>not</strong> grey them out.
        </p>

        {makeup.isPending ? (
          <LoadingState label="Loading make-up workdays…" rows={2} />
        ) : makeup.isError ? (
          <ErrorState
            error={makeup.error}
            title="Could not load the make-up workdays"
            onRetry={() => void makeup.refetch()}
          />
        ) : (
          <DataTable
            caption={`Make-up workdays in ${year}`}
            columns={columns}
            rows={[...makeup.data.makeupWorkdays]}
            rowKey={(m) => m.date}
            empty={
              <EmptyState
                title={`No make-up workdays in ${year}`}
                description="If a weekend is worked to compensate for a holiday, add it in the box below."
              />
            }
          />
        )}
        {del.isError && <ErrorState error={del.error} title="Could not delete the make-up workday" />}
      </section>

      {canEdit && <MakeupImportPanel calendarId={calendarId} year={year} />}
    </>
  );
}

function MakeupImportPanel({ calendarId, year }: { readonly calendarId: string; readonly year: number }) {
  const [raw, setRaw] = useState('');
  const [mode, setMode] = useState<HolidayImportMode>('MERGE');
  const importMutation = useImportMakeupWorkdays();

  const parsed = parseHolidayLines(raw);
  const outOfYear =
    mode === 'REPLACE_YEAR' ? parsed.holidays.filter((h) => !h.date.startsWith(`${year}-`)) : [];
  const canImport = parsed.holidays.length > 0 && parsed.errors.length === 0 && outOfYear.length === 0;

  return (
    <section className="panel" aria-labelledby="makeup-import-title">
      <h2 className="panel__title" id="makeup-import-title">
        Import make-up workdays
      </h2>
      <p className="panel__hint">
        Same format as holidays — one day per line: <code>2026-04-25</code> or{' '}
        <code>2026-04-25, làm bù 30/4</code>.
      </p>

      <label className="field">
        <span>Make-up workdays, one per line</span>
        <textarea
          className="input input--wide"
          rows={5}
          value={raw}
          placeholder={`${year}-04-25, làm bù 30/4`}
          aria-label="Make-up workdays, one per line"
          onChange={(e) => setRaw(e.target.value)}
        />
      </label>

      <div className="scope">
        <span className="scope__label">Mode:</span>
        <button
          type="button"
          className={`button${mode === 'MERGE' ? ' button--primary' : ''}`}
          onClick={() => setMode('MERGE')}
          title="Add the listed days; days already registered but not listed stay untouched."
        >
          Merge into the calendar
        </button>
        <button
          type="button"
          className={`button${mode === 'REPLACE_YEAR' ? ' button--primary' : ''}`}
          onClick={() => setMode('REPLACE_YEAR')}
          title={`Delete every make-up workday of ${year} first, then insert the listed days.`}
        >
          Replace all of {year}
        </button>
      </div>

      {raw.trim() !== '' && (
        <p className="muted" role="status">
          {parsed.holidays.length} valid day{parsed.holidays.length === 1 ? '' : 's'}
          {parsed.errors.length > 0 && `, ${parsed.errors.length} line(s) need fixing`}.
        </p>
      )}

      {parsed.errors.length > 0 && (
        <ul className="rows">
          {parsed.errors.map((err) => (
            <li className="row" key={err.line}>
              <Badge tone="danger">line {err.line}</Badge> <code>{err.text}</code>{' '}
              <span className="muted">{err.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {outOfYear.length > 0 && (
        <p className="notice notice--error" role="alert">
          Replace mode only touches {year}, but these days are outside it:{' '}
          {outOfYear.map((h) => h.date).join(', ')}. Switch to Merge mode or remove them.
        </p>
      )}

      {importMutation.isSuccess && (
        <p className="notice notice--ok" role="status">
          Imported: {importMutation.data.inserted} new, {importMutation.data.updated} updated,{' '}
          {importMutation.data.deleted} removed. {importMutation.data.epicsMarkedForRecompute} Epic
          {importMutation.data.epicsMarkedForRecompute === 1 ? '' : 's'} will be recomputed — charts
          update after the next sync run.
        </p>
      )}
      {importMutation.isError && (
        <ErrorState error={importMutation.error} title="Nothing was imported" />
      )}

      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!canImport || importMutation.isPending}
          onClick={() =>
            importMutation.mutate(
              {
                calendarId,
                body: {
                  mode,
                  year: mode === 'REPLACE_YEAR' ? year : null,
                  makeupWorkdays: [...parsed.holidays],
                },
              },
              { onSuccess: () => setRaw('') },
            )
          }
        >
          {importMutation.isPending
            ? 'Importing…'
            : `📥 Import ${parsed.holidays.length} day${parsed.holidays.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </section>
  );
}

function ImportPanel({ calendarId, year }: { readonly calendarId: string; readonly year: number }) {
  const [raw, setRaw] = useState('');
  const [mode, setMode] = useState<HolidayImportMode>('MERGE');
  const importMutation = useImportHolidays();

  const parsed = parseHolidayLines(raw);
  // REPLACE_YEAR chỉ đụng tới năm đang xem — chặn ngay từ preview những ngày
  // ngoài năm đó, cùng luật với API.
  const outOfYear =
    mode === 'REPLACE_YEAR' ? parsed.holidays.filter((h) => !h.date.startsWith(`${year}-`)) : [];
  const canImport = parsed.holidays.length > 0 && parsed.errors.length === 0 && outOfYear.length === 0;

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file === undefined) return;
    // Đổ nội dung file vào chính ô dán để dùng chung một đường xem trước —
    // người dùng còn sửa tay được trước khi import.
    void file.text().then((text) => setRaw((prev) => (prev === '' ? text : `${prev}\n${text}`)));
    e.target.value = '';
  };

  return (
    <section className="panel" aria-labelledby="import-title">
      <h2 className="panel__title" id="import-title">
        Import holidays
      </h2>
      <p className="panel__hint">
        One day per line: <code>2026-02-17</code> or <code>2026-02-17, Tet holiday</code>. Commas,
        semicolons and tabs all work as separators, so pasting two columns from Excel is fine. You
        can also load a CSV file into the box.
      </p>

      <label className="field">
        <span>Days off, one per line</span>
        <textarea
          className="input input--wide"
          rows={6}
          value={raw}
          placeholder={`${year}-01-01, New Year\n${year}-02-17, Tet holiday`}
          aria-label="Days off, one per line"
          onChange={(e) => setRaw(e.target.value)}
        />
      </label>
      <label className="field">
        <span>…or load a CSV file (date,label)</span>
        <input type="file" accept=".csv,.txt" aria-label="CSV file" onChange={onFile} />
      </label>

      <div className="scope">
        <span className="scope__label">Mode:</span>
        <button
          type="button"
          className={`button${mode === 'MERGE' ? ' button--primary' : ''}`}
          onClick={() => setMode('MERGE')}
          title="Add the listed days; days already registered but not listed stay untouched."
        >
          Merge into the calendar
        </button>
        <button
          type="button"
          className={`button${mode === 'REPLACE_YEAR' ? ' button--primary' : ''}`}
          onClick={() => setMode('REPLACE_YEAR')}
          title={`Delete every holiday of ${year} first, then insert the listed days.`}
        >
          Replace all of {year}
        </button>
      </div>

      {raw.trim() !== '' && (
        <p className="muted" role="status">
          {parsed.holidays.length} valid day{parsed.holidays.length === 1 ? '' : 's'}
          {parsed.errors.length > 0 && `, ${parsed.errors.length} line(s) need fixing`}.
        </p>
      )}

      {parsed.errors.length > 0 && (
        <ul className="rows">
          {parsed.errors.map((err) => (
            <li className="row" key={err.line}>
              <Badge tone="danger">line {err.line}</Badge> <code>{err.text}</code>{' '}
              <span className="muted">{err.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {outOfYear.length > 0 && (
        <p className="notice notice--error" role="alert">
          Replace mode only touches {year}, but these days are outside it:{' '}
          {outOfYear.map((h) => h.date).join(', ')}. Switch to Merge mode or remove them.
        </p>
      )}

      {importMutation.isSuccess && (
        <p className="notice notice--ok" role="status">
          Imported: {importMutation.data.inserted} new, {importMutation.data.updated} updated,{' '}
          {importMutation.data.deleted} removed. {importMutation.data.epicsMarkedForRecompute} Epic
          {importMutation.data.epicsMarkedForRecompute === 1 ? '' : 's'} will be recomputed — charts
          update after the next sync run.
        </p>
      )}
      {importMutation.isError && (
        <ErrorState error={importMutation.error} title="Nothing was imported" />
      )}

      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!canImport || importMutation.isPending}
          onClick={() =>
            importMutation.mutate(
              {
                calendarId,
                body: {
                  mode,
                  year: mode === 'REPLACE_YEAR' ? year : null,
                  holidays: [...parsed.holidays],
                },
              },
              { onSuccess: () => setRaw('') },
            )
          }
        >
          {importMutation.isPending
            ? 'Importing…'
            : `📥 Import ${parsed.holidays.length} day${parsed.holidays.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </section>
  );
}
