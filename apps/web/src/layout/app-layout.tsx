import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { NAV_GROUPS, NAV_ITEMS } from './nav-items.js';
import { useMe } from '../api/use-me.js';
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
 * Mọi màn hình đều nằm trong khung này qua `<Outlet />`.
 */
export function AppLayout() {
  const location = useLocation();
  const current = NAV_ITEMS.find((item) => location.pathname.startsWith(item.path));
  const me = useMe();
  const isAdmin = me.data?.role === 'ADMIN';
  // Mục adminOnly chỉ hiện với ADMIN. Vẫn giữ NAV_ITEMS đầy đủ cho `current` ở
  // trên để tiêu đề thanh trên đúng ngay cả khi mở thẳng URL /admin/users.
  const visibleNav = NAV_ITEMS.filter((item) => item.adminOnly !== true || isAdmin);

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

        {/* Hai nhóm có tiêu đề đánh số — đúng bố cục demo đã chốt. */}
        <nav aria-label="Main navigation">
          {NAV_GROUPS.map((group, gi) => (
            <div className="nav__group" key={group.id}>
              <div className="nav__group-title">
                <span className="nav__group-num" aria-hidden="true">
                  {gi + 1}
                </span>
                {group.title}
              </div>
              <ul className="nav">
                {visibleNav
                  .filter((item) => item.group === group.id)
                  .map((item) => (
                    <li key={item.path}>
                      <NavLink
                        to={item.path}
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
            </div>
          ))}
        </nav>
      </aside>

      <div className="content">
        <header className="topbar">
          <div className="topbar__headings">
            <h1 className="topbar__title">{current?.label ?? 'Burndown Engine'}</h1>
            {current !== undefined && <p className="topbar__summary">{current.summary}</p>}
          </div>
          {me.data != null && (
            <div className="topbar__user">
              <span className="topbar__user-id" title={me.data.userId}>
                {me.data.userId}
              </span>
              <Badge tone={ROLE_TONE[me.data.role] ?? 'neutral'}>{me.data.role}</Badge>
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
