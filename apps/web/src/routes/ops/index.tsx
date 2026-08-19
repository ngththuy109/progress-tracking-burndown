import { useState } from 'react';
import type { JobRun, OpsMetric } from '@app/shared';
import { useOpsHealth, useResyncEpic } from '../../api/use-ops.js';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  type Column,
} from '../../components/ui/index.js';
import { IssueLink } from '../../components/issue-link/index.js';
import { DataQualitySection } from './data-quality.js';
import { formatLocalDateTime } from './format.js';
import { LEVEL_TONE, MetricChips } from './metric-chips.js';
import { RunDetailDialog } from './run-detail-dialog.js';

/**
 * Dashboard giám sát vận hành — dành cho DevOps và Tech Lead, không phải cho PM.
 *
 * ĐÂY LÀ MÀN HÌNH PHẢI XEM ĐƯỢC LÚC 2 GIỜ SÁNG. Người mở nó đang bị đánh thức
 * bởi cảnh báo và cần biết ngay: cái gì hỏng, ảnh hưởng Epic nào, làm gì tiếp.
 * Không phải lúc để đẹp.
 */

export function OpsScreen() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  // Dòng FAILED nào đang được mở xem chi tiết lỗi. `null` = không mở hộp nào.
  const [errorRunId, setErrorRunId] = useState<string | null>(null);
  const query = useOpsHealth(autoRefresh);
  const resync = useResyncEpic();

  if (query.isPending) return <LoadingState label="Loading operational metrics…" rows={4} />;
  if (query.isError) {
    return (
      <ErrorState error={query.error} title="Could not load operational metrics" onRetry={() => void query.refetch()} />
    );
  }

  const data = query.data;

  return (
    <div className="stack">
      <div className="statusbar">
        {/* Thiếu dòng này thì có người ra quyết định trên số liệu của 20 phút
            trước mà không biết. Hiện theo GIỜ MÁY NGƯỜI XEM — chuỗi UTC bắt
            người trực tự trừ múi giờ lúc 2 giờ sáng; ISO gốc giữ trong tooltip
            để đối chiếu với log máy chủ. */}
        <span className="muted" title={data.collectedAt}>
          Data collected at {formatLocalDateTime(data.collectedAt)}
        </span>
        <span className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh every 60 seconds
          </label>
          <button type="button" className="button" onClick={() => void query.refetch()}>
            Refresh now
          </button>
        </span>
      </div>

      {/* Thứ tự ưu tiên: chất lượng dữ liệu trước, rồi tới lần chạy job gần nhất,
          các cụm số đo, Epic đang lỗi, và cuối cùng là trôi kế hoạch. */}
      <DataQualitySection data={data.data} />

      {errorRunId !== null && <RunDetailDialog runId={errorRunId} onClose={() => setErrorRunId(null)} />}

      <RecentRuns runs={data.jobs.recentRuns} onShowError={setErrorRunId} />

      <MetricGroup title="Nightly jobs" metrics={data.jobs.metrics} />
      <MetricGroup title="Jira calls" metrics={data.jira.metrics} />

      <ErroredEpics
        epics={data.jobs.erroredEpics}
        // Ở màn hình này cố ý CHỈ có mức Nhanh, một cú bấm. Người trực lúc 2 giờ
        // sáng cần thử lại cho nhanh, không cần chọn mức. Ba mức đầy đủ nằm ở
        // màn hình Epic, nơi người ta có thời gian đọc.
        onResync={(key) => resync.mutate({ epicKey: key, body: { from: null, to: null, full: false } })}
        pending={resync.isPending}
        queuedKey={resync.isSuccess ? resync.variables.epicKey : null}
      />

      <PlanDrift rows={data.planDrift.rows} />
    </div>
  );
}

function MetricGroup({ title, metrics }: { readonly title: string; readonly metrics: readonly OpsMetric[] }) {
  return (
    <section className="panel">
      <h2 className="panel__title">{title}</h2>
      <MetricChips metrics={metrics} />
    </section>
  );
}

function ErroredEpics({
  epics,
  onResync,
  pending,
  queuedKey,
}: {
  readonly epics: readonly { epicKey: string; lastError: string; erroredSinceHours: number }[];
  readonly onResync: (epicKey: string) => void;
  readonly pending: boolean;
  readonly queuedKey: string | null;
}) {
  return (
    <section className="panel" aria-labelledby="errored-title">
      <h2 className="panel__title" id="errored-title">
        Epics in error ({epics.length})
      </h2>

      {epics.length === 0 ? (
        <p className="muted">No Epic is in error.</p>
      ) : (
        <ul className="rows">
          {epics.map((e) => (
            <li className="row" key={e.epicKey}>
              <IssueLink issueKey={e.epicKey} />
              <Badge tone="danger">{Math.round(e.erroredSinceHours)}h</Badge>
              {/* NGUYÊN VĂN lỗi — "Sync failed" không nói được phải làm gì tiếp. */}
              <span>{e.lastError}</span>
              <button
                type="button"
                className="button"
                disabled={pending}
                onClick={() => onResync(e.epicKey)}
              >
                {queuedKey === e.epicKey ? 'Queued' : 'Run again'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentRuns({
  runs,
  onShowError,
}: {
  readonly runs: readonly JobRun[];
  readonly onShowError: (runId: string) => void;
}) {
  const columns: readonly Column<JobRun>[] = [
    {
      key: 'startedAt',
      header: 'Started',
      // Giờ MÁY NGƯỜI XEM; ISO gốc trong tooltip để đối chiếu log máy chủ (UTC).
      render: (r) => <span title={r.startedAt}>{formatLocalDateTime(r.startedAt)}</span>,
      sortKey: (r) => r.startedAt,
    },
    { key: 'epic', header: 'Epic', render: (r) => <IssueLink issueKey={r.epicKey} />, sortKey: (r) => r.epicKey },
    { key: 'type', header: 'Type', render: (r) => r.runType, sortKey: (r) => r.runType },
    {
      key: 'duration',
      header: 'Duration (s)',
      align: 'right',
      // Job đêm dài dần là dấu hiệu SỚM NHẤT của việc hệ thống sắp không kịp.
      render: (r) => (r.durationSeconds === null ? <span className="muted">running</span> : r.durationSeconds),
      sortKey: (r) => r.durationSeconds,
    },
    {
      key: 'status',
      header: 'Outcome',
      render: (r) => (
        <span>
          <Badge tone={r.status === 'SUCCESS' ? 'success' : 'danger'}>{r.status}</Badge>
          {r.errorMessage !== null && (
            <div className="muted">
              {r.errorMessage}{' '}
              {/* Dẫn tới chi tiết: một dòng thông báo không nói được lỗi Ở ĐÂU
                  trong pipeline và nguyên nhân đầy đủ (stack). */}
              <button type="button" className="button" onClick={() => onShowError(r.runId)}>
                Error details
              </button>
            </div>
          )}
        </span>
      ),
      sortKey: (r) => r.status,
    },
  ];

  return (
    <section className="panel">
      <DataTable
        caption="Most recent job runs"
        columns={columns}
        rows={runs}
        rowKey={(r) => r.runId}
        empty={
          // Hiện số 0 khi chưa có dữ liệu trông y hệt "mọi thứ bình thường" —
          // đây là lỗi im lặng nguy hiểm nhất của một màn hình giám sát.
          <EmptyState
            icon="⏳"
            title="No job has ever run"
            description="The system has never run a sync job. This is NOT 'everything is fine' — check that the worker started."
          />
        }
      />
    </section>
  );
}

function PlanDrift({
  rows,
}: {
  readonly rows: readonly {
    epicKey: string;
    phaseCode: string;
    shiftedWorkdays: number;
    planWorkdays: number;
    ratio: number;
    level: string;
  }[];
}) {
  // Nghiêm trọng lên trước — người trực đọc từ trên xuống.
  const sorted = [...rows].sort((a, b) => b.ratio - a.ratio);

  return (
    <section className="panel" aria-labelledby="drift-title">
      <h2 className="panel__title" id="drift-title">
        Plan drift ({rows.length})
      </h2>
      {rows.length === 0 ? (
        <p className="muted">No Phase has slipped past the threshold.</p>
      ) : (
        <ul className="rows">
          {sorted.map((r) => (
            <li className="row" key={`${r.epicKey}:${r.phaseCode}`}>
              <IssueLink issueKey={r.epicKey} />
              <span>{r.phaseCode}</span>
              <Badge tone={LEVEL_TONE[r.level] ?? 'muted'}>{r.level}</Badge>
              <span>
                slipped {r.shiftedWorkdays} / {r.planWorkdays} days ({(r.ratio * 100).toFixed(0)}%)
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
