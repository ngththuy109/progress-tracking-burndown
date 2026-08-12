import type { FastifyRequest } from 'fastify';
import type { GlobalRole, Principal, ProjectRole } from '@app/shared';

/**
 * Xác định người gọi từ DANH TÍNH do cổng SSO xác thực — mô hình B1.
 *
 * Kiến trúc: một auth proxy (oauth2-proxy / IAP / ALB…) đứng TRƯỚC API. Nó đăng
 * nhập người dùng qua SSO (OIDC), rồi đặt header danh tính `x-user-id` = email
 * đã xác thực, và XOÁ mọi header `x-user-*` mà client tự gửi (xem
 * config/auth-proxy/). API chỉ được nhận request qua cổng này, không bao giờ
 * trực tiếp từ Internet.
 *
 * API **không đọc `role` từ header**. Nó chỉ tin DANH TÍNH, rồi tra quyền ở
 * bảng `app_user` + `project_member`. Nhờ vậy dù cổng có lỡ để lọt một header
 * `x-user-role: ADMIN` giả từ client thì cũng vô hại.
 *
 * BỔ SUNG (đăng nhập LDAP in-app): khi admin bật LDAP, danh tính đến từ PHIÊN
 * (cookie `ptb_sess`, xem `createAuthResolver` cuối file) và header BỊ BỎ QUA;
 * khi LDAP tắt (hoặc AUTH_FORCE_HEADER=1) mọi thứ y như cũ. Quyền vẫn tra
 * `app_user` bất kể danh tính đến từ nguồn nào.
 *
 * THAY ĐỔI PHÁ VỠ (multi-tenant, Phase B): `Principal` không còn
 * `role: ADMIN|PM|VIEWER` toàn cục nữa mà là hai tầng —
 * `isAdmin` (toàn cục) + `memberships` (projectKey → PM|VIEWER).
 *
 *   - `AUTH_DEFAULT_ROLE=ADMIN` vẫn nghĩa là "ai đăng nhập được đều là admin"
 *     (chỉ dành cho môi trường dev).
 *   - Các giá trị cũ `VIEWER`/`PM` (và giá trị mới `MEMBER`) giờ đều cho ra
 *     MEMBER-không-membership: đăng nhập được nhưng KHÔNG NHÌN THẤY dự án nào
 *     cho tới khi được thêm vào `project_member`. Trước đây `VIEWER` xem được
 *     tất cả — hành vi đó đã bỏ có chủ đích: tenant nào chỉ thấy tenant đó.
 *   - `NONE` vẫn là từ chối hẳn (không có principal).
 */

/** Cổng đọc quyền từ nguồn sự thật (`app_user` + `project_member`). */
export interface AppUserStore {
  find(userId: string): Promise<{
    role: GlobalRole;
    memberships: Readonly<Record<string, ProjectRole>>;
  } | null>;
}

/** Quyền mặc định cho người đã đăng nhập nhưng CHƯA có trong `app_user`. */
export type DefaultGrant = 'ADMIN' | 'MEMBER';

export interface AuthConfig {
  /** Tên header danh tính do cổng đặt. Khác nhau theo proxy nên cấu hình được. */
  readonly identityHeader: string;
  /** Email luôn được coi là ADMIN — dùng để mồi admin đầu tiên (chống deadlock). */
  readonly bootstrapAdmins: ReadonlySet<string>;
  /**
   * Quyền cho người đã đăng nhập nhưng CHƯA được cấp trong `app_user`.
   * `MEMBER` = vào được nhưng chưa thấy dự án nào (mặc định an toàn).
   * `null` = chưa cấp quyền thì coi như không có principal (chặn hẳn).
   */
  readonly defaultGrant: DefaultGrant | null;
}

/** Email không phân biệt hoa thường; chuẩn hoá để tra cứu và so khớp bootstrap. */
export function normalizeIdentity(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * DANH TÍNH đã xác thực → Principal: một đường chung cho cả hai nguồn danh
 * tính (header từ cổng SSO, và phiên đăng nhập LDAP). Quyền LUÔN tra
 * `app_user` + `project_member` — nguồn danh tính không quyết định quyền.
 */
async function principalOf(
  store: AppUserStore,
  config: AuthConfig,
  userId: string | null,
): Promise<Principal | null> {
  if (userId === null) return null;

  // Admin mồi: cấp qua env, xác định trước cả database — để lần đầu triển khai
  // vẫn có người thêm được người khác vào `app_user`.
  if (config.bootstrapAdmins.has(userId)) {
    return { userId, isAdmin: true, memberships: {} };
  }

  const found = await store.find(userId);
  if (found !== null) {
    return {
      userId,
      isAdmin: found.role === 'ADMIN',
      memberships: { ...found.memberships },
    };
  }

  // Đã xác thực nhưng chưa được cấp quyền: mặc định là MEMBER trắng tay
  // (không thấy dự án nào) hoặc từ chối, tuỳ cấu hình. KHÔNG bao giờ tự nâng
  // lên membership/ADMIN.
  if (config.defaultGrant === 'ADMIN') return { userId, isAdmin: true, memberships: {} };
  if (config.defaultGrant === 'MEMBER') return { userId, isAdmin: false, memberships: {} };
  return null;
}

/**
 * Dựng hàm phân giải principal TỪ HEADER. Trả một hàm BẤT ĐỒNG BỘ vì phải tra
 * database; `server.ts` gọi nó một lần mỗi request trong hook `onRequest` rồi
 * gắn kết quả vào `req`, để tầng route vẫn đọc principal đồng bộ như cũ.
 */
export function createPrincipalResolver(
  store: AppUserStore,
  config: AuthConfig,
): (req: FastifyRequest) => Promise<Principal | null> {
  const headerName = config.identityHeader.toLowerCase();

  return async (req: FastifyRequest): Promise<Principal | null> => {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    return principalOf(store, config, normalizeIdentity(firstHeader(headers[headerName])));
  };
}

/**
 * Nguồn danh tính cho resolver KẾT HỢP (đăng nhập LDAP in-app + header cũ).
 * Các hàm được tiêm từ điểm lắp ráp để tầng này test được không cần Redis/DB.
 */
export interface AuthResolverSources {
  /** userId của phiên `ptb_sess` hợp lệ trong request, `null` nếu không có. */
  sessionUserId(req: FastifyRequest): Promise<string | null>;
  /** LDAP có đang BẬT trong config không (đọc qua loader có cache ~10s). */
  ldapEnabled(): Promise<boolean>;
  /** env AUTH_FORCE_HEADER=1 — van thoát hiểm: ép chế độ header dù LDAP bật. */
  readonly forceHeader: boolean;
}

/**
 * Resolver KẾT HỢP — thứ tự cho MỖI request:
 *
 *   1. Cookie `ptb_sess` hợp lệ → danh tính của phiên LDAP. Phiên thắng header
 *      vô điều kiện: nó là bằng chứng xác thực mạnh hơn một header có thể do
 *      proxy đặt.
 *   2. Không có phiên, và LDAP KHÔNG hiệu lực (tắt trong config hoặc bị
 *      AUTH_FORCE_HEADER=1 ép) → đường header cũ, NGUYÊN VẸN — luồng dev
 *      VITE_DEV_USER và mô hình cổng SSO phụ thuộc vào nó.
 *   3. LDAP đang hiệu lực mà không có phiên → KHÔNG tin header (client tự gắn
 *      `x-user-id` khi API lộ trực tiếp ra ngoài là giả được danh tính) → null.
 */
export function createAuthResolver(
  store: AppUserStore,
  config: AuthConfig,
  sources: AuthResolverSources,
): (req: FastifyRequest) => Promise<Principal | null> {
  const fromHeader = createPrincipalResolver(store, config);

  return async (req: FastifyRequest): Promise<Principal | null> => {
    const sessionUserId = await sources.sessionUserId(req);
    if (sessionUserId !== null) {
      return principalOf(store, config, normalizeIdentity(sessionUserId));
    }
    if (sources.forceHeader || !(await sources.ldapEnabled())) {
      return fromHeader(req);
    }
    return null;
  };
}

/**
 * Giá trị hợp lệ của AUTH_DEFAULT_ROLE. `VIEWER`/`PM` là giá trị CŨ (trước
 * multi-tenant) — vẫn chấp nhận để deploy cũ không chết lúc boot, nhưng giờ
 * chúng chỉ còn nghĩa "MEMBER chưa có dự án" (xem chú thích đầu file).
 */
const VALID_DEFAULT_ROLES: ReadonlySet<string> = new Set([
  'ADMIN',
  'MEMBER',
  'PM',
  'VIEWER',
  'NONE',
]);

/**
 * Đọc cấu hình auth từ biến môi trường (gọi ở điểm lắp ráp `main.ts`).
 *
 *   AUTH_IDENTITY_HEADER   tên header danh tính (mặc định `x-user-id`)
 *   AUTH_BOOTSTRAP_ADMINS  danh sách email admin mồi, phân tách bởi dấu phẩy
 *   AUTH_DEFAULT_ROLE      MEMBER (mặc định) | ADMIN | NONE
 *                          (VIEWER/PM cũ được hiểu như MEMBER)
 */
export function authConfigFromEnv(env: NodeJS.ProcessEnv): AuthConfig {
  const identityHeader = env['AUTH_IDENTITY_HEADER']?.trim() || 'x-user-id';

  const bootstrapAdmins = new Set(
    (env['AUTH_BOOTSTRAP_ADMINS'] ?? '')
      .split(',')
      .map((s) => normalizeIdentity(s))
      .filter((s): s is string => s !== null),
  );

  const rawRole = env['AUTH_DEFAULT_ROLE']?.trim().toUpperCase() || 'MEMBER';
  if (!VALID_DEFAULT_ROLES.has(rawRole)) {
    throw new Error(
      `AUTH_DEFAULT_ROLE="${rawRole}" không hợp lệ. Giá trị cho phép: ADMIN, MEMBER, NONE ` +
        '(VIEWER/PM là giá trị cũ, được hiểu như MEMBER).',
    );
  }

  const defaultGrant: DefaultGrant | null =
    rawRole === 'NONE' ? null : rawRole === 'ADMIN' ? 'ADMIN' : 'MEMBER';

  return { identityHeader, bootstrapAdmins, defaultGrant };
}
