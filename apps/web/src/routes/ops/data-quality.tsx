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
import { IssueLink } from '../../components/issue-link/index.js';
import { buildDataQualityCsv, csvFileName, PROBLEM_LABEL } from './data-quality-csv.js';
import { ALL, filterIssues, picLabel, picOptions } from './data-quality-filter.js';
import { MetricChips } from './metric-chips.js';
import { PlannedDatesBlock } from './planned-dates.js';

/**
 * Khu Data quality — tách theo TỪNG Epic đang theo dõi.
 *
 * Số toàn cục ("5% thiếu ước lượng") không nói được ĐỘI NÀO phải sửa. Mỗi Epic
 * có bộ số đo riêng, và bảng chi tiết chỉ ra đúng ticket lỗi gì để:
 *   1. Xuất CSV gửi cho đội sửa dữ liệu trên Jira.
 *   2. Đánh dấu ticket "không cần sửa" — cố ý thiếu dữ liệu thì đừng cảnh báo
 *      mãi; tiếng ồn lặp lại làm người ta bỏ qua luôn cả cảnh báo thật.
 *   3. Đếm hai lỗi NGÀY KẾ HOẠCH theo Epic (`PlannedDatesBlock`): thiếu ngày, và
 *      ngày rơi trúng ngày nghỉ. Hai số này trước ở màn Epics — chúng là chất
 *      lượng dữ liệu, nên thuộc về đây.
 */

export function DataQualitySection({ data }: { readonly data: OpsHealthResponse['data'] }) {
  const [showDetails, setShowDetails] = useState(false);
  // 'ALL' = mọi Epic / mọi người. Lọc áp cho CẢ bảng lẫn file CSV — file tải về
  // phải khớp với những gì đang nhìn thấy, không thì "sao file nhiều hơn màn
  // hình?".
  const [epicFilter, setEpicFilter] = useState<string>(ALL);
  // Lọc theo NGƯỜI PHỤ TRÁCH: người đi sửa dữ liệu trên Jira chỉ sửa được
  // ticket của chính mình, nên đây là bộ lọc biến danh sách thành việc làm được.
  const [picFilter, setPicFilter] = useState<string>(ALL);

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
            <IssueLink issueKey={e.epicKey} /> — {e.displayName}{' '}
            <span className="muted">({e.total} sub-tasks checked)</span>
          </h3>
          <MetricChips metrics={e.metrics} />
        </div>
      ))}

      <PlannedDatesBlock />

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
          picFilter={picFilter}
          onPicFilter={setPicFilter}
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
  picFilter,
  onPicFilter,
  epicOptions,
}: {
  readonly query: ReturnType<typeof useDataQualityIssues>;
  readonly epicFilter: string;
  readonly onEpicFilter: (value: string) => void;
  readonly picFilter: string;
  readonly onPicFilter: (value: string) => void;
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

  // Danh sách Epic trong bộ lọc lấy từ CẢ hai nguồn: byEpic (Epic sạch vẫn chọn
  // được) và danh sách ticket (phòng Epic có ticket lỗi mà thiếu trong byEpic).
  const options = [...new Set([...epicOptions, ...all.map((i) => i.epicKey)])].sort();
  // Danh sách người lấy theo Epic đang chọn, KHÔNG theo chính bộ lọc PIC — nếu
  // không thì chọn một người xong ô chọn chỉ còn mỗi người đó, không đổi sang
  // người khác được.
  const pics = picOptions(filterIssues(all, { epicKey: epicFilter, pic: ALL }));
  // Đổi Epic xong người đang chọn có thể không còn ticket nào ở Epic mới. Khi đó
  // quay về "All PICs" thay vì giữ một ô chọn trỏ vào người không có trong danh
  // sách — trông y hệt "Epic này sạch" trong khi thật ra chỉ là lọc trượt.
  const activePic = picFilter === ALL || pics.some((p) => p.value === picFilter) ? picFilter : ALL;
  const filtered = filterIssues(all, { epicKey: epicFilter, pic: activePic });

  const download = () => {
    const csv = buildDataQualityCsv(filtered);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFileName(query.data.collectedAt, epicFilter === ALL ? null : epicFilter);
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns: readonly Column<DataQualityIssue>[] = [
    { key: 'epic', header: 'Epic', render: (i) => <IssueLink issueKey={i.epicKey} />, sortKey: (i) => i.epicKey },
    { key: 'ticket', header: 'Ticket', render: (i) => <IssueLink issueKey={i.issueKey} />, sortKey: (i) => i.issueKey },
    { key: 'summary', header: 'Summary', render: (i) => i.summary, sortKey: (i) => i.summary },
    {
      // AI phải sửa ticket này. Không có cột này thì bảng lỗi là việc của "cả
      // đội", tức là của không ai.
      key: 'pic',
      header: 'PIC',
      render: (i) =>
        i.pics.length === 0 ? (
          <span className="muted" title="No Request participants on this ticket in Jira.">
            no PIC yet
          </span>
        ) : (
          <span className="chips">
            {i.pics.map((p) => (
              <Badge key={p.accountId} tone="muted" title={p.accountId}>
                {picLabel(p)}
              </Badge>
            ))}
          </span>
        ),
      // Ticket chưa có PIC xuống cuối bảng, không lên đầu (`null` là "thiếu").
      sortKey: (i) => (i.pics.length === 0 ? null : i.pics.map(picLabel).join(', ')),
    },
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
            <option value={ALL}>All epics</option>
            {options.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          PIC
          <select
            className="input"
            value={activePic}
            aria-label="Filter by PIC"
            onChange={(e) => onPicFilter(e.target.value)}
          >
            <option value={ALL}>All PICs</option>
            {/* Số ticket ngay trong ô chọn: người dùng thấy được khối lượng của
                mình TRƯỚC khi bấm, không phải chọn rồi mới biết. */}
            {pics.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label} ({p.count})
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
            description={
              activePic === ALL
                ? 'Every active sub-task in this scope has an estimate, planned dates, a phase, and a well-formed title.'
                : // Rỗng vì BỘ LỌC chứ không phải vì dữ liệu sạch — nói rõ ra,
                  // không thì người dùng đóng màn hình và tin là hết việc.
                  'Nothing left for this PIC in this scope. Switch the PIC filter to see the rest.'
            }
          />
        }
      />
    </div>
  );
}
