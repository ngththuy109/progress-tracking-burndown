/**
 * Các màn hình của app, khai ở MỘT chỗ.
 *
 * Thanh bên và bộ định tuyến cùng đọc danh sách này. Tách làm hai nơi thì thêm
 * màn hình mới sẽ có lúc quên một bên — mục hiện trên thanh bên nhưng bấm vào
 * ra trang trắng.
 *
 * Multi-tenant: mục nghiệp vụ mang ĐƯỜNG DẪN CON (`sub`) dưới `/p/:projectKey/`;
 * mục quản trị mang đường dẫn tuyệt đối `/admin/...` — chúng không thuộc dự án
 * nào.
 */
export interface NavItem {
  /**
   * Đường dẫn CON trong một dự án (ví dụ `epics`, `config/phase`) — thanh bên
   * ghép thành `/p/:projectKey/<sub>`. Mục quản trị dùng `adminPath` thay thế.
   */
  readonly sub: string;
  readonly label: string;
  /** Biểu tượng dạng chữ, tránh phải kéo thêm bộ icon cho một khung trống. */
  readonly icon: string;
  readonly summary: string;
  /** Card nào sẽ dựng màn hình thật. Hiện thẳng lên trang tạm. */
  readonly builtBy: string;
  /** Chỉ hiện trên thanh bên khi người dùng là ADMIN (API vẫn tự chặn). */
  readonly adminOnly?: boolean;
  /** Ẩn với VIEWER của dự án đang mở — màn hình chỉ PM thao tác được. */
  readonly pmOnly?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    sub: 'epics',
    label: 'Epics',
    icon: '📋',
    summary: 'Add or remove Epics and check how each one is syncing.',
    builtBy: 'GĐ 4',
  },
  {
    sub: 'burndown',
    label: 'Burndown chart',
    icon: '📉',
    summary: 'Three views: whole Epic, a single Phase, or several Phases side by side.',
    builtBy: 'GĐ 4',
  },
  {
    sub: 'signboard',
    label: 'Signboard',
    icon: '🗂️',
    summary: 'Function × task type grid. Each cell shows one progress status.',
    builtBy: 'GĐ 4',
  },
  {
    sub: 'phase-subtasks',
    label: 'Phase sub-tasks',
    icon: '🧾',
    summary: 'List the sub-tasks under each defined Phase for one Epic.',
    builtBy: 'Phase tickets',
  },
  {
    sub: 'config/signboard',
    label: 'Signboard columns',
    icon: '🧩',
    summary: 'Define which task types become columns on the Signboard.',
    builtBy: 'T-32',
    pmOnly: true,
  },
  {
    sub: 'config/holidays',
    label: 'Days off',
    icon: '📅',
    summary: 'Public holidays and make-up workdays for the calendars this project uses.',
    builtBy: 'T-36',
  },
  {
    sub: 'config/phase',
    label: 'Phase settings',
    icon: '⚙️',
    summary: 'Edit title patterns and Phase matching rules. Preview before saving.',
    builtBy: 'T-21',
    pmOnly: true,
  },
  {
    sub: 'ops',
    label: 'Monitoring',
    icon: '🩺',
    summary: 'Sync jobs, Jira rate limits, data quality, and plan drift for this project.',
    builtBy: 'T-33',
    pmOnly: true,
  },
];

/** Khu quản trị — nằm NGOÀI phạm vi dự án, chỉ ADMIN thấy. */
export interface AdminNavItem {
  readonly path: string;
  readonly label: string;
  readonly icon: string;
  readonly summary: string;
}

export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  {
    path: '/admin/projects',
    label: 'Projects',
    icon: '🗄️',
    summary: 'Register tenants: general info, Jira connection, and members per project.',
  },
  {
    path: '/admin/users',
    label: 'Users',
    icon: '👤',
    summary: 'Grant global Admin/Member access. Per-project roles live on the Projects screen.',
  },
  {
    path: '/admin/ldap',
    label: 'LDAP',
    icon: '🔐',
    summary: 'Cấu hình đăng nhập LDAP trong app: máy chủ, cách xác định user, test kết nối.',
  },
];

/** Trang con mặc định khi mở một dự án (`/p/:key` → `/p/:key/epics`). */
export const DEFAULT_PROJECT_SUB = 'epics';

export function navItem(sub: string): NavItem {
  const found = NAV_ITEMS.find((item) => item.sub === sub);
  // Ném lỗi thay vì trả về một mục giả: sai đường dẫn là lỗi lập trình, và một
  // mục giả sẽ hiện ra như thể mọi thứ bình thường.
  if (found === undefined) throw new Error(`No navigation item matches "${sub}".`);
  return found;
}
