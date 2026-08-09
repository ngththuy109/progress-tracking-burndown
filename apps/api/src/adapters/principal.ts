import type { FastifyRequest } from 'fastify';
import type { Principal, UserRole } from '@app/shared';

/**
 * Xác định người gọi từ DANH TÍNH do cổng SSO xác thực — mô hình B1.
 *
 * Kiến trúc: một auth proxy (oauth2-proxy / IAP / ALB…) đứng TRƯỚC API. Nó đăng
 * nhập người dùng qua SSO (OIDC), rồi đặt header danh tính `x-user-id` = email
 * đã xác thực, và XOÁ mọi header `x-user-*` mà client tự gửi (xem
 * config/auth-proxy/). API chỉ được nhận request qua cổng này, không bao giờ
 * trực tiếp từ Internet.
 *
 * KHÁC BẢN CŨ (và cố ý an toàn hơn): API **không đọc `role`/`projects` từ
 * header**. Nó chỉ tin DANH TÍNH, rồi tra vai trò ở bảng `app_user`. Nhờ vậy dù
 * cổng có lỡ để lọt một header `x-user-role: ADMIN` giả từ client thì cũng vô
 * hại — vai trò luôn đến từ database của chính hệ thống.
 */

/** Cổng đọc vai trò từ nguồn sự thật (bảng `app_user`). */
export interface AppUserStore {
  find(userId: string): Promise<{ role: UserRole; projects: readonly string[] } | null>;
}

export interface AuthConfig {
  /** Tên header danh tính do cổng đặt. Khác nhau theo proxy nên cấu hình được. */
  readonly identityHeader: string;
  /** Email luôn được coi là ADMIN — dùng để mồi admin đầu tiên (chống deadlock). */
  readonly bootstrapAdmins: ReadonlySet<string>;
  /**
   * Vai trò cho người đã đăng nhập nhưng CHƯA được cấp quyền trong `app_user`.
   * `VIEWER` = ai qua được SSO đều xem được (đúng tinh thần đọc-mở/ghi-chặn).
   * `null` = chưa cấp quyền thì coi như không có principal (chặn cả xem).
   */
  readonly defaultRole: UserRole | null;
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
 * Dựng hàm phân giải principal. Trả một hàm BẤT ĐỒNG BỘ vì phải tra database;
 * `server.ts` gọi nó một lần mỗi request trong hook `onRequest` rồi gắn kết quả
 * vào `req`, để tầng route vẫn đọc principal đồng bộ như cũ.
 */
export function createPrincipalResolver(
  store: AppUserStore,
  config: AuthConfig,
): (req: FastifyRequest) => Promise<Principal | null> {
  const headerName = config.identityHeader.toLowerCase();

  return async (req: FastifyRequest): Promise<Principal | null> => {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const userId = normalizeIdentity(firstHeader(headers[headerName]));
    if (userId === null) return null;

    // Admin mồi: cấp qua env, xác định trước cả database — để lần đầu triển khai
    // vẫn có người thêm được người khác vào `app_user`.
    if (config.bootstrapAdmins.has(userId)) {
      return { userId, role: 'ADMIN', projects: [] };
    }

    const found = await store.find(userId);
    if (found !== null) {
      return { userId, role: found.role, projects: [...found.projects] };
    }

    // Đã xác thực nhưng chưa được cấp quyền: mặc định VIEWER (hoặc từ chối, tuỳ
    // cấu hình). KHÔNG bao giờ tự nâng lên PM/ADMIN.
    if (config.defaultRole !== null) {
      return { userId, role: config.defaultRole, projects: [] };
    }
    return null;
  };
}

const VALID_DEFAULT_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'PM', 'VIEWER', 'NONE']);

/**
 * Đọc cấu hình auth từ biến môi trường (gọi ở điểm lắp ráp `main.ts`).
 *
 *   AUTH_IDENTITY_HEADER   tên header danh tính (mặc định `x-user-id`)
 *   AUTH_BOOTSTRAP_ADMINS  danh sách email admin mồi, phân tách bởi dấu phẩy
 *   AUTH_DEFAULT_ROLE      VIEWER (mặc định) | PM | ADMIN | NONE
 */
export function authConfigFromEnv(env: NodeJS.ProcessEnv): AuthConfig {
  const identityHeader = env['AUTH_IDENTITY_HEADER']?.trim() || 'x-user-id';

  const bootstrapAdmins = new Set(
    (env['AUTH_BOOTSTRAP_ADMINS'] ?? '')
      .split(',')
      .map((s) => normalizeIdentity(s))
      .filter((s): s is string => s !== null),
  );

  const rawRole = (env['AUTH_DEFAULT_ROLE']?.trim().toUpperCase() || 'VIEWER');
  if (!VALID_DEFAULT_ROLES.has(rawRole)) {
    throw new Error(
      `AUTH_DEFAULT_ROLE="${rawRole}" không hợp lệ. Giá trị cho phép: ADMIN, PM, VIEWER, NONE.`,
    );
  }
  const defaultRole = rawRole === 'NONE' ? null : (rawRole as UserRole);

  return { identityHeader, bootstrapAdmins, defaultRole };
}
