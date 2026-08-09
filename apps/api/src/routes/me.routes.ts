import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MeResponse, Principal } from '@app/shared';

/**
 * `GET /api/me` — ai đang đăng nhập.
 *
 * Frontend dùng để hiện tên người dùng và ẩn/hiện nút theo vai trò. Trả 401 khi
 * không có principal, để frontend biết cần đá qua trang đăng nhập của cổng SSO.
 */
export interface MeRouteDeps {
  resolvePrincipal(req: FastifyRequest): Principal | null;
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
    const body: MeResponse = { userId: p.userId, role: p.role, projects: [...p.projects] };
    await reply.send(body);
  });
}
