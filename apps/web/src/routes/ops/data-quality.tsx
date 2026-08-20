import { useState } from 'react';
import type { DataQualityIssue, OpsHealthResponse } from '@app/shared';
import { useDataQualityIssues, useSetDqExempt } from '../../api/use-ops.js';
import {
  Badge,
  Combobox,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  type Column,
  type ComboboxOption,
} from '../../components/ui/index.js';
import { IssueLink } from '../../components/issue-link/index.js';
import { buildDataQualityCsv, csvFileName, PROBLEM_LABEL } from './data-quality-csv.js';
import { ALL, filterIssues, picLabel, picOptions, problemOptions } from './data-quality-filter.js';
import { MetricChips } from './metric-chips.js';

/**
 * Khu Data quality — tách theo TỪNG Epic đang theo dõi.
 *
 * Số toàn cục ("5% thiếu ước lượng") không nói được ĐỘI NÀO phải sửa. Mỗi Epic
 * có bộ số đo riêng, và bảng chi tiết chỉ ra đúng ticket lỗi gì để:
 *   1. Xuất CSV gửi cho đội sửa dữ liệu trên Jira.
 *   2. Đánh dấu ticket "không cần sửa" — cố ý thiếu dữ liệu thì đừng cảnh báo
 *      mãi; tiếng ồn lặp lại làm người ta bỏ qua luôn cả cảnh báo thật.
 *   3. Lọc theo LOẠI LỖI (kể cả "plan vào ngày nghỉ" — T-37, nay là loại lỗi thứ
 *      sáu hiện ngay trên từng ticket): danh sách trộn nhiều loại khó xử lý, lọc
 *      xuống một loại thì thành việc làm được ngay.
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
  // Lọc theo LOẠI LỖI: bảng trộn cả sáu loại lỗi khó xử lý; thu về một loại thì
  // xử lý gọn từng nhóm một (vd chỉ xem "Planned on a day off").
  const [problemFilter, setProblemFilter] = useState<string>(ALL);

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
          problemFilter={problemFilter}
          onProblemFilter={setProblemFilter}
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
  problemFilter,
  onProblemFilter,
  epicOptions,
}: {
  readonly query: ReturnType<typeof useDataQualityIssues>;
  readonly epicFilter: string;
  readonly onEpicFilter: (value: string) => void;
  readonly picFilter: string;
  readonly onPicFilter: (value: string) => void;
  readonly problemFilter: string;
  readonly onProblemFilter: (value: string) => void;
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
  // Hai ô chọn phụ (PIC, loại lỗi) tính TRONG phạm vi Epic đang chọn nhưng KHÔNG
  // theo lẫn nhau — chọn một cái không làm rỗng danh sách của cái kia, và cũng
  // không tự khoá vào chính lựa chọn đang chọn.
  const epicScope = filterIssues(all, { epicKey: epicFilter, pic: ALL, problem: ALL });
  const pics = picOptions(epicScope);
  const problems = problemOptions(epicScope);
  // Đổi Epic xong lựa chọn cũ có thể không còn ticket nào ở Epic mới. Khi đó quay
  // về "All …" thay vì giữ ô chọn trỏ vào thứ không có trong danh sách — trông y
  // hệt "Epic này sạch" trong khi thật ra chỉ là lọc trượt.
  const activePic = picFilter === ALL || pics.some((p) => p.value === picFilter) ? picFilter : ALL;
  const activeProblem =
    problemFilter === ALL || problems.some((p) => p.value === problemFilter) ? problemFilter : ALL;
  const filtered = filterIssues(all, { epicKey: epicFilter, pic: activePic, problem: activeProblem });

  // "All PICs" luôn đứng đầu để xoá lọc; mỗi người kèm số ticket (`hint`) — chỉ để
  // hiển thị, KHÔNG tính vào việc gõ tìm (gõ "1" không được khớp theo số lượng).
  const picComboOptions: readonly ComboboxOption[] = [
    { value: ALL, label: 'All PICs' },
    ...pics.map((p) => ({ value: p.value, label: p.label, hint: `(${p.count})` })),
  ];

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
        <span className="check">
          PIC
          {/* Ô chọn CÓ TÌM KIẾM: gõ tên (kể cả không dấu) để lọc nhanh khi đội
              đông, thay cho `<select>` phải cuộn tay. Số ticket đi kèm mỗi tên để
              thấy khối lượng TRƯỚC khi chọn. */}
          <Combobox
            ariaLabel="Filter by PIC"
            placeholder="All PICs"
            emptyText="No matching PIC"
            value={activePic}
            options={picComboOptions}
            onChange={onPicFilter}
          />
        </span>
        <label className="check">
          Problem
          <select
            className="input"
            value={activeProblem}
            aria-label="Filter by problem type"
            onChange={(e) => onProblemFilter(e.target.value)}
          >
            <option value={ALL}>All problems</option>
            {/* Số ticket mỗi loại lỗi ngay trong ô chọn — thấy khối lượng trước
                khi lọc. Chỉ hiện loại đang có ticket, theo thứ tự số đo phía trên. */}
            {problems.map((p) => (
              <option key={p.value} value={p.value}>
                {PROBLEM_LABEL[p.value]} ({p.count})
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
              activePic === ALL && activeProblem === ALL
                ? 'Every active sub-task in this scope has an estimate, planned dates, a phase, a well-formed title, and no planned date on a day off.'
                : // Rỗng vì BỘ LỌC chứ không phải vì dữ liệu sạch — nói rõ ra,
                  // không thì người dùng đóng màn hình và tin là hết việc.
                  'Nothing matches the current filters in this scope. Clear the PIC or problem filter to see the rest.'
            }
          />
        }
      />
    </div>
  );
}
