import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MeProject, MeResponse, Principal } from '@app/shared';
import type { ProjectRow } from '@app/db';

/**
 * `GET /api/me` — ai đang đăng nhập, và họ vào được những dự án nào.
 *
 * Nguồn dữ liệu cho project switcher của frontend:
 *   - MEMBER: các dự án có membership (kèm role trong dự án đó);
 *   - ADMIN: MỌI dự án chưa ARCHIVED, role hiệu dụng 'PM'.
 *
 * Trả 401 khi không có principal, để frontend biết cần đá qua trang đăng nhập
 * của cổng SSO. Đây CHỈ để phục vụ giao diện; API vẫn tự kiểm quyền ở mỗi
 * endpoint qua guard tập trung.
 */
export interface MeRouteDeps {
  resolvePrincipal(req: FastifyRequest): Principal | null;
  /** Danh mục project — để gắn displayName và liệt kê hết cho ADMIN. */
  listProjects(): Promise<readonly ProjectRow[]>;
}

export function registerMeRoutes(app: FastifyInstance, deps: MeRouteDeps): void {
  app.get('/api/me', async (req, reply) => {
    const p = deps.resolvePrincipal(req);
    if (!p) {
      await reply.status(401).send({
        error: 'UNAUTHENTICATED',
        message: 'This request has no signed-in user. Reload the page to sign in again.',
      });
      return;
    }

    // Dự án ARCHIVED ẩn khỏi switcher cho cả hai vai — dữ liệu vẫn còn, chỉ là
    // không mời người dùng mở nữa.
    const rows = (await deps.listProjects()).filter((r) => r.status !== 'ARCHIVED');

    const projects: MeProject[] = p.isAdmin
      ? rows.map((r) => ({ projectKey: r.projectKey, displayName: r.displayName, role: 'PM' as const }))
      : rows
          .filter((r) => p.memberships[r.projectKey] !== undefined)
          .map((r) => ({
            projectKey: r.projectKey,
            displayName: r.displayName,
            role: p.memberships[r.projectKey]!,
          }));

    const body: MeResponse = { userId: p.userId, isAdmin: p.isAdmin, projects };
    await reply.send(body);
  });
}
