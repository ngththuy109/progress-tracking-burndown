import { useState } from 'react';
import type { ConfigVersion } from '@app/shared';
import { Badge, DataTable, EmptyState, ErrorState, LoadingState, type Column } from '../../components/ui/index.js';
import { useRollback, useVersions } from '../../api/use-phase-config.js';

/**
 * Tab Lịch sử version.
 *
 * Quay lại một version cũ KHÔNG xoá version mới hơn — nó tạo thêm một version
 * nữa có nội dung giống bản cũ. Nhờ vậy lịch sử là một đường thẳng đọc được, và
 * "quay lại nhầm" cũng quay lại được lần nữa.
 */
export interface VersionsPanelProps {
  readonly projectKey: string | null;
}

export function VersionsPanel({ projectKey }: VersionsPanelProps) {
  const query = useVersions(projectKey);
  const rollback = useRollback();
  const [pending, setPending] = useState<number | null>(null);

  if (query.isPending) return <LoadingState label="Loading settings history…" />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Could not load settings history"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const versions = query.data;

  const columns: readonly Column<ConfigVersion>[] = [
    {
      key: 'version',
      header: 'Version',
      render: (v) => (
        <span>
          v{v.version} {v.isActive && <Badge tone="success">in use</Badge>}
        </span>
      ),
      sortKey: (v) => v.version,
    },
    { key: 'by', header: 'Changed by', render: (v) => v.createdBy, sortKey: (v) => v.createdBy },
    { key: 'at', header: 'When', render: (v) => v.createdAt, sortKey: (v) => v.createdAt },
    {
      key: 'note',
      header: 'Note',
      render: (v) => v.note ?? <span className="muted">none</span>,
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (v) =>
        v.isActive ? null : (
          <button
            type="button"
            className="button"
            disabled={rollback.isPending}
            onClick={() => setPending(v.version)}
          >
            Roll back to v{v.version}
          </button>
        ),
    },
  ];

  return (
    <section className="panel" aria-labelledby="versions-title">
      <h2 className="panel__title" id="versions-title">
        Settings history
      </h2>

      {rollback.isError && <ErrorState error={rollback.error} title="Could not roll back" />}

      {rollback.isSuccess && (
        <p className="notice notice--ok" role="status">
          Created version v{rollback.data.version} with the old content.{' '}
          {rollback.data.affectedEpics} Epics will be recomputed.
        </p>
      )}

      {/* Xác nhận trước khi quay lại: thao tác này đánh dấu toàn bộ Epic phải
          tính lại, mất vài phút và không có nút hoàn tác. */}
      {pending !== null && (
        <div className="confirm" role="alertdialog" aria-label="Confirm rolling back to an old version">
          <p>
            Roll back to <strong>v{pending}</strong>? This creates a new version with the same
            content as v{pending}, and every tracked Epic gets recomputed.
          </p>
          <div className="actions">
            <button type="button" className="button" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                rollback.mutate({ projectKey, version: pending });
                setPending(null);
              }}
            >
              Yes, roll back
            </button>
          </div>
        </div>
      )}

      <DataTable
        caption="Versions of this settings set"
        columns={columns}
        rows={versions}
        rowKey={(v) => String(v.version)}
        empty={
          <EmptyState
            title="No versions yet"
            description="This settings set has never been saved from the admin screen."
          />
        }
      />
    </section>
  );
}
