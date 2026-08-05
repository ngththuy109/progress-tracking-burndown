import { useState } from 'react';
import type { JobRun, OpsMetric } from '@app/shared';
import { useOpsHealth, useResyncEpic } from '../../api/use-ops.js';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  type BadgeTone,
  type Column,
} from '../../components/ui/index.js';

/**
 * Dashboard giám sát vận hành — dành cho DevOps và Tech Lead, không phải cho PM.
 *
 * ĐÂY LÀ MÀN HÌNH PHẢI XEM ĐƯỢC LÚC 2 GIỜ SÁNG. Người mở nó đang bị đánh thức
 * bởi cảnh báo và cần biết ngay: cái gì hỏng, ảnh hưởng Epic nào, làm gì tiếp.
 * Không phải lúc để đẹp.
 */

const LEVEL_TONE: Record<string, BadgeTone> = {
  OK: 'success',
  WARN: 'warning',
  CRITICAL: 'danger',
  UNKNOWN: 'muted',
};

export function OpsScreen() {
  const [autoRefresh, setAutoRefresh] = useState(true);
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
            trước mà không biết. */}
        <span className="muted">Data collected at {data.collectedAt}</span>
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

      <MetricGroup title="Nightly jobs" metrics={data.jobs.metrics} />
      <MetricGroup title="Jira calls" metrics={data.jira.metrics} />
      <MetricGroup title="Data quality" metrics={data.data.metrics} />

      <ErroredEpics
        epics={data.jobs.erroredEpics}
        // Ở màn hình này cố ý CHỈ có mức Nhanh, một cú bấm. Người trực lúc 2 giờ
        // sáng cần thử lại cho nhanh, không cần chọn mức. Ba mức đầy đủ nằm ở
        // màn hình Epic, nơi người ta có thời gian đọc.
        onResync={(key) => resync.mutate({ epicKey: key, body: { from: null, to: null, full: false } })}
        pending={resync.isPending}
        queuedKey={resync.isSuccess ? resync.variables.epicKey : null}
      />

      <RecentRuns runs={data.jobs.recentRuns} />

      <PlanDrift rows={data.planDrift.rows} />
    </div>
  );
}

function MetricGroup({ title, metrics }: { readonly title: string; readonly metrics: readonly OpsMetric[] }) {
  return (
    <section className="panel">
      <h2 className="panel__title">{title}</h2>
      <ul className="chips">
        {metrics.map((m) => (
          <li key={m.name}>
            <Badge tone={LEVEL_TONE[m.level] ?? 'muted'} title={`Threshold: ${m.threshold} ${m.unit}`}>
              {/* Luôn hiện `giá trị / ngưỡng`: số đo không kèm ngưỡng thì vô nghĩa. */}
              {m.label}: {m.value === null ? 'not measured yet' : `${m.value} / ${m.threshold} ${m.unit}`}
            </Badge>
          </li>
        ))}
      </ul>
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
              <code>{e.epicKey}</code>
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

function RecentRuns({ runs }: { readonly runs: readonly JobRun[] }) {
  const columns: readonly Column<JobRun>[] = [
    { key: 'startedAt', header: 'Started', render: (r) => r.startedAt, sortKey: (r) => r.startedAt },
    { key: 'epic', header: 'Epic', render: (r) => <code>{r.epicKey}</code>, sortKey: (r) => r.epicKey },
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
          {r.errorMessage !== null && <div className="muted">{r.errorMessage}</div>}
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
              <code>{r.epicKey}</code>
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
