import { useState } from 'react';
import type { UpsertProjectRequest } from '@app/shared';
import { useMe } from '../../api/use-me.js';
import { useDeleteProject, useProjects, useUpsertProject } from '../../api/use-projects.js';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/ui/index.js';

/**
 * Màn hình danh mục Project — chỉ ADMIN.
 *
 * Admin đăng ký trước các project ở đây; màn hình cấp quyền (Users) chỉ cho gán
 * PM vào project đã đăng ký. Một project gắn được nhiều PM — cột "PMs" cho thấy
 * con số đó, và chặn xoá khi vẫn còn PM đang gắn.
 */
export function AdminProjectsScreen() {
  const me = useMe();

  if (me.isPending) return <LoadingState label="Loading…" rows={2} />;
  if (me.data && me.data.role !== 'ADMIN') {
    return (
      <EmptyState
        icon="🔒"
        title="Admins only"
        description="Only Admins can manage projects. Ask an admin if you need access."
      />
    );
  }
  return <ProjectsManager />;
}

function ProjectsManager() {
  const query = useProjects();
  const upsert = useUpsertProject();
  const remove = useDeleteProject();

  const [projectKey, setProjectKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  const reset = (): void => {
    setProjectKey('');
    setDisplayName('');
  };

  const submit = (): void => {
    const body: UpsertProjectRequest = {
      projectKey: projectKey.trim(),
      displayName: displayName.trim() === '' ? null : displayName.trim(),
    };
    upsert.mutate(body, { onSuccess: reset });
  };

  if (query.isPending) return <LoadingState label="Loading projects…" rows={3} />;
  if (query.isError) {
    return <ErrorState error={query.error} title="Could not load projects" onRetry={() => void query.refetch()} />;
  }

  const projects = query.data;

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="add-project-title">
        <h2 className="panel__title" id="add-project-title">
          Add a project
        </h2>
        <p className="panel__hint">
          Register the Jira project keys that PMs can be assigned to. Keys are uppercase (e.g.{' '}
          <code>PAY</code>, <code>CRM</code>). Saving an existing key updates its name.
        </p>

        <label className="field">
          <span>Project key</span>
          <input
            className="input input--code"
            value={projectKey}
            placeholder="PAY"
            aria-label="Project key"
            onChange={(e) => setProjectKey(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Display name (optional)</span>
          <input
            className="input"
            value={displayName}
            placeholder="Payments"
            aria-label="Display name"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>

        {upsert.isError && <ErrorState error={upsert.error} title="Could not save this project" />}
        {upsert.isSuccess && (
          <p className="notice notice--ok" role="status">
            Saved <strong>{upsert.data.projectKey}</strong>.
          </p>
        )}

        <div className="actions">
          <button
            type="button"
            className="button button--primary"
            disabled={projectKey.trim() === '' || upsert.isPending}
            onClick={submit}
          >
            {upsert.isPending ? 'Saving…' : 'Save project'}
          </button>
          <button type="button" className="button" onClick={reset} disabled={upsert.isPending}>
            Clear
          </button>
        </div>
      </section>

      <section className="panel" aria-labelledby="projects-title">
        <h2 className="panel__title" id="projects-title">
          Projects
        </h2>

        {remove.isError && <ErrorState error={remove.error} title="Could not remove this project" />}

        {projects.length === 0 ? (
          <EmptyState title="No projects yet" description="Add a project above so PMs can be assigned to it." />
        ) : (
          <ul className="rows" aria-label="Projects">
            {projects.map((p) => {
              const inUse = p.pmCount > 0;
              return (
                <li className="row" key={p.projectKey}>
                  <code>{p.projectKey}</code>
                  {p.displayName !== null && <span>{p.displayName}</span>}
                  <Badge tone={inUse ? 'info' : 'neutral'}>
                    {p.pmCount} PM{p.pmCount === 1 ? '' : 's'}
                  </Badge>

                  <span className="row__spacer" />

                  {confirming === p.projectKey ? (
                    <span className="confirm confirm--inline" role="alertdialog" aria-label="Confirm removing this project">
                      Remove <strong>{p.projectKey}</strong> from the list?
                      <button type="button" className="button" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(p.projectKey, { onSuccess: () => setConfirming(null) })}
                      >
                        Remove anyway
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="button button--danger"
                      disabled={inUse}
                      title={inUse ? `Assigned to ${p.pmCount} PM(s). Remove it from them first.` : undefined}
                      onClick={() => setConfirming(p.projectKey)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
