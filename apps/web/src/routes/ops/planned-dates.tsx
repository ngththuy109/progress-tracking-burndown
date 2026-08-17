import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { MissingDateRow, TrackedEpicSummary } from '@app/shared';
import { useEpicList, useMissingDates } from '../../api/use-epics.js';
import { usePlanConflictSummary } from '../../api/use-plan-conflicts.js';
import {
  Badge,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  type Column,
} from '../../components/ui/index.js';
import { IssueLink } from '../../components/issue-link/index.js';
import {
  buildMissingDatesCsv,
  buildMissingDatesJql,
  missingDatesCsvFilename,
} from './missing-dates-export.js';

/**
 * Hai lỗi NGÀY KẾ HOẠCH, tách theo Epic: Sub-task thiếu ngày, và ngày kế hoạch
 * rơi trúng ngày nghỉ.
 *
 * Trước đây hai cột này nằm ở màn hình Epics — nơi PM vào để THÊM/BỎ Epic, chứ
 * không phải để soi chất lượng dữ liệu. Gom về đây thì mọi thứ "dữ liệu Jira
 * đang sai chỗ nào" nằm chung một khu, và màn Epics còn lại đúng việc của nó.
 *
 * Các chip phần trăm ở trên nói CÓ BAO NHIÊU; bảng này nói ĐÍCH DANH Epic nào và
 * mở thẳng được danh sách ticket để gửi cho đội sửa trên Jira.
 */

type Epic = TrackedEpicSummary;

export function PlannedDatesBlock() {
  const epics = useEpicList();
  // Plan rơi vào ngày nghỉ (T-37) — một lần gọi cho cả danh sách. Lỗi ở đây
  // KHÔNG chặn cả khu: cột chỉ nói thẳng là chưa kiểm được.
  const conflicts = usePlanConflictSummary();
  const [openMissing, setOpenMissing] = useState<string | null>(null);

  if (epics.isPending) return <LoadingState label="Loading planned-date problems…" rows={2} />;
  if (epics.isError) {
    return (
      <ErrorState
        error={epics.error}
        title="Could not load planned-date problems"
        onRetry={() => void epics.refetch()}
      />
    );
  }

  const conflictCounts = new Map((conflicts.data?.counts ?? []).map((c) => [c.epicKey, c.total]));

  const columns: readonly Column<Epic>[] = [
    {
      key: 'epic',
      header: 'Epic',
      render: (e) => (
        <span>
          <IssueLink issueKey={e.epicKey} /> {e.displayName}
        </span>
      ),
      sortKey: (e) => e.epicKey,
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
      // Bấm vào là sang màn Sub-tasks, nơi từng dòng vi phạm được gắn cờ ⚠ kèm lý do.
      key: 'planConflicts',
      header: 'On days off',
      align: 'right',
      render: (e) => {
        // Chưa kiểm được thì NÓI RÕ, không hiện 0 — số 0 trông y hệt "sạch" (C-10).
        if (conflicts.isError) {
          return (
            <span className="muted" title={conflicts.error.message}>
              not checked
            </span>
          );
        }
        const count = conflictCounts.get(e.epicKey) ?? 0;
        return count === 0 ? (
          <span className="muted">0</span>
        ) : (
          <Link
            className="button"
            to={`/phase-subtasks?epic=${e.epicKey}`}
            title="Planned start/end dates falling on a day off. Click to see which sub-tasks."
          >
            ⚠ {count}
          </Link>
        );
      },
      sortKey: (e) => conflictCounts.get(e.epicKey) ?? 0,
    },
  ];

  return (
    // Khung riêng (`panel`) để bảng này KHÔNG bị đọc nhầm là phần của cụm chip
    // Epic ngay phía trên — nó tính trên MỌI Epic, không phải Epic cuối cùng.
    <section className="panel stack" aria-labelledby="planned-dates-title">
      <h3 className="panel__title" id="planned-dates-title">
        Planned dates
      </h3>
      <p className="panel__hint">
        Sub-tasks with no <code>wbs_start_date</code>/<code>wbs_end_date</code>, and planned dates
        that land on a day off. Both are fixed in Jira, then resynced.
      </p>

      <DataTable
        caption="Planned-date problems by Epic"
        columns={columns}
        rows={epics.data}
        rowKey={(e) => e.epicKey}
        empty={
          <EmptyState
            icon="📋"
            title="No Epics tracked yet"
            description="Add Epics on the Epics screen; their planned-date problems show up here."
          />
        }
      />

      {openMissing !== null && (
        <MissingDatesPanel epicKey={openMissing} onClose={() => setOpenMissing(null)} />
      )}
    </section>
  );
}

function MissingDatesPanel({
  epicKey,
  onClose,
}: {
  readonly epicKey: string;
  readonly onClose: () => void;
}) {
  const query = useMissingDates(epicKey);

  return (
    <section className="panel" aria-labelledby="missing-title">
      <h3 className="panel__title" id="missing-title">
        Sub-tasks missing planned dates · {epicKey}
      </h3>
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
              <IssueLink issueKey={r.issueKey} />
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
          onClick={() =>
            downloadTextFile(missingDatesCsvFilename(epicKey), buildMissingDatesCsv(rows))
          }
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
