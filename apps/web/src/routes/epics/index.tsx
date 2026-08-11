import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { MissingDateRow, TrackedEpicSummary } from '@app/shared';
import { useEpicList, useMissingDates, usePatchEpic } from '../../api/use-epics.js';
import { usePlanConflictSummary } from '../../api/use-plan-conflicts.js';
import { useCalendars } from '../../api/use-calendars.js';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  type BadgeTone,
  type Column,
} from '../../components/ui/index.js';
import { projectPath, useProjectKey } from '../../project/project-context.js';
import { AddEpicsPanel } from './add-epics-panel.js';
import {
  buildMissingDatesCsv,
  buildMissingDatesJql,
  missingDatesCsvFilename,
} from './missing-dates-export.js';
import { RemoveEpicDialog } from './remove-epic-dialog.js';
import { ResyncDialog } from './resync-dialog.js';

// Dùng thẳng kiểu của `@app/shared`: `apps/web` cố ý KHÔNG phụ thuộc zod
// (T-20), nên không suy kiểu từ schema ở đây được.
type Epic = TrackedEpicSummary;

/**
 * Màn hình danh sách Epic — cửa vào của toàn bộ sản phẩm.
 *
 * Không có màn hình này thì không ai đưa được Epic vào hệ thống, và mọi màn
 * hình khác không có gì để hiện.
 */

const STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'success',
  BACKFILLING: 'info',
  PENDING: 'info',
  PAUSED: 'neutral',
  ERROR: 'danger',
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'tracking',
  BACKFILLING: 'building history',
  PENDING: 'waiting to build history',
  PAUSED: 'paused',
  ERROR: 'error',
};

/**
 * Đổi timestamp ISO (UTC) mà API trả về sang giờ địa phương của trình duyệt.
 *
 * API giữ nguyên UTC là đúng — quy đổi múi giờ là việc của tầng hiển thị.
 * Hiện chuỗi UTC thô thì người xem ở múi giờ khác đọc thành "đồng hồ sai".
 */
export function formatLocalDateTime(iso: string): string {
  const parsed = new Date(iso);
  // Chuỗi không đọc được thì hiện nguyên văn — "Invalid Date" không giúp ai.
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Chữ hiển thị ở cột "Last synced".
 *
 * Chưa từng đồng bộ thì NÓI RÕ đang dựng lịch sử lần đầu, không để ô trống —
 * ô trống trông y hệt "hệ thống hỏng".
 */
export function lastSyncedLabel(epic: Epic): string {
  if (epic.lastSyncedAt !== null) return formatLocalDateTime(epic.lastSyncedAt);
  if (epic.status === 'BACKFILLING' || epic.status === 'PENDING') {
    return 'building history for the first time';
  }
  return 'never synced';
}

export function EpicListScreen() {
  // Key của dự án đang mở — mọi link nội bộ (Chart/Signboard/Sub-tasks) phải
  // mang tiền tố `/p/<key>/` để ở lại đúng dự án.
  const projectKey = useProjectKey();
  const query = useEpicList();
  // Số Sub-task có plan rơi vào ngày nghỉ (T-37) — một lần gọi cho cả danh
  // sách. Lỗi ở đây KHÔNG chặn màn hình: cột chỉ để trống.
  const conflictSummary = usePlanConflictSummary();
  const calendars = useCalendars();
  const patch = usePatchEpic();
  const [removing, setRemoving] = useState<Epic | null>(null);
  const [resyncing, setResyncing] = useState<Epic | null>(null);
  const [openMissing, setOpenMissing] = useState<string | null>(null);

  if (query.isPending) return <LoadingState label="Loading Epics…" rows={4} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load Epics"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const epics = query.data;
  const conflictCounts = new Map(
    (conflictSummary.data?.counts ?? []).map((c) => [c.epicKey, c.total]),
  );

  const columns: readonly Column<Epic>[] = [
    {
      key: 'epicKey',
      header: 'Epic',
      render: (e) => (
        <span>
          <code>{e.epicKey}</code> {e.displayName}
        </span>
      ),
      sortKey: (e) => e.epicKey,
    },
    { key: 'project', header: 'Project', render: (e) => e.projectKey, sortKey: (e) => e.projectKey },
    {
      // Lịch THỰC THI của Epic — đường Kế hoạch cháy theo lịch này. Đổi xong
      // worker sẽ dùng lịch mới từ lần sync kế tiếp; bấm Resync nếu cần ngay.
      key: 'calendar',
      header: 'Calendar',
      render: (e) => (
        <select
          className="input"
          value={e.calendarId}
          aria-label={`Work calendar of ${e.epicKey}`}
          disabled={patch.isPending}
          onChange={(ev) => {
            const next = calendars.data?.calendars.find((c) => c.calendarId === ev.target.value);
            patch.mutate({
              epicKey: e.epicKey,
              // Múi giờ đi theo lịch — hai thứ lệch nhau làm ngày chốt sổ sai.
              patch: { calendarId: ev.target.value, ...(next ? { timezone: next.timezone } : {}) },
            });
          }}
        >
          {(calendars.data?.calendars ?? []).map((c) => (
            <option key={c.calendarId} value={c.calendarId}>
              {c.calendarId}
              {c.holidayCount === 0 ? ' ⚠' : ''}
            </option>
          ))}
          {/* Epic đang trỏ một lịch không (còn) tồn tại — ví dụ 'default' của
              dữ liệu cũ. Vẫn hiện ra để PM thấy và sửa, kèm dấu hỏi. */}
          {calendars.data !== undefined &&
            !calendars.data.calendars.some((c) => c.calendarId === e.calendarId) && (
              <option value={e.calendarId}>{e.calendarId} (unknown!)</option>
            )}
        </select>
      ),
      sortKey: (e) => e.calendarId,
    },
    {
      key: 'status',
      header: 'Status',
      render: (e) => (
        <span>
          <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{STATUS_LABEL[e.status] ?? e.status}</Badge>
          {/* Lỗi hiện NGUYÊN VĂN, không rút gọn — đó là thứ người trực cần. */}
          {e.lastError !== null && <div className="muted">{e.lastError}</div>}
        </span>
      ),
      sortKey: (e) => e.status,
    },
    {
      key: 'lastSynced',
      header: 'Last synced',
      // `title` giữ chuỗi UTC gốc để đối chiếu được với log server khi cần.
      render: (e) => (
        <span className={e.lastSyncedAt === null ? 'muted' : ''} title={e.lastSyncedAt ?? undefined}>
          {lastSyncedLabel(e)}
        </span>
      ),
      // `null` xuống cuối bảng, không lên đầu.
      sortKey: (e) => e.lastSyncedAt,
    },
    {
      key: 'subtasks',
      header: 'Sub-tasks',
      align: 'right',
      render: (e) => e.dataHealth.subtaskCount,
      sortKey: (e) => e.dataHealth.subtaskCount,
    },
    {
      key: 'missingDates',
      header: 'Missing dates',
      align: 'right',
      render: (e) =>
        e.dataHealth.missingWbsDateCount === 0 ? (
          <span className="muted">0</span>
        ) : (
          <button type="button" className="button" onClick={() => setOpenMissing(e.epicKey)}>
            {e.dataHealth.missingWbsDateCount}
          </button>
        ),
      sortKey: (e) => e.dataHealth.missingWbsDateCount,
    },
    {
      // Plan rơi vào ngày nghỉ (T-37): bấm vào là sang màn Sub-tasks, nơi từng
      // dòng vi phạm được gắn cờ ⚠ kèm lý do.
      key: 'planConflicts',
      header: 'On days off',
      align: 'right',
      render: (e) => {
        const count = conflictCounts.get(e.epicKey) ?? 0;
        return count === 0 ? (
          <span className="muted">0</span>
        ) : (
          <Link
            className="button"
            to={`${projectPath(projectKey, 'phase-subtasks')}?epic=${e.epicKey}`}
            title="Planned start/end dates falling on a day off. Click to see which sub-tasks."
          >
            ⚠ {count}
          </Link>
        );
      },
      sortKey: (e) => conflictCounts.get(e.epicKey) ?? 0,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (e) => (
        <span className="row">
          <Link className="button" to={`${projectPath(projectKey, 'burndown')}?epic=${e.epicKey}`}>
            Chart
          </Link>
          <Link className="button" to={`${projectPath(projectKey, 'signboard')}?epic=${e.epicKey}`}>
            Signboard
          </Link>
          <Link className="button" to={`${projectPath(projectKey, 'phase-subtasks')}?epic=${e.epicKey}`}>
            Sub-tasks
          </Link>
          {/* Nhãn phải đúng chữ "Resync": cả runbook lẫn màn hình Biểu đồ đều
              chỉ người dùng sang đây bằng đúng cụm từ này. */}
          <button
            type="button"
            className="button"
            disabled={e.status === 'PAUSED'}
            title={e.status === 'PAUSED' ? 'This Epic is paused. Resume it first.' : undefined}
            onClick={() => setResyncing(e)}
          >
            Resync
          </button>
          {/* Tạm dừng và Bỏ theo dõi là HAI thao tác khác nhau: một cái giữ dữ
              liệu, một cái xoá sạch. Nhãn phải nói rõ điều đó. */}
          <button
            type="button"
            className="button"
            disabled={patch.isPending}
            onClick={() =>
              patch.mutate({
                epicKey: e.epicKey,
                patch: { status: e.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED' },
              })
            }
          >
            {e.status === 'PAUSED' ? 'Resume' : 'Pause (keep data)'}
          </button>
          <button type="button" className="button button--danger" onClick={() => setRemoving(e)}>
            Untrack (delete data)
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="stack">
      {patch.isError && <ErrorState error={patch.error} title="Could not change Epic status" />}

      <section className="panel">
        <DataTable
          caption="Tracked Epics"
          columns={columns}
          rows={epics}
          rowKey={(e) => e.epicKey}
          empty={
            <EmptyState
              icon="📋"
              title="No Epics tracked yet"
              description="Paste Epic keys in the box below and click Check to get started."
            />
          }
        />
      </section>

      <AddEpicsPanel />

      {openMissing !== null && (
        <MissingDatesPanel epicKey={openMissing} onClose={() => setOpenMissing(null)} />
      )}

      {resyncing !== null && (
        <ResyncDialog epic={resyncing} onClose={() => setResyncing(null)} />
      )}

      {removing !== null && (
        <RemoveEpicDialog epic={removing} onClose={() => setRemoving(null)} />
      )}
    </div>
  );
}

function MissingDatesPanel({ epicKey, onClose }: { readonly epicKey: string; readonly onClose: () => void }) {
  const query = useMissingDates(epicKey);

  return (
    <section className="panel" aria-labelledby="missing-title">
      <h2 className="panel__title" id="missing-title">
        Sub-tasks missing planned dates · {epicKey}
      </h2>
      <p className="panel__hint">
        Without <code>wbs_start_date</code> or <code>wbs_end_date</code> we cannot tell early from
        late. Fix them in Jira, then resync.
      </p>

      {query.isPending && <LoadingState label="Looking for sub-tasks missing dates…" rows={2} />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}

      {query.isSuccess && (
        <ul className="rows">
          {query.data.rows.map((r) => (
            <li className="row" key={r.issueKey}>
              <code>{r.issueKey}</code>
              <span>{r.summary}</span>
              {r.missingStart && <Badge tone="warning">no start date</Badge>}
              {r.missingEnd && <Badge tone="warning">no end date</Badge>}
            </li>
          ))}
        </ul>
      )}

      {query.isSuccess && query.data.rows.length > 0 && (
        <MissingDatesTools epicKey={epicKey} rows={query.data.rows} />
      )}

      <div className="actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

/**
 * Câu JQL và nút tải CSV — hai đường đưa danh sách này RA NGOÀI app: JQL để mở
 * đúng các ticket trên Jira mà điền ngày (bulk edit được), CSV để gửi cho người
 * không có tài khoản app này.
 */
function MissingDatesTools({
  epicKey,
  rows,
}: {
  readonly epicKey: string;
  readonly rows: readonly MissingDateRow[];
}) {
  const [copied, setCopied] = useState(false);
  const jql = buildMissingDatesJql(rows);
  if (jql === null) return null;

  return (
    <div className="stack">
      <label className="field">
        <span>JQL — paste into Jira issue search to open these sub-tasks</span>
        {/* readOnly + tự bôi đen khi focus: nơi clipboard bị trình duyệt chặn
            (chạy qua HTTP nội bộ) thì vẫn Ctrl+C tay được ngay. */}
        <textarea
          className="input"
          readOnly
          rows={3}
          value={jql}
          onFocus={(e) => e.currentTarget.select()}
        />
      </label>
      <div className="row">
        <button
          type="button"
          className="button"
          onClick={() => {
            // Clipboard bị chặn thì nút giữ nguyên chữ "Copy JQL" — người dùng
            // còn ô văn bản bên trên để copy tay, không cần báo lỗi ầm ĩ.
            navigator.clipboard
              ?.writeText(jql)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
        >
          {copied ? 'Copied ✓' : 'Copy JQL'}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => downloadTextFile(missingDatesCsvFilename(epicKey), buildMissingDatesCsv(rows))}
        >
          Download CSV
        </button>
      </div>
    </div>
  );
}

/** Tải một chuỗi xuống thành file — không đụng server, dữ liệu đã ở client. */
function downloadTextFile(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export { RemoveEpicDialog };
