import { useState } from 'react';
import type { DataQualityIssue, OpsHealthResponse } from '@app/shared';
import { useDataQualityIssues, useSetDqExempt } from '../../api/use-ops.js';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  type Column,
} from '../../components/ui/index.js';
import { buildDataQualityCsv, csvFileName, PROBLEM_LABEL } from './data-quality-csv.js';
import { MetricChips } from './metric-chips.js';

/**
 * Khu Data quality — tách theo TỪNG Epic đang theo dõi.
 *
 * Số toàn cục ("5% thiếu ước lượng") không nói được ĐỘI NÀO phải sửa. Mỗi Epic
 * có bộ số đo riêng, và bảng chi tiết chỉ ra đúng ticket lỗi gì để:
 *   1. Xuất CSV gửi cho đội sửa dữ liệu trên Jira.
 *   2. Đánh dấu ticket "không cần sửa" — cố ý thiếu dữ liệu thì đừng cảnh báo
 *      mãi; tiếng ồn lặp lại làm người ta bỏ qua luôn cả cảnh báo thật.
 */

export function DataQualitySection({ data }: { readonly data: OpsHealthResponse['data'] }) {
  const [showDetails, setShowDetails] = useState(false);
  // 'ALL' = mọi Epic. Lọc áp cho CẢ bảng lẫn file CSV — file tải về phải khớp
  // với những gì đang nhìn thấy, không thì "sao file nhiều hơn màn hình?".
  const [epicFilter, setEpicFilter] = useState<string>('ALL');

  const issuesQuery = useDataQualityIssues(showDetails);

  return (
    <section className="panel" aria-labelledby="dq-title">
      <h2 className="panel__title" id="dq-title">
        Data quality
      </h2>

      <MetricChips metrics={data.metrics} />

      {/* Tách theo Epic — Epic tệ nhất đã được API sắp lên trước. */}
      {data.byEpic.map((e) => (
        <div key={e.epicKey}>
          <h3 className="panel__title">
            <code>{e.epicKey}</code> — {e.displayName}{' '}
            <span className="muted">({e.total} sub-tasks checked)</span>
          </h3>
          <MetricChips metrics={e.metrics} />
        </div>
      ))}

      <div className="actions">
        <button type="button" className="button" onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? 'Hide ticket details' : 'Show ticket details'}
        </button>
      </div>

      {showDetails && (
        <DataQualityDetails
          query={issuesQuery}
          epicFilter={epicFilter}
          onEpicFilter={setEpicFilter}
          epicOptions={data.byEpic.map((e) => e.epicKey)}
        />
      )}
    </section>
  );
}

function DataQualityDetails({
  query,
  epicFilter,
  onEpicFilter,
  epicOptions,
}: {
  readonly query: ReturnType<typeof useDataQualityIssues>;
  readonly epicFilter: string;
  readonly onEpicFilter: (value: string) => void;
  readonly epicOptions: readonly string[];
}) {
  const setExempt = useSetDqExempt();

  if (query.isPending) return <LoadingState label="Loading data-quality details…" rows={3} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load data-quality details"
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.isSuccess) return null;

  const all = query.data.issues;
  const filtered = epicFilter === 'ALL' ? all : all.filter((i) => i.epicKey === epicFilter);

  // Danh sách Epic trong bộ lọc lấy từ CẢ hai nguồn: byEpic (Epic sạch vẫn chọn
  // được) và danh sách ticket (phòng Epic có ticket lỗi mà thiếu trong byEpic).
  const options = [...new Set([...epicOptions, ...all.map((i) => i.epicKey)])].sort();

  const download = () => {
    const csv = buildDataQualityCsv(filtered);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFileName(query.data.collectedAt, epicFilter === 'ALL' ? null : epicFilter);
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns: readonly Column<DataQualityIssue>[] = [
    { key: 'epic', header: 'Epic', render: (i) => <code>{i.epicKey}</code>, sortKey: (i) => i.epicKey },
    { key: 'ticket', header: 'Ticket', render: (i) => <code>{i.issueKey}</code>, sortKey: (i) => i.issueKey },
    { key: 'summary', header: 'Summary', render: (i) => i.summary, sortKey: (i) => i.summary },
    {
      key: 'problems',
      header: 'Problems',
      render: (i) => (
        <span className="chips">
          {i.problems.map((p) => (
            <Badge key={p} tone="warning">
              {PROBLEM_LABEL[p]}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      key: 'exempt',
      header: 'Warnings',
      render: (i) => (
        <span>
          {i.exempt && (
            <Badge tone="muted" title={i.exemptBy === null ? undefined : `Marked by ${i.exemptBy}`}>
              muted
            </Badge>
          )}{' '}
          <button
            type="button"
            className="button"
            disabled={setExempt.isPending}
            onClick={() => setExempt.mutate({ issueKey: i.issueKey, exempt: !i.exempt })}
          >
            {/* Chữ trên nút nói HẬU QUẢ, không nói cơ chế: người bấm cần biết
                "từ nay không cảnh báo nữa", không cần biết tên cột trong DB. */}
            {i.exempt ? 'Warn again' : "Don't warn again"}
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="stack">
      <div className="statusbar">
        <label className="check">
          Epic
          <select className="input" value={epicFilter} onChange={(e) => onEpicFilter(e.target.value)}>
            <option value="ALL">All epics</option>
            {options.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button" onClick={download} disabled={filtered.length === 0}>
          Download CSV report ({filtered.length} tickets)
        </button>
      </div>

      {setExempt.isError && (
        <ErrorState error={setExempt.error} title="Could not update the warning flag" />
      )}

      <DataTable
        caption="Sub-tasks with data problems"
        columns={columns}
        rows={filtered}
        rowKey={(i) => i.issueKey}
        empty={
          <EmptyState
            icon="✅"
            title="No data problems"
            description="Every active sub-task in this scope has an estimate, planned dates, a phase, and a well-formed title."
          />
        }
      />
    </div>
  );
}
