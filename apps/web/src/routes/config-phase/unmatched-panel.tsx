import type { UnmatchedLabel } from '@app/shared';
import { useUnmatched } from '../../api/use-phase-config.js';
import { DataTable, EmptyState, ErrorState, LoadingState, type Column } from '../../components/ui/index.js';

/**
 * Khu "Chưa nhận diện được" — PRD §2.2.5.
 *
 * Đây là danh sách việc phải làm của PM: mỗi dòng là một chuỗi bóc được từ tiêu
 * đề nhưng không luật nào khớp. Nút "Thêm thành luật" đẩy thẳng chuỗi đó xuống
 * khu ③, để PM không phải gõ lại và không gõ sai chính tả.
 */
export interface UnmatchedPanelProps {
  readonly projectKey: string | null;
  readonly onAddRule: (keyword: string) => void;
}

export function UnmatchedPanel({ projectKey, onAddRule }: UnmatchedPanelProps) {
  const query = useUnmatched(projectKey);

  if (query.isPending) return <LoadingState label="Looking for unrecognised labels…" rows={2} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load the unrecognised list"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const columns: readonly Column<UnmatchedLabel>[] = [
    {
      key: 'label',
      header: 'Extracted text',
      render: (row) =>
        row.rawPhaseLabel === null ? (
          // Khác hẳn "bóc ra rồi nhưng không luật nào khớp": ca này là mẫu tiêu
          // đề không khớp, phải sửa ở khu ① chứ không phải khu ③.
          <span className="muted">nothing extracted — no title pattern matched</span>
        ) : (
          <code>{row.rawPhaseLabel}</code>
        ),
      sortKey: (row) => row.rawPhaseLabel,
    },
    {
      key: 'count',
      header: 'Tasks',
      align: 'right',
      render: (row) => row.count,
      sortKey: (row) => row.count,
    },
    {
      key: 'samples',
      header: 'Examples',
      render: (row) => <span className="muted">{row.sampleTaskKeys.join(', ')}</span>,
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (row) =>
        row.rawPhaseLabel === null ? null : (
          <button type="button" className="button" onClick={() => onAddRule(row.rawPhaseLabel ?? '')}>
            Add as a rule
          </button>
        ),
    },
  ];

  return (
    <section className="panel" aria-labelledby="unmatched-title">
      <h2 className="panel__title" id="unmatched-title">
        Unrecognised
      </h2>
      <DataTable
        caption="Labels extracted from titles that no rule matches yet"
        columns={columns}
        rows={query.data}
        rowKey={(row) => row.rawPhaseLabel ?? '(nothing extracted)'}
        empty={
          <EmptyState
            icon="✅"
            title="Every Task was recognised"
            description="No label falls outside the current matching rules."
          />
        }
      />
    </section>
  );
}
