/**
 * Bốn màn hình của app, khai ở MỘT chỗ.
 *
 * Thanh bên và bộ định tuyến cùng đọc danh sách này. Tách làm hai nơi thì thêm
 * màn hình mới sẽ có lúc quên một bên — mục hiện trên thanh bên nhưng bấm vào
 * ra trang trắng.
 */
/** Hai nhóm điều hướng — đúng bố cục demo đã chốt (dynamic-tiers-demo.html). */
export const NAV_GROUPS = [
  { id: 'TRACK', title: 'Theo dõi tiến độ' },
  { id: 'CONFIG', title: 'Cấu hình dự án' },
] as const;
export type NavGroupId = (typeof NAV_GROUPS)[number]['id'];

export interface NavItem {
  readonly path: string;
  readonly label: string;
  /** Biểu tượng dạng chữ, tránh phải kéo thêm bộ icon cho một khung trống. */
  readonly icon: string;
  readonly summary: string;
  /** Card nào sẽ dựng màn hình thật. Hiện thẳng lên trang tạm. */
  readonly builtBy: string;
  /** Nhóm trên thanh bên (demo đã chốt: ① Theo dõi tiến độ · ② Cấu hình dự án). */
  readonly group: NavGroupId;
  /** Chỉ hiện trên thanh bên khi người dùng là ADMIN (API vẫn tự chặn). */
  readonly adminOnly?: boolean;
}

// Thứ tự TRONG mảng = thứ tự trên thanh bên, theo demo đã chốt:
//   ① Epics → Burndown → Signboard → (Phase sub-tasks) → Monitoring
//   ② Cấu trúc tầng → Phase settings → Signboard columns → Days off → (Projects) → Users
// `Phase sub-tasks` và `Projects` không có trong demo (demo giản lược) — xếp vào
// nhóm cùng bản chất: xem tiến độ / cấu hình-quản trị.
export const NAV_ITEMS: readonly NavItem[] = [
  {
    path: '/epics',
    label: 'Epics',
    icon: '📋',
    summary: 'Add or remove Epics and check how each one is syncing.',
    builtBy: 'GĐ 4',
    group: 'TRACK',
  },
  {
    path: '/burndown',
    label: 'Burndown chart',
    icon: '📉',
    summary: 'Three views: whole Epic, a single Phase, or several Phases side by side.',
    builtBy: 'GĐ 4',
    group: 'TRACK',
  },
  {
    path: '/signboard',
    label: 'Signboard',
    icon: '🗂️',
    summary: 'Function × task type grid. Each cell shows one progress status.',
    builtBy: 'GĐ 4',
    group: 'TRACK',
  },
  {
    path: '/phase-subtasks',
    label: 'Phase sub-tasks',
    icon: '🧾',
    summary: 'List the sub-tasks under each defined Phase for one Epic.',
    builtBy: 'Phase tickets',
    group: 'TRACK',
  },
  {
    path: '/ops',
    label: 'Monitoring',
    icon: '🩺',
    summary: 'Nightly jobs, Jira rate limits, data quality, and plan drift.',
    builtBy: 'T-33',
    group: 'TRACK',
  },
  {
    path: '/config/tiers',
    label: 'Cấu trúc tầng',
    icon: '🏗️',
    summary: 'Khai 1..N tầng nhóm logic cho dự án; đánh dấu đúng một tầng là Phase.',
    builtBy: 'Dynamic tiers',
    group: 'CONFIG',
  },
  {
    path: '/config/phase',
    label: 'Phase settings',
    icon: '⚙️',
    summary: 'Edit title patterns and Phase matching rules. Preview before saving.',
    builtBy: 'T-21',
    group: 'CONFIG',
  },
  {
    path: '/config/signboard',
    label: 'Signboard columns',
    icon: '🧩',
    summary: 'Define which task types become columns on the Signboard.',
    builtBy: 'T-32',
    group: 'CONFIG',
  },
  {
    path: '/config/holidays',
    label: 'Days off',
    icon: '📅',
    summary: 'Public holidays and make-up workdays for the Vietnam and Japan calendars.',
    builtBy: 'T-36',
    group: 'CONFIG',
  },
  {
    path: '/admin/projects',
    label: 'Projects',
    icon: '🗄️',
    summary: 'Register the project keys PMs can be assigned to.',
    builtBy: 'SSO',
    group: 'CONFIG',
    adminOnly: true,
  },
  {
    path: '/admin/users',
    label: 'Users',
    icon: '👤',
    summary: 'Grant Admin, PM, or Viewer access and scope PMs to their projects.',
    builtBy: 'SSO',
    group: 'CONFIG',
    adminOnly: true,
  },
];

/** Vào `/` thì chuyển tới đây. */
export const DEFAULT_PATH = '/epics';

export function navItem(path: string): NavItem {
  const found = NAV_ITEMS.find((item) => item.path === path);
  // Ném lỗi thay vì trả về một mục giả: sai đường dẫn là lỗi lập trình, và một
  // mục giả sẽ hiện ra như thể mọi thứ bình thường.
  if (found === undefined) throw new Error(`No navigation item matches "${path}".`);
  return found;
}
