import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { NAV_ITEMS } from './nav-items.js';

/**
 * Khung chung: thanh bên điều hướng, thanh trên, vùng nội dung.
 *
 * Mọi màn hình đều nằm trong khung này qua `<Outlet />`.
 */
export function AppLayout() {
  const location = useLocation();
  const current = NAV_ITEMS.find((item) => location.pathname.startsWith(item.path));

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

        <nav aria-label="Main navigation">
          <ul className="nav">
            {NAV_ITEMS.map((item) => (
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
        </nav>
      </aside>

      <div className="content">
        <header className="topbar">
          <h1 className="topbar__title">{current?.label ?? 'Burndown Engine'}</h1>
          {current !== undefined && <p className="topbar__summary">{current.summary}</p>}
        </header>

        <main className="main" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
