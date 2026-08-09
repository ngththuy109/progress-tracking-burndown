import { useState } from 'react';
import { USER_ROLE, type AppUserView, type UpsertUserRequest, type UserRole } from '@app/shared';
import { useMe } from '../../api/use-me.js';
import { useDeleteUser, useUpsertUser, useUsers } from '../../api/use-users.js';
import { Badge, EmptyState, ErrorState, LoadingState, type BadgeTone } from '../../components/ui/index.js';

/**
 * Màn hình quản lý người dùng — chỉ ADMIN.
 *
 * Cho Admin cấp Admin/PM/Viewer ngay trên giao diện thay vì chạy `pnpm
 * auth:grant`. API mới là hàng rào thật (403 với người không phải Admin); chặn ở
 * đây chỉ để đỡ hiển thị một màn hình chắc chắn bị từ chối.
 */

const ROLE_TONE: Record<string, BadgeTone> = {
  ADMIN: 'info',
  PM: 'success',
  VIEWER: 'neutral',
};

export function AdminUsersScreen() {
  const me = useMe();

  if (me.isPending) return <LoadingState label="Loading…" rows={2} />;
  if (me.data && me.data.role !== 'ADMIN') {
    return (
      <EmptyState
        icon="🔒"
        title="Admins only"
        description="Only Admins can manage users. Ask an admin if you need access."
      />
    );
  }
  return <UsersManager currentUserId={me.data?.userId ?? null} />;
}

function UsersManager({ currentUserId }: { readonly currentUserId: string | null }) {
  const query = useUsers();
  const upsert = useUpsertUser();
  const remove = useDeleteUser();

  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<UserRole>('VIEWER');
  const [projects, setProjects] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  const resetForm = (): void => {
    setUserId('');
    setRole('VIEWER');
    setProjects('');
    setDisplayName('');
  };

  const editUser = (u: AppUserView): void => {
    setUserId(u.userId);
    setRole(u.role);
    setProjects(u.projects.join(', '));
    setDisplayName(u.displayName ?? '');
  };

  const submit = (): void => {
    const body: UpsertUserRequest = {
      userId: userId.trim(),
      role,
      projects:
        role === 'PM'
          ? projects.split(',').map((s) => s.trim()).filter((s) => s !== '')
          : [],
      displayName: displayName.trim() === '' ? null : displayName.trim(),
    };
    upsert.mutate(body, { onSuccess: resetForm });
  };

  if (query.isPending) return <LoadingState label="Loading users…" rows={4} />;
  if (query.isError) {
    return <ErrorState error={query.error} title="Could not load users" onRetry={() => void query.refetch()} />;
  }

  const users = query.data;

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="add-user-title">
        <h2 className="panel__title" id="add-user-title">
          Add or update a user
        </h2>
        <p className="panel__hint">
          Enter the person&rsquo;s work email exactly as it comes from SSO. Saving an email that
          already exists updates their role. PMs must list the projects they own; Admins and Viewers
          see everything.
        </p>

        <label className="field">
          <span>Work email</span>
          <input
            className="input input--wide"
            value={userId}
            placeholder="pm@your-company.com"
            aria-label="Work email"
            onChange={(e) => setUserId(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Role</span>
          <select
            className="input"
            value={role}
            aria-label="Role"
            onChange={(e) => setRole(e.target.value as UserRole)}
          >
            {USER_ROLE.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        {role === 'PM' && (
          <label className="field">
            <span>Projects (comma-separated)</span>
            <input
              className="input input--wide"
              value={projects}
              placeholder="PAY, CRM"
              aria-label="Projects"
              onChange={(e) => setProjects(e.target.value)}
            />
          </label>
        )}

        <label className="field">
          <span>Display name (optional)</span>
          <input
            className="input"
            value={displayName}
            aria-label="Display name"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>

        {upsert.isError && <ErrorState error={upsert.error} title="Could not save this user" />}
        {upsert.isSuccess && (
          <p className="notice notice--ok" role="status">
            Saved <strong>{upsert.data.userId}</strong> as {upsert.data.role}.
          </p>
        )}

        <div className="actions">
          <button
            type="button"
            className="button button--primary"
            disabled={userId.trim() === '' || upsert.isPending}
            onClick={submit}
          >
            {upsert.isPending ? 'Saving…' : 'Save user'}
          </button>
          <button type="button" className="button" onClick={resetForm} disabled={upsert.isPending}>
            Clear
          </button>
        </div>
      </section>

      <section className="panel" aria-labelledby="users-title">
        <h2 className="panel__title" id="users-title">
          Users
        </h2>

        {remove.isError && <ErrorState error={remove.error} title="Could not remove this user" />}

        {users.length === 0 ? (
          <EmptyState title="No users granted yet" description="Add a user above to give them access." />
        ) : (
          <ul className="rows" aria-label="Users">
            {users.map((u) => {
              const isSelf = u.userId === currentUserId;
              const readOnly = u.source === 'ENV';
              const locked = readOnly || isSelf;
              return (
                <li className="row" key={u.userId}>
                  <code>{u.userId}</code>
                  <Badge tone={ROLE_TONE[u.role] ?? 'neutral'}>{u.role}</Badge>
                  {u.role === 'PM' && (
                    <span className="muted">{u.projects.length > 0 ? u.projects.join(', ') : 'no projects yet'}</span>
                  )}
                  {u.displayName !== null && <span>{u.displayName}</span>}
                  {readOnly && <Badge tone="muted">env · read-only</Badge>}
                  {isSelf && !readOnly && <Badge tone="muted">you</Badge>}

                  <span className="row__spacer" />

                  {confirming === u.userId ? (
                    <span className="confirm confirm--inline" role="alertdialog" aria-label="Confirm removing this user">
                      Remove <strong>{u.userId}</strong>? They lose access on their next request.
                      <button type="button" className="button" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(u.userId, { onSuccess: () => setConfirming(null) })}
                      >
                        Remove anyway
                      </button>
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="button"
                        disabled={locked}
                        title={
                          readOnly
                            ? 'Granted via AUTH_BOOTSTRAP_ADMINS — change it in the environment.'
                            : isSelf
                              ? 'You cannot change your own role. Ask another Admin.'
                              : undefined
                        }
                        onClick={() => editUser(u)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        disabled={locked}
                        title={
                          readOnly
                            ? 'Granted via AUTH_BOOTSTRAP_ADMINS — change it in the environment.'
                            : isSelf
                              ? 'You cannot remove yourself. Ask another Admin.'
                              : undefined
                        }
                        onClick={() => setConfirming(u.userId)}
                      >
                        Remove
                      </button>
                    </>
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
