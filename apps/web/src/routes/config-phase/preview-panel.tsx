import { UNCLASSIFIED_LABEL, type PreviewResponse, type PreviewRow } from '@app/shared';
import { Badge, DataTable, type BadgeTone, type Column } from '../../components/ui/index.js';

/**
 * Bảng Xem thử — PRD §2.2.5.
 *
 * Xem thử là tính năng BẮT BUỘC, không phải tiện ích thêm: không có nó thì PM
 * sửa xong phải đợi tới job đêm hôm sau mới biết đúng hay sai, và cấu hình
 * "đơn giản" trở thành không dùng được trên thực tế.
 *
 * Cột quan trọng nhất là **Luật thắng** — thứ PM cần nhất để hiểu VÌ SAO ra kết
 * quả đó. Bảng chỉ hiện Phase đích mà không nói luật nào thắng thì PM không biết
 * phải sửa dòng nào ở khu ③.
 */

const STATUS_TONE: Record<PreviewRow['status'], BadgeTone> = {
  UNCHANGED: 'muted',
  CHANGED: 'info',
  STILL_UNCLASSIFIED: 'warning',
};

const STATUS_LABEL: Record<PreviewRow['status'], string> = {
  UNCHANGED: 'unchanged',
  CHANGED: 'reclassified',
  STILL_UNCLASSIFIED: 'still unclassified',
};

const COLUMNS: readonly Column<PreviewRow>[] = [
  {
    key: 'title',
    header: 'Original title',
    render: (r) => (
      <span title={r.taskKey}>
        <code>{r.taskKey}</code> {r.originalTitle}
      </span>
    ),
    sortKey: (r) => r.originalTitle,
  },
  {
    key: 'pattern',
    header: 'Pattern matched',
    render: (r) => (r.matchedPattern === null ? <span className="muted">none</span> : <code>{r.matchedPattern}</code>),
  },
  {
    key: 'extracted',
    header: 'Extracted',
    render: (r) => (r.extractedName === null ? <span className="muted">—</span> : r.extractedName),
  },
  {
    key: 'rule',
    header: 'Winning rule',
    render: (r) =>
      r.winningRule === null ? (
        <span className="muted">none</span>
      ) : (
        <span>
          <code>{r.winningRule.keyword}</code>{' '}
          <span className="muted">
            ({r.winningRule.mode === 'REGEX' ? 'regex' : 'contains'}, priority {r.winningRule.priority})
          </span>
        </span>
      ),
  },
  {
    key: 'result',
    header: '→ Phase',
    render: (r) => (r.resultPhaseCode === 'UNCLASSIFIED' ? UNCLASSIFIED_LABEL : r.resultLabel),
    sortKey: (r) => r.resultLabel,
  },
  {
    key: 'status',
    header: 'Outcome',
    render: (r) => (
      <Badge tone={STATUS_TONE[r.status]} title={`Previously: ${r.previousPhaseCode}`}>
        {STATUS_LABEL[r.status]}
      </Badge>
    ),
    sortKey: (r) => r.status,
  },
];

export interface PreviewPanelProps {
  readonly result: PreviewResponse;
  readonly onBack: () => void;
  readonly onConfirm: () => void;
  readonly saving: boolean;
}

export function PreviewPanel({ result, onBack, onConfirm, saving }: PreviewPanelProps) {
  const { summary, rows, totalTasks } = result;
  const truncated = rows.length < totalTasks;
  const minutes = Math.max(1, Math.round(summary.estimatedRecomputeSeconds / 60));

  return (
    <section className="panel" aria-labelledby="preview-title">
      <h2 className="panel__title" id="preview-title">
        Preview results
      </h2>

      <p className="preview__summary">
        <strong>{totalTasks} Tasks</strong> — {summary.changed} reclassified, {summary.unchanged}{' '}
        unchanged, {summary.stillUnclassified} still unclassified.
      </p>

      <p className="muted">
        After saving, <strong>{summary.affectedEpics} Epics</strong> need recomputing, which takes{' '}
        {/* Là ƯỚC TÍNH, không phải cam kết — con số thật phụ thuộc số ngày lịch
            sử và số Sub-task của từng Epic. Cố ý KHÔNG làm đồng hồ đếm ngược. */}
        <strong>about {minutes} minutes</strong>. Charts stay readable meanwhile, just not up to date.
      </p>

      {truncated && (
        <p className="muted">
          The table shows {rows.length} of {totalTasks} Tasks. The summary above counts
          <strong> all</strong> of them, not just the ones shown.
        </p>
      )}

      <DataTable
        caption="Classification results with the draft settings applied"
        columns={COLUMNS}
        rows={rows}
        rowKey={(r) => r.taskKey}
      />

      <div className="actions">
        <button type="button" className="button" onClick={onBack} disabled={saving}>
          Back to editing
        </button>
        <button type="button" className="button button--primary" onClick={onConfirm} disabled={saving}>
          {saving ? 'Saving…' : 'Confirm save'}
        </button>
      </div>
    </section>
  );
}
