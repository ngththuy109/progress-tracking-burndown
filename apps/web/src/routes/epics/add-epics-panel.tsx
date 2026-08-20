import { useState } from 'react';
import { RECOMPUTE_SECONDS_PER_EPIC, SIDE_CALENDAR_ID, type AddEpicsRequest } from '@app/shared';
import { useAddEpics, useValidateEpics } from '../../api/use-epics.js';
import { useCalendars } from '../../api/use-calendars.js';
import { useMe } from '../../api/use-me.js';
import { Badge, ErrorState } from '../../components/ui/index.js';
import { IssueLink } from '../../components/issue-link/index.js';

/**
 * Thêm Epic — LUÔN qua hai bước: Kiểm tra rồi mới Thêm.
 *
 * Thêm thẳng là cách nhanh nhất để PM thêm nhầm 20 Epic. Backfill 20 Epic mất
 * hàng chục phút và không có nút huỷ, nên bước `/validate` tồn tại chính vì lý
 * do đó (PRD §2.6).
 */

/**
 * Lịch THỰC THI mặc định của Epic mới: người VN làm nên đường Kế hoạch cháy
 * theo lịch VN. Trước đây chỗ này gán cứng `'default'` — một lịch KHÔNG TỒN
 * TẠI trong seed, khiến mọi tầng âm thầm rơi về lịch mặc định không có ngày lễ
 * và đường Kế hoạch cháy đều qua tuần nghỉ Tết (E-14). Nay là giá trị khởi đầu
 * của ô chọn, danh sách lấy từ `GET /api/calendars`.
 */
export const DEFAULT_CALENDAR_ID = SIDE_CALENDAR_ID.VN;
/** Dự phòng khi chưa tải được danh sách lịch — khớp timezone của VN_STANDARD. */
export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

/** Tách theo dấu phẩy, xuống dòng hoặc khoảng trắng — PM hay dán từ Excel. */
export function parseKeys(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).map((k) => k.trim()).filter((k) => k !== ''))];
}

/**
 * Ước tính thời gian dựng lịch sử.
 *
 * Là ƯỚC TÍNH THÔ, không phải cam kết. Cố ý làm tròn lên phút và không bao giờ
 * hiển thị dạng đồng hồ đếm ngược — đếm ngược sẽ sai và làm mất lòng tin vào
 * mọi con số khác trên màn hình.
 */
export function estimateMinutes(epicCount: number): number {
  return Math.max(1, Math.ceil((epicCount * RECOMPUTE_SECONDS_PER_EPIC) / 60));
}

export function AddEpicsPanel() {
  const me = useMe();
  const [raw, setRaw] = useState('');
  const [calendarId, setCalendarId] = useState(DEFAULT_CALENDAR_ID);
  const calendars = useCalendars();
  const validate = useValidateEpics();
  const add = useAddEpics();

  // VIEWER không được đổi tập Epic theo dõi (API sẽ trả 403). Ẩn cả ô nhập cho
  // gọn, thay vì để họ gõ xong mới bị từ chối. Đây CHỈ là trải nghiệm — hàng
  // rào thật vẫn ở API.
  if (me.data?.role === 'VIEWER') {
    return (
      <section className="panel" aria-labelledby="add-epics-title">
        <h2 className="panel__title" id="add-epics-title">
          Track new Epics
        </h2>
        <p className="panel__hint" role="status">
          Only Admins and PMs can change which Epics are tracked. You have the Viewer role, so you
          can browse charts and Signboards but not add Epics.
        </p>
      </section>
    );
  }

  const keys = parseKeys(raw);
  const results = validate.data?.results ?? [];
  const addable = results.filter((r) => r.valid).map((r) => r.key);

  const confirm = (): void => {
    const body: AddEpicsRequest = {
      keys: addable,
      // Múi giờ đi THEO lịch: chọn lịch VN là chốt sổ theo giờ Việt Nam. Hai ô
      // riêng sẽ có ngày lệch nhau — lịch VN nhưng chốt sổ giờ Tokyo.
      timezone:
        calendars.data?.calendars.find((c) => c.calendarId === calendarId)?.timezone ??
        DEFAULT_TIMEZONE,
      calendarId,
      note: null,
    };
    add.mutate(body);
  };

  return (
    <section className="panel" aria-labelledby="add-epics-title">
      <h2 className="panel__title" id="add-epics-title">
        Track new Epics
      </h2>

      <label className="field">
        <span>Paste Epic keys, separated by commas or new lines</span>
        <input
          className="input input--wide"
          value={raw}
          placeholder="PAY-100, PAY-200"
          aria-label="Epic keys"
          onChange={(e) => setRaw(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Work calendar (drives the Planned line and snapshot cut-off time)</span>
        <select
          className="input"
          value={calendarId}
          aria-label="Work calendar"
          onChange={(e) => setCalendarId(e.target.value)}
        >
          {(calendars.data?.calendars ?? []).map((c) => (
            <option key={c.calendarId} value={c.calendarId}>
              {c.calendarId} · {c.timezone}
              {c.holidayCount === 0 ? ' · ⚠ no holidays registered' : ''}
            </option>
          ))}
          {calendars.data === undefined && <option value={DEFAULT_CALENDAR_ID}>{DEFAULT_CALENDAR_ID}</option>}
        </select>
      </label>

      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={keys.length === 0 || validate.isPending}
          onClick={() => validate.mutate(keys)}
        >
          {validate.isPending ? 'Checking…' : `Check ${keys.length} keys`}
        </button>
      </div>

      {validate.isError && <ErrorState error={validate.error} title="Could not check these keys" />}

      {validate.isSuccess && (
        <>
          <ul className="rows" aria-label="Check results">
            {results.map((r) => (
              <li className="row" key={r.key}>
                <IssueLink issueKey={r.key} />
                {r.valid ? (
                  <>
                    <Badge tone="success">can add</Badge>
                    <span>{r.displayName}</span>
                    <span className="muted">
                      {r.subtaskCount} sub-tasks · {r.totalEstimateHours}h
                    </span>
                    {/* Cảnh báo KHÁC HẲN lý do từ chối: vẫn thêm được, nhưng PM
                        cần biết trước để khỏi ngạc nhiên khi biểu đồ thiếu dữ liệu. */}
                    {r.warnings.includes('NO_CHILD_TASK') && (
                      <Badge tone="warning">no child tasks yet</Badge>
                    )}
                    {r.warnings.includes('MISSING_WBS_DATES') && (
                      <Badge tone="warning">{r.missingWbsDateCount} sub-tasks missing dates</Badge>
                    )}
                  </>
                ) : (
                  <>
                    <Badge tone="danger">cannot add</Badge>
                    {/* Hiện LÝ DO ĐỌC ĐƯỢC, không hiện mã lỗi. */}
                    <span>{r.message}</span>
                  </>
                )}
              </li>
            ))}
          </ul>

          {addable.length > 0 && (
            <div className="notice notice--ok" role="status">
              Will add <strong>{addable.length} Epics</strong>. Rebuilding their history takes{' '}
              <strong>about {estimateMinutes(addable.length)} minutes</strong>. Until it finishes they
              show as <em>building history</em> and have no chart yet.
            </div>
          )}

          <div className="actions">
            <button
              type="button"
              className="button button--primary"
              disabled={addable.length === 0 || add.isPending}
              onClick={confirm}
            >
              {add.isPending ? 'Adding…' : `Add ${addable.length} Epics`}
            </button>
          </div>
        </>
      )}

      {add.isError && <ErrorState error={add.error} title="Could not add Epics" />}
      {add.isSuccess && (
        <p className="notice notice--ok" role="status">
          Added {add.data.added.length} Epics
          {add.data.skipped.length > 0 && `, skipped ${add.data.skipped.length} already tracked`}.
        </p>
      )}
    </section>
  );
}

/**
 * Theo dõi một "project phẳng" bằng JQL (DYNAMIC-TIERS-DESIGN §2.5, §6).
 *
 * Khác luồng Epic ở trên: KHÔNG có Epic/Task cha để kiểm tra trên Jira. Người dùng đặt
 * một ID scope tuỳ ý, khai JQL tìm lá; worker đọc lá bằng JQL. Khoá nhóm của lá phẳng lấy
 * từ CHÍNH tiêu đề ticket — cần cấu hình tầng dùng `SELF_TITLE` (màn Cấu trúc tầng).
 * Panel riêng để luồng Epic ở trên không đổi một dòng.
 */
export function AddQueryScopePanel() {
  const me = useMe();
  const [scopeId, setScopeId] = useState('');
  const [jql, setJql] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [calendarId, setCalendarId] = useState(DEFAULT_CALENDAR_ID);
  const calendars = useCalendars();
  const add = useAddEpics();

  if (me.data?.role === 'VIEWER') return null;

  const ready = scopeId.trim() !== '' && jql.trim() !== '' && projectKey.trim() !== '';
  const submit = (): void => {
    const body: AddEpicsRequest = {
      keys: [scopeId.trim()],
      timezone:
        calendars.data?.calendars.find((c) => c.calendarId === calendarId)?.timezone ??
        DEFAULT_TIMEZONE,
      calendarId,
      note: null,
      scope: { scopeJql: jql.trim(), leafIssueTypes: [], projectKey: projectKey.trim() },
    };
    add.mutate(body);
  };

  return (
    <section className="panel" aria-labelledby="add-query-title">
      <h2 className="panel__title" id="add-query-title">
        Track a flat project (JQL)
      </h2>
      <p className="panel__hint">
        For projects with no parent Epic/Task — the leaves are the tickets matching a JQL. Pick any
        scope ID; group keys come from the ticket titles, so configure a tier that uses{' '}
        <code>SELF_TITLE</code> on the <strong>Tier structure</strong> screen.
      </p>

      <label className="field">
        <span>Scope ID (your choice, e.g. FLAT-PAY)</span>
        <input className="input input--code" value={scopeId} aria-label="Scope id" onChange={(e) => setScopeId(e.target.value)} />
      </label>
      <label className="field">
        <span>JQL that finds the leaves</span>
        <input
          className="input input--wide"
          value={jql}
          placeholder="project = PAY AND type = Task"
          aria-label="Scope JQL"
          onChange={(e) => setJql(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Project key (for config inheritance)</span>
        <input className="input input--code" value={projectKey} aria-label="Project key" onChange={(e) => setProjectKey(e.target.value)} />
      </label>
      <label className="field">
        <span>Work calendar</span>
        <select className="input" value={calendarId} aria-label="Work calendar (query scope)" onChange={(e) => setCalendarId(e.target.value)}>
          {(calendars.data?.calendars ?? []).map((c) => (
            <option key={c.calendarId} value={c.calendarId}>
              {c.calendarId} · {c.timezone}
            </option>
          ))}
          {calendars.data === undefined && <option value={DEFAULT_CALENDAR_ID}>{DEFAULT_CALENDAR_ID}</option>}
        </select>
      </label>

      <div className="actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!ready || add.isPending}
          onClick={submit}
        >
          {add.isPending ? 'Adding…' : 'Add JQL scope'}
        </button>
      </div>

      {add.isError && <ErrorState error={add.error} title="Could not add the scope" />}
      {add.isSuccess && (
        <p className="notice notice--ok" role="status">
          Added {add.data.added.length} scope{add.data.added.length === 1 ? '' : 's'}
          {add.data.skipped.length > 0 && `, skipped ${add.data.skipped.length} already tracked`}.
        </p>
      )}
    </section>
  );
}
