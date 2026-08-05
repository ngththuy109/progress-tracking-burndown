import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrackedEpicSummary } from '@app/shared';
import { useEpicList, useMissingDates, usePatchEpic } from '../../api/use-epics.js';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  type BadgeTone,
  type Column,
} from '../../components/ui/index.js';
import { AddEpicsPanel } from './add-epics-panel.js';
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
 * Chữ hiển thị ở cột "Last synced".
 *
 * Chưa từng đồng bộ thì NÓI RÕ đang dựng lịch sử lần đầu, không để ô trống —
 * ô trống trông y hệt "hệ thống hỏng".
 */
export function lastSyncedLabel(epic: Epic): string {
  if (epic.lastSyncedAt !== null) return epic.lastSyncedAt;
  if (epic.status === 'BACKFILLING' || epic.status === 'PENDING') {
    return 'building history for the first time';
  }
  return 'never synced';
}

export function EpicListScreen() {
  const query = useEpicList();
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
      render: (e) => <span className={e.lastSyncedAt === null ? 'muted' : ''}>{lastSyncedLabel(e)}</span>,
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

      <div className="actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

export { RemoveEpicDialog };
