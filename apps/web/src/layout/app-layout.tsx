import { NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { ADMIN_NAV_ITEMS, DEFAULT_PROJECT_SUB, NAV_ITEMS } from './nav-items.js';
import { useAuthMode, useLogout } from '../api/use-auth-mode.js';
import { useMe } from '../api/use-me.js';
import { projectPath, writeLastProject } from '../project/project-context.js';
import { Badge, type BadgeTone } from '../components/ui/index.js';

/** Màu chip theo vai trò — chỉ để dễ nhìn, không mang ý nghĩa quyền hạn. */
const ROLE_TONE: Record<string, BadgeTone> = {
  ADMIN: 'info',
  PM: 'success',
  VIEWER: 'neutral',
};

/**
 * Khung chung: thanh bên điều hướng, thanh trên, vùng nội dung.
 *
 * Mọi màn hình đều nằm trong khung này qua `<Outlet />`. Khung đọc dự án đang
 * mở TỪ URL (`/p/:projectKey/...`) chứ không từ `ProjectProvider` — provider
 * nằm BÊN TRONG outlet (nó còn kiểm quyền và chuyển hướng), còn khung phải vẽ
 * được cả khi đang ở trang chọn dự án hay khu quản trị (không có dự án nào).
 */
export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  // `/p/:projectKey/*` — lấy key + đường dẫn con hiện tại cho project switcher.
  const match = useMatch('/p/:projectKey/*');
  const projectKey = match?.params['projectKey'] ?? null;
  const currentSub = match?.params['*'] ?? '';

  const me = useMe();
  const authMode = useAuthMode();
  const logout = useLogout();
  const isAdmin = me.data?.isAdmin === true;
  const projects = me.data?.projects ?? [];
  const membership = projects.find((p) => p.projectKey === projectKey);

  // Tiêu đề thanh trên: mục nghiệp vụ theo đường dẫn con, mục quản trị theo path.
  const currentNav =
    projectKey !== null
      ? NAV_ITEMS.find((item) => currentSub.startsWith(item.sub))
      : ADMIN_NAV_ITEMS.find((item) => location.pathname.startsWith(item.path));

  // Mục pmOnly ẩn với VIEWER của dự án đang mở; adminOnly chỉ hiện với ADMIN.
  const role = membership?.role ?? null;
  const visibleNav = NAV_ITEMS.filter(
    (item) =>
      (item.adminOnly !== true || isAdmin) && (item.pmOnly !== true || role !== 'VIEWER'),
  );

  /**
   * Đổi dự án: giữ NGUYÊN trang đang xem ở dự án mới (mọi trang nghiệp vụ đều
   * có nghĩa ở dự án khác), nhưng BỎ query string — `?epic=PAY-1` của dự án cũ
   * không tồn tại bên kia, giữ lại chỉ tạo màn hình lỗi.
   */
  const switchProject = (nextKey: string): void => {
    writeLastProject(nextKey);
    const sub = currentSub === '' ? DEFAULT_PROJECT_SUB : currentSub;
    void navigate(projectPath(nextKey, sub));
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__brand-mark" aria-hidden="true">
            📊
          </span>
          <span className="sidebar__brand-text">Burndown Engine</span>
        </div>

        {/* Bộ chuyển dự án — nguồn dữ liệu là /api/me. Hiện displayName, thiếu
            thì hiện key trần. */}
        {projects.length > 0 && (
          <label className="field sidebar__project">
            <span>Dự án</span>
            <select
              className="input"
              aria-label="Dự án đang mở"
              value={projectKey ?? ''}
              onChange={(e) => {
                if (e.target.value !== '') switchProject(e.target.value);
              }}
            >
              {/* Đang ở trang không thuộc dự án nào (chọn dự án / quản trị). */}
              {projectKey === null && <option value="">— chọn dự án —</option>}
              {projects.map((p) => (
                <option key={p.projectKey} value={p.projectKey}>
                  {p.displayName ?? p.projectKey}
                </option>
              ))}
            </select>
          </label>
        )}

        {projectKey !== null && (
          <nav aria-label="Main navigation">
            <ul className="nav">
              {visibleNav.map((item) => (
                <li key={item.sub}>
                  <NavLink
                    to={projectPath(projectKey, item.sub)}
                    className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
                    // `aria-current` là cách trình đọc màn hình biết đang ở mục
                    // nào. Tô đậm bằng CSS chỉ người nhìn thấy mới biết.
                    end={false}
                  >
                    <span className="nav__icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {isAdmin && (
          <nav aria-label="Admin navigation">
            <ul className="nav">
              {ADMIN_NAV_ITEMS.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    className={({ isActive }) => `nav__link${isActive ? ' nav__link--active' : ''}`}
                    end={false}
                  >
                    <span className="nav__icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </aside>

      <div className="content">
        <header className="topbar">
          <div className="topbar__headings">
            <h1 className="topbar__title">{currentNav?.label ?? 'Burndown Engine'}</h1>
            {currentNav !== undefined && <p className="topbar__summary">{currentNav.summary}</p>}
          </div>
          {me.data != null && (
            <div className="topbar__user">
              <span className="topbar__user-id" title={me.data.userId}>
                {me.data.userId}
              </span>
              {/* ADMIN hiện chip ADMIN; người thường hiện role TRONG DỰ ÁN đang
                  mở (PM/VIEWER). Ở ngoài dự án thì không có role nào để hiện. */}
              {me.data.isAdmin ? (
                <Badge tone={ROLE_TONE['ADMIN'] ?? 'neutral'}>ADMIN</Badge>
              ) : (
                role !== null && <Badge tone={ROLE_TONE[role] ?? 'neutral'}>{role}</Badge>
              )}
              {/* CHỈ ở mode LDAP mới có phiên trong app để mà đăng xuất; ở mode
                  HEADER phiên do cổng/proxy giữ, nút này chỉ gây hiểu lầm. */}
              {authMode.data?.mode === 'LDAP' && (
                <button
                  type="button"
                  className="button"
                  disabled={logout.isPending}
                  onClick={() => logout.mutate()}
                >
                  {logout.isPending ? 'Đang đăng xuất…' : 'Đăng xuất'}
                </button>
              )}
            </div>
          )}
        </header>

        <main className="main" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
