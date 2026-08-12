import { Link, Navigate } from 'react-router-dom';
import { useMe } from '../../api/use-me.js';
import {
  DEFAULT_PROJECT_SUB,
} from '../../layout/nav-items.js';
import {
  projectPath,
  readLastProject,
  writeLastProject,
} from '../../project/project-context.js';
import { EmptyState, ErrorState, LoadingState, Badge } from '../../components/ui/index.js';

/**
 * Trang chủ `/` — cửa vào multi-tenant.
 *
 * Thứ tự quyết định:
 *   1. Còn nhớ dự án dùng lần trước (localStorage `ptb.lastProject`) VÀ vẫn còn
 *      quyền → chuyển thẳng vào đó, người dùng một dự án không bao giờ thấy
 *      trang này.
 *   2. Không nhớ / hết quyền → hiện danh sách dự án để chọn.
 *   3. Không có dự án nào → nói rõ phải xin quyền, không hiện trang trắng.
 */
export function ProjectPickerScreen() {
  const me = useMe();

  if (me.isPending) return <LoadingState label="Đang tải danh sách dự án…" rows={3} />;
  if (me.isError) {
    return (
      <ErrorState
        error={me.error}
        title="Không tải được danh sách dự án"
        onRetry={() => void me.refetch()}
      />
    );
  }
  if (me.data === null || me.data === undefined) {
    return (
      <EmptyState
        icon="🔒"
        title="Chưa đăng nhập"
        description="Phiên đăng nhập đã hết hạn. Tải lại trang để đăng nhập lại."
      />
    );
  }

  const projects = me.data.projects;

  if (projects.length === 0) {
    return (
      <EmptyState
        icon="🗄️"
        title="Chưa có dự án nào"
        description="Bạn chưa được cấp quyền vào dự án nào — liên hệ quản trị viên."
      />
    );
  }

  // Dự án dùng lần trước còn truy cập được thì vào thẳng, khỏi bắt chọn lại.
  const last = readLastProject();
  if (last !== null && projects.some((p) => p.projectKey === last)) {
    return <Navigate to={projectPath(last, DEFAULT_PROJECT_SUB)} replace />;
  }

  // Chỉ có đúng một dự án thì cũng vào thẳng — không có gì để "chọn".
  // (`ProjectProvider` sẽ tự ghi `ptb.lastProject` khi vào tới nơi.)
  if (projects.length === 1) {
    return <Navigate to={projectPath(projects[0]!.projectKey, DEFAULT_PROJECT_SUB)} replace />;
  }

  return (
    <section className="panel" aria-labelledby="project-picker-title">
      <h2 className="panel__title" id="project-picker-title">
        <span aria-hidden="true">🗄️</span> Chọn dự án
      </h2>
      <p className="panel__hint">
        Chọn dự án muốn mở. Có thể đổi dự án bất cứ lúc nào bằng ô chọn ở thanh bên.
      </p>

      <ul className="epic-picker" aria-label="Dự án truy cập được">
        {projects.map((p) => (
          <li key={p.projectKey}>
            {/* Link (không phải button) để mở tab mới / copy link được. */}
            <Link
              className="epic-picker__item"
              to={projectPath(p.projectKey, DEFAULT_PROJECT_SUB)}
              onClick={() => writeLastProject(p.projectKey)}
            >
              <code className="epic-picker__key">{p.projectKey}</code>
              <span className="epic-picker__name">{p.displayName ?? p.projectKey}</span>
              <span className="epic-picker__meta">
                <Badge tone={p.role === 'PM' ? 'success' : 'neutral'}>{p.role}</Badge>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
