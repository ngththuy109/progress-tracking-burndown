import { useState } from 'react';
import { Link } from 'react-router-dom';
import { GLOBAL_ROLE, type AppUserView, type GlobalRole, type UpsertUserRequest } from '@app/shared';
import { useMe } from '../../api/use-me.js';
import { useDeleteUser, useUpsertUser, useUsers } from '../../api/use-users.js';
import { Badge, EmptyState, ErrorState, LoadingState, type BadgeTone } from '../../components/ui/index.js';

/**
 * Màn hình quản lý người dùng — chỉ ADMIN.
 *
 * Mô hình multi-tenant: user chỉ còn role TOÀN CỤC — ADMIN (quản trị, thấy mọi
 * dự án) hoặc MEMBER (chỉ thấy dự án mình là thành viên). Việc gán PM/VIEWER
 * cho TỪNG dự án nằm ở màn Projects → mục Thành viên, KHÔNG còn ở đây.
 * API mới là hàng rào thật (403 với người không phải Admin); chặn ở đây chỉ để
 * đỡ hiển thị một màn hình chắc chắn bị từ chối.
 */

const ROLE_TONE: Record<string, BadgeTone> = {
  ADMIN: 'info',
  MEMBER: 'neutral',
};

export function AdminUsersScreen() {
  const me = useMe();

  if (me.isPending) return <LoadingState label="Đang tải…" rows={2} />;
  if (me.data && !me.data.isAdmin) {
    return (
      <EmptyState
        icon="🔒"
        title="Chỉ dành cho quản trị viên"
        description="Chỉ ADMIN quản lý được người dùng. Liên hệ quản trị viên nếu bạn cần quyền."
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
  const [role, setRole] = useState<GlobalRole>('MEMBER');
  const [displayName, setDisplayName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  const resetForm = (): void => {
    setUserId('');
    setRole('MEMBER');
    setDisplayName('');
  };

  const editUser = (u: AppUserView): void => {
    setUserId(u.userId);
    setRole(u.role);
    setDisplayName(u.displayName ?? '');
  };

  const submit = (): void => {
    const body: UpsertUserRequest = {
      userId: userId.trim(),
      role,
      displayName: displayName.trim() === '' ? null : displayName.trim(),
    };
    upsert.mutate(body, { onSuccess: resetForm });
  };

  if (query.isPending) return <LoadingState label="Đang tải danh sách người dùng…" rows={4} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        title="Không tải được danh sách người dùng"
        onRetry={() => void query.refetch()}
      />
    );
  }

  const users = query.data;

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="add-user-title">
        <h2 className="panel__title" id="add-user-title">
          Thêm hoặc cập nhật người dùng
        </h2>
        <p className="panel__hint">
          Nhập đúng email công việc như SSO trả về. Lưu một email đã tồn tại sẽ cập nhật role của
          người đó. <strong>ADMIN</strong> thấy và quản mọi dự án; <strong>MEMBER</strong> chỉ thấy
          dự án mình là thành viên — gán vào từng dự án ở màn{' '}
          <Link to="/admin/projects">Projects</Link>, mục Thành viên.
        </p>

        <label className="field">
          <span>Email công việc</span>
          <input
            className="input input--wide"
            value={userId}
            placeholder="pm@your-company.com"
            aria-label="Email công việc"
            onChange={(e) => setUserId(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Role toàn cục</span>
          <select
            className="input"
            value={role}
            aria-label="Role toàn cục"
            onChange={(e) => setRole(e.target.value as GlobalRole)}
          >
            {GLOBAL_ROLE.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Tên hiển thị (không bắt buộc)</span>
          <input
            className="input"
            value={displayName}
            aria-label="Tên hiển thị"
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>

        {upsert.isError && <ErrorState error={upsert.error} title="Không lưu được người dùng này" />}
        {upsert.isSuccess && (
          <p className="notice notice--ok" role="status">
            Đã lưu <strong>{upsert.data.userId}</strong> với role {upsert.data.role}.
          </p>
        )}

        <div className="actions">
          <button
            type="button"
            className="button button--primary"
            disabled={userId.trim() === '' || upsert.isPending}
            onClick={submit}
          >
            {upsert.isPending ? 'Đang lưu…' : 'Lưu người dùng'}
          </button>
          <button type="button" className="button" onClick={resetForm} disabled={upsert.isPending}>
            Xoá form
          </button>
        </div>
      </section>

      <section className="panel" aria-labelledby="users-title">
        <h2 className="panel__title" id="users-title">
          Người dùng
        </h2>

        {remove.isError && <ErrorState error={remove.error} title="Không gỡ được người dùng này" />}

        {users.length === 0 ? (
          <EmptyState
            title="Chưa cấp quyền cho ai"
            description="Thêm một người dùng ở khung trên để cấp quyền truy cập."
          />
        ) : (
          <ul className="rows" aria-label="Người dùng">
            {users.map((u) => {
              const isSelf = u.userId === currentUserId;
              const readOnly = u.source === 'ENV';
              const locked = readOnly || isSelf;
              return (
                <li className="row" key={u.userId}>
                  <code>{u.userId}</code>
                  <Badge tone={ROLE_TONE[u.role] ?? 'neutral'}>{u.role}</Badge>
                  {/* Số dự án đang là thành viên — chỉnh ở màn Projects. */}
                  <span className="muted">
                    {u.membershipCount === 0
                      ? 'chưa thuộc dự án nào'
                      : `thành viên ${u.membershipCount} dự án`}
                  </span>
                  {u.displayName !== null && <span>{u.displayName}</span>}
                  {readOnly && <Badge tone="muted">env · chỉ đọc</Badge>}
                  {isSelf && !readOnly && <Badge tone="muted">bạn</Badge>}

                  <span className="row__spacer" />

                  {confirming === u.userId ? (
                    <span
                      className="confirm confirm--inline"
                      role="alertdialog"
                      aria-label="Xác nhận gỡ người dùng này"
                    >
                      Gỡ <strong>{u.userId}</strong>? Họ mất quyền truy cập ngay từ request kế tiếp.
                      <button type="button" className="button" onClick={() => setConfirming(null)}>
                        Huỷ
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(u.userId, { onSuccess: () => setConfirming(null) })}
                      >
                        Gỡ luôn
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
                            ? 'Cấp qua AUTH_BOOTSTRAP_ADMINS — đổi ở biến môi trường, không đổi ở đây.'
                            : isSelf
                              ? 'Không tự đổi role của chính mình được. Nhờ một Admin khác.'
                              : undefined
                        }
                        onClick={() => editUser(u)}
                      >
                        Sửa
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        disabled={locked}
                        title={
                          readOnly
                            ? 'Cấp qua AUTH_BOOTSTRAP_ADMINS — đổi ở biến môi trường, không đổi ở đây.'
                            : isSelf
                              ? 'Không tự gỡ chính mình được. Nhờ một Admin khác.'
                              : undefined
                        }
                        onClick={() => setConfirming(u.userId)}
                      >
                        Gỡ
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
