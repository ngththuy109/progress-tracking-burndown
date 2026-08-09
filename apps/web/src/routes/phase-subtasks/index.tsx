import { useSearchParams } from 'react-router-dom';
import {
  STATUS_CATEGORY_LABEL,
  type PhaseSubtaskGroup,
  type PhaseSubtaskTicket,
  type StatusCategory,
} from '@app/shared';
import { usePhaseSubtasks } from '../../api/use-phase-subtasks.js';
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
 * Màn hình "Sub-task theo Phase".
 *
 * PM chọn một Epic (từ màn hình Epics) và thấy MỌI Phase đã định nghĩa, mỗi
 * Phase kèm danh sách Sub-task nằm trong nó. Phase chưa có ticket vẫn hiện ra
 * (nhóm rỗng) để thấy đủ khung; ticket lạc ngoài luồng gom ở cuối vì chúng vẫn
 * cộng vào biểu đồ Burndown.
 */

const STATUS_TONE: Record<StatusCategory, BadgeTone> = {
  new: 'neutral',
  indeterminate: 'info',
  done: 'success',
};

/** 3600s = 1h; bỏ số 0 thừa để `1.50` hiện thành `1.5`, `8` vẫn là `8`. */
function formatHours(hours: number): string {
  return String(Number(hours.toFixed(2)));
}

function PlanRange({ start, end }: { readonly start: string | null; readonly end: string | null }) {
  if (start === null && end === null) return <span className="muted">no dates</span>;
  return (
    <span>
      {start ?? '—'} <span aria-hidden="true">→</span> {end ?? '—'}
    </span>
  );
}

const COLUMNS: readonly Column<PhaseSubtaskTicket>[] = [
  {
    key: 'issue',
    header: 'Sub-task',
    render: (t) => (
      <span>
        <code>{t.issueKey}</code> {t.summary}
      </span>
    ),
    sortKey: (t) => t.issueKey,
  },
  {
    key: 'parent',
    header: 'Parent',
    render: (t) => (t.parentKey === null ? <span className="muted">—</span> : <code>{t.parentKey}</code>),
    sortKey: (t) => t.parentKey,
  },
  {
    key: 'function',
    header: 'Function',
    render: (t) => (t.functionName === null ? <span className="muted">—</span> : t.functionName),
    sortKey: (t) => t.functionName,
  },
  {
    key: 'status',
    header: 'Status',
    render: (t) => <Badge tone={STATUS_TONE[t.statusCategory]}>{STATUS_CATEGORY_LABEL[t.statusCategory]}</Badge>,
    sortKey: (t) => t.statusCategory,
  },
  {
    key: 'plan',
    header: 'Planned',
    render: (t) => <PlanRange start={t.planStart} end={t.planEnd} />,
    // `null` xuống cuối bảng, không lên đầu (DataTable tự lo hướng).
    sortKey: (t) => t.planStart,
  },
  {
    key: 'estimate',
    header: 'Estimate (h)',
    align: 'right',
    render: (t) => formatHours(t.originalEstimateHours),
    sortKey: (t) => t.originalEstimateHours,
  },
];

export function PhaseSubtasksScreen() {
  const [params, setParams] = useSearchParams();
  const epicKey = params.get('epic');

  const query = usePhaseSubtasks(epicKey);

  if (epicKey === null || epicKey === '') {
    return (
      <EmptyState
        icon="🧾"
        title="No Epic selected"
        description="Open the Epics screen and click Sub-tasks on the Epic you want to see."
      />
    );
  }

  if (query.isPending) return <LoadingState label="Loading sub-tasks…" rows={5} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load the sub-tasks"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const data = query.data;
  const definedCount = data.groups.filter((g) => g.isDefined).length;

  return (
    <div className="stack">
      <div className="scope">
        <span className="scope__label">Epic:</span>
        <code>{epicKey}</code>
        <button type="button" className="button" onClick={() => setParams({})}>
          Change Epic
        </button>
      </div>

      <p className="muted">
        {data.totalSubtasks} sub-task{data.totalSubtasks === 1 ? '' : 's'} across {definedCount} defined
        Phase{definedCount === 1 ? '' : 's'}. Phases with no sub-tasks are still listed so you can see
        the full set.
      </p>

      {data.groups.length === 0 ? (
        <EmptyState
          title="No Phases defined and no sub-tasks yet"
          description="Define Phases on the Phase settings screen, then sync the Epic from Jira."
        />
      ) : (
        data.groups.map((group) => <PhaseGroup key={group.phaseCode} group={group} />)
      )}
    </div>
  );
}

function PhaseGroup({ group }: { readonly group: PhaseSubtaskGroup }) {
  const titleId = `phase-${group.phaseCode}`;
  return (
    <section className="panel" aria-labelledby={titleId}>
      <h2 className="panel__title" id={titleId}>
        {group.colorHex !== null && (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: '0.7em',
              height: '0.7em',
              borderRadius: '2px',
              background: group.colorHex,
              marginRight: '0.4em',
            }}
          />
        )}
        {group.label ?? group.phaseCode} <code>{group.phaseCode}</code>{' '}
        <Badge tone="muted">{group.subtaskCount}</Badge>
        {/* Nhóm ngoài luồng: mã Phase trên ticket không khớp cấu hình nào. Nói
            rõ để PM biết đây là chỗ cần sửa tiêu đề Task hoặc thêm luật khớp. */}
        {!group.isDefined && (
          <Badge tone="warning" title="This phase code is not in the active configuration.">
            not a defined Phase
          </Badge>
        )}
      </h2>

      {group.tickets.length === 0 ? (
        <p className="panel__hint">No sub-task falls into this Phase yet.</p>
      ) : (
        <DataTable
          caption={`Sub-tasks in ${group.label ?? group.phaseCode}`}
          columns={COLUMNS}
          rows={group.tickets}
          rowKey={(t) => t.issueKey}
        />
      )}
    </section>
  );
}
