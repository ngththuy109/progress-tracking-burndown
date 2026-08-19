import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrackedEpicSummary } from '@app/shared';
import { useEpicList, usePatchEpic } from '../../api/use-epics.js';
import { useCalendars } from '../../api/use-calendars.js';
import { useOpsHealth } from '../../api/use-ops.js';
import { usePlanConflictSummary } from '../../api/use-plan-conflicts.js';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  type BadgeTone,
  type Column,
} from '../../components/ui/index.js';
import { IssueLink } from '../../components/issue-link/index.js';
import { AddEpicsPanel, AddQueryScopePanel } from './add-epics-panel.js';
import { dataProblemsTitle, epicDataProblems } from './data-quality-hint.js';
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
  const query = useEpicList();
  // Hai nguồn CHỈ để biết Epic nào cần sang khu Data quality mà sửa dữ liệu.
  // Cả hai đều KHÔNG chặn màn hình: hỏng thì chỉ mất phần chỉ đường, danh sách
  // Epic vẫn dùng được như thường.
  //
  // `useOpsHealth(false)` — không tự làm mới ở đây (màn Epics không phải màn
  // trực) và dùng chung khoá truy vấn với màn Monitoring, nên bấm sang đó là có
  // sẵn số liệu, không gọi lại.
  const health = useOpsHealth(false);
  const conflictSummary = usePlanConflictSummary();
  const calendars = useCalendars();
  const patch = usePatchEpic();
  const [removing, setRemoving] = useState<Epic | null>(null);
  const [resyncing, setResyncing] = useState<Epic | null>(null);

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
  const metricsByEpic = new Map(
    (health.data?.data.byEpic ?? []).map((e) => [e.epicKey, e.metrics]),
  );
  const conflictCounts = new Map(
    (conflictSummary.data?.counts ?? []).map((c) => [c.epicKey, c.total]),
  );
  const problemsOf = (epicKey: string): readonly string[] =>
    epicDataProblems({
      metrics: metricsByEpic.get(epicKey),
      planConflictCount: conflictCounts.get(epicKey) ?? 0,
    });

  const columns: readonly Column<Epic>[] = [
    {
      key: 'epicKey',
      header: 'Epic',
      render: (e) => (
        <span>
          <IssueLink issueKey={e.epicKey} /> {e.displayName}
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
      // Chỉ đường sang khu Data quality — CHỈ khi Epic đó thật sự có dữ liệu
      // cần sửa. Epic sạch không hiện gì: một lời nhắc hiện thường trực trên
      // mọi dòng là tiếng ồn, và tiếng ồn làm người ta bỏ qua cả cảnh báo thật.
      key: 'dataQuality',
      header: 'Data quality',
      render: (e) => {
        const reasons = problemsOf(e.epicKey);
        if (reasons.length === 0) return null;
        return (
          <Link className="button" to="/ops" title={dataProblemsTitle(reasons)}>
            ⚠ Check data quality
          </Link>
        );
      },
      sortKey: (e) => problemsOf(e.epicKey).length,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (e) => (
        <span className="row">
          <Link className="button" to={`/burndown?epic=${e.epicKey}`}>
            Chart
          </Link>
          <Link className="button" to={`/signboard?epic=${e.epicKey}`}>
            Signboard
          </Link>
          <Link className="button" to={`/phase-subtasks?epic=${e.epicKey}`}>
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
        {/* Không đọc được số liệu chất lượng dữ liệu thì NÓI RA. Cột trống lúc
            đó trông y hệt "mọi Epic đều sạch" — đúng kiểu im lặng mà C-10 cấm. */}
        {(health.isError || conflictSummary.isError) && (
          <p className="panel__hint">
            Could not check data quality right now, so the{' '}
            <strong>Data quality</strong> column may be missing warnings. Open{' '}
            <Link to="/ops">Monitoring</Link> to see why.
          </p>
        )}
      </section>

      <AddEpicsPanel />
      <AddQueryScopePanel />

      {resyncing !== null && (
        <ResyncDialog epic={resyncing} onClose={() => setResyncing(null)} />
      )}

      {removing !== null && (
        <RemoveEpicDialog epic={removing} onClose={() => setRemoving(null)} />
      )}
    </div>
  );
}

export { RemoveEpicDialog };
