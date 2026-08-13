import { useRunDetail } from '../../api/use-ops.js';
import { ErrorState, LoadingState } from '../../components/ui/index.js';
import { IssueLink } from '../../components/issue-link/index.js';
import { formatLocalDateTime } from './format.js';

/**
 * Chi tiết MỘT lần chạy job — mở từ dòng FAILED ở bảng Recent runs.
 *
 * Bảng chỉ có chỗ cho một dòng thông báo; hộp này trả lời đủ ba câu của người
 * trực: lỗi Ở BƯỚC NÀO của pipeline, NGUYÊN NHÂN là gì (thông báo + stack
 * nguyên văn), và lần chạy đó đã đi được tới đâu (số lần gọi Jira, thời lượng).
 */

/** Bước nào của pipeline — nói bằng câu người đọc được, kèm mã để grep log. */
const STEP_LABEL: Record<string, string> = {
  FETCH_TREE: 'Fetching the issue tree from Jira',
  FETCH_HISTORY: 'Fetching worklogs and changelogs from Jira',
  PERSIST: 'Parsing titles and writing to the database',
  FINALIZE: 'Finalising the run record',
};

export interface RunDetailDialogProps {
  readonly runId: string;
  readonly onClose: () => void;
}

export function RunDetailDialog({ runId, onClose }: RunDetailDialogProps) {
  const query = useRunDetail(runId);

  return (
    <div className="confirm" role="dialog" aria-label={`Details of job run ${runId}`}>
      {query.isPending && <LoadingState label="Loading run details…" rows={3} />}
      {query.isError && (
        <ErrorState error={query.error} title="Could not load run details" onRetry={() => void query.refetch()} />
      )}

      {query.isSuccess && (
        <div className="stack">
          <p>
            Run <strong>#{query.data.runId}</strong> — <IssueLink issueKey={query.data.epicKey} /> (
            {query.data.runType}, {query.data.status})
          </p>
          <ul className="rows">
            <li className="row">
              <span className="muted">Started</span>
              <span title={query.data.startedAt}>{formatLocalDateTime(query.data.startedAt)}</span>
            </li>
            <li className="row">
              <span className="muted">Duration</span>
              <span>{query.data.durationSeconds === null ? 'still running' : `${query.data.durationSeconds} s`}</span>
            </li>
            <li className="row">
              <span className="muted">Jira calls</span>
              <span>
                {query.data.apiCallsMade} ({query.data.rateLimitHits} rate-limited)
              </span>
            </li>
          </ul>

          {query.data.errorMessage === null ? (
            <p className="notice notice--ok" role="status">
              This run finished without an error.
            </p>
          ) : (
            <>
              <p className="notice notice--error" role="alert">
                {/* Bước lỗi trước, thông báo sau: "ở đâu" quyết định mở log nào. */}
                <strong>
                  Failed while: {STEP_LABEL[query.data.errorStep ?? ''] ?? query.data.errorStep ?? 'unknown step (old run, recorded before steps existed)'}
                </strong>
                <br />
                {query.data.errorMessage}
              </p>
              {query.data.errorDetail !== null && (
                <details className="state__technical">
                  <summary>Full stack trace</summary>
                  {/* NGUYÊN VĂN — đây chính là thứ thay cho việc grep log worker giữa đêm. */}
                  <pre>{query.data.errorDetail}</pre>
                </details>
              )}
            </>
          )}
        </div>
      )}

      <div className="actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
