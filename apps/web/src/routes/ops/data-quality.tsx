import { useState } from 'react';
import type { DataQualityIssue, DqProblem, OpsHealthResponse } from '@app/shared';
import { useDataQualityIssues, useSetDqExempt } from '../../api/use-ops.js';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  MultiSelect,
  type Column,
} from '../../components/ui/index.js';
import { IssueLink } from '../../components/issue-link/index.js';
import { buildDataQualityCsv, csvFileName, PROBLEM_LABEL } from './data-quality-csv.js';
import {
  filterIssues,
  keepAvailable,
  picLabel,
  picOptions,
  problemOptions,
} from './data-quality-filter.js';
import { MetricChips } from './metric-chips.js';

/**
 * Khu Data quality — tách theo TỪNG Epic đang theo dõi.
 *
 * Số toàn cục ("5% thiếu ước lượng") không nói được ĐỘI NÀO phải sửa. Mỗi Epic
 * có bộ số đo riêng, và bảng chi tiết chỉ ra đúng ticket lỗi gì để:
 *   1. Xuất CSV gửi cho đội sửa dữ liệu trên Jira.
 *   2. Đánh dấu ticket "không cần sửa" — cố ý thiếu dữ liệu thì đừng cảnh báo
 *      mãi; tiếng ồn lặp lại làm người ta bỏ qua luôn cả cảnh báo thật.
 *   3. Lọc theo Epic / PIC / LOẠI LỖI, và cả ba đều CHỌN NHIỀU: một danh sách
 *      trộn nhiều Epic, nhiều người và cả sáu loại lỗi (kể cả "plan vào ngày
 *      nghỉ" — T-37) rất khó xử lý; thu về một TỔ HỢP đang quan tâm ("An với
 *      Bình, chỉ hai loại lỗi này") thì thành việc làm được ngay.
 */

export function DataQualitySection({ data }: { readonly data: OpsHealthResponse['data'] }) {
  const [showDetails, setShowDetails] = useState(false);
  // Mảng rỗng = mọi Epic / mọi người / mọi loại lỗi. Lọc áp cho CẢ bảng lẫn file
  // CSV — file tải về phải khớp với những gì đang nhìn thấy, không thì "sao file
  // nhiều hơn màn hình?".
  const [epicFilter, setEpicFilter] = useState<readonly string[]>([]);
  // Lọc theo NGƯỜI PHỤ TRÁCH: người đi sửa dữ liệu trên Jira chỉ sửa được ticket
  // của chính mình, nên đây là bộ lọc biến danh sách thành việc làm được. Chọn
  // nhiều người để một quản lý gom được nhóm mình phụ trách.
  const [picFilter, setPicFilter] = useState<readonly string[]>([]);
  // Lọc theo LOẠI LỖI: chọn nhiều loại để xử lý một cụm ("chỉ hai loại ngày tháng").
  const [problemFilter, setProblemFilter] = useState<readonly string[]>([]);

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
  readonly epicFilter: readonly string[];
  readonly onEpicFilter: (value: readonly string[]) => void;
  readonly picFilter: readonly string[];
  readonly onPicFilter: (value: readonly string[]) => void;
  readonly problemFilter: readonly string[];
  readonly onProblemFilter: (value: readonly string[]) => void;
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
  const epicValues = [...new Set([...epicOptions, ...all.map((i) => i.epicKey)])].sort();
  // Hai ô chọn phụ (PIC, loại lỗi) tính TRONG phạm vi Epic đang chọn nhưng KHÔNG
  // theo lẫn nhau — chọn một cái không làm rỗng danh sách của cái kia.
  const epicScope = filterIssues(all, { epicKeys: epicFilter, pics: [], problems: [] });
  const pics = picOptions(epicScope);
  const problems = problemOptions(epicScope);
  // Đổi Epic xong, một PIC đã chọn có thể không còn ticket nào ở Epic mới. Khi đó
  // cho nó tạm ngưng tác dụng (lọc bằng phần giao) thay vì để bảng trống trông y
  // hệt "Epic này sạch" — nhưng vẫn GIỮ lựa chọn gốc để quay lại Epic cũ thì hiện
  // lại. Loại lỗi luôn đủ sáu nên không cần xử lý này.
  const picValues = pics.map((p) => p.value);
  const activePics = keepAvailable(picFilter, picValues);
  const filtered = filterIssues(all, {
    epicKeys: epicFilter,
    pics: activePics,
    problems: problemFilter as readonly DqProblem[],
  });

  // Giữ lại lựa chọn PIC NGOÀI phạm vi Epic hiện tại (đang ẩn khỏi danh sách) rồi
  // ghép với phần người dùng vừa đổi — nhờ đó chuyển Epic qua lại không đánh rơi
  // những người đã chọn ở Epic khác.
  const changePics = (next: readonly string[]): void => {
    const hidden = picFilter.filter((v) => !picValues.includes(v));
    onPicFilter([...hidden, ...next]);
  };

  const download = () => {
    const csv = buildDataQualityCsv(filtered);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    // Tên file gắn Epic khi lọc đúng MỘT Epic; nhiều Epic thì để tên chung.
    a.download = csvFileName(query.data.collectedAt, epicFilter.length === 1 ? epicFilter[0]! : null);
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
        <div className="scope">
          <MultiSelect
            label="Epic"
            allLabel="All epics"
            ariaLabel="Filter by Epic"
            options={epicValues.map((k) => ({ value: k, label: k }))}
            selected={epicFilter}
            onChange={onEpicFilter}
          />
          <MultiSelect
            label="PIC"
            allLabel="All PICs"
            ariaLabel="Filter by PIC"
            // Số ticket ngay trong ô chọn: người dùng thấy được khối lượng của
            // mình TRƯỚC khi bấm, không phải chọn rồi mới biết.
            options={pics.map((p) => ({ value: p.value, label: p.label, count: p.count }))}
            selected={activePics}
            onChange={changePics}
          />
          <MultiSelect
            label="Problem"
            allLabel="All problems"
            ariaLabel="Filter by problem type"
            // Đủ cả sáu loại (kể cả loại 0 ticket), theo thứ tự số đo phía trên.
            options={problems.map((p) => ({
              value: p.value,
              label: PROBLEM_LABEL[p.value],
              count: p.count,
            }))}
            selected={problemFilter}
            onChange={onProblemFilter}
          />
        </div>
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
              activePics.length === 0 && problemFilter.length === 0
                ? 'Every active sub-task in this scope has an estimate, planned dates, a phase, a well-formed title, and no planned date on a day off.'
                : // Rỗng vì BỘ LỌC chứ không phải vì dữ liệu sạch — nói rõ ra,
                  // không thì người dùng đóng màn hình và tin là hết việc.
                  'Nothing matches the current filters in this scope. Clear the PIC or problem filters to see the rest.'
            }
          />
        }
      />
    </div>
  );
}
