import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { upsertUserRequestSchema, type AppUserView, type Principal } from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import { normalizeIdentity } from '../adapters/principal.js';
import type { AuthzGuards } from '../adapters/project-scope.js';
import type { AppUserAdminStore } from '../adapters/app-user.adapters.js';

/**
 * Quản lý người dùng — `/api/admin/users`, CHỈ ADMIN (guard `requireAdmin`).
 *
 * Từ multi-tenant, ở đây chỉ quản ROLE TOÀN CỤC (`ADMIN` | `MEMBER`) và tên
 * hiển thị. Membership theo dự án (PM/VIEWER của từng project) quản ở
 * `/api/admin/projects/:projectKey/members` — user phải được cấp ở đây TRƯỚC
 * rồi mới thêm được vào dự án (FK `project_member.user_id`).
 *
 * Hai lớp bảo vệ chống tự khoá:
 *   - KHÔNG cho sửa/xoá chính mình (nhờ Admin khác làm) — tránh lỡ tay hạ quyền
 *     bản thân rồi mất đường vào.
 *   - KHÔNG cho sửa email cấp qua `AUTH_BOOTSTRAP_ADMINS`: chúng do env quyết,
 *     sửa ở đây vô nghĩa (resolver luôn ưu tiên env) và gây hiểu nhầm.
 */
export interface UsersRouteDeps {
  resolvePrincipal(req: FastifyRequest): Principal | null;
  readonly store: AppUserAdminStore;
  readonly guards: AuthzGuards;
  /** Email admin mồi từ env — hiện dưới dạng chỉ-đọc, không sửa được ở đây. */
  readonly bootstrapAdmins: ReadonlySet<string>;
}

const ROLE_RANK: Record<AppUserView['role'], number> = { ADMIN: 0, MEMBER: 1 };

export function registerUsersRoutes(app: FastifyInstance, deps: UsersRouteDeps): void {
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await reply.send(await fn());
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({
          error: err.code,
          message: err.message,
          ...(err.issues ? { issues: err.issues } : {}),
        });
        return;
      }
      app.log.error({ err }, 'Lỗi ngoài dự kiến ở nhóm API quản lý người dùng');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const admin = { preHandler: deps.guards.requireAdmin };

  app.get('/api/admin/users', admin, async (_req, reply) =>
    handle(reply, async () => {
      const rows = await deps.store.list();

      const views: AppUserView[] = rows.map((r) => ({
        userId: r.userId,
        role: r.role,
        displayName: r.displayName,
        source: 'DB' as const,
        membershipCount: r.membershipCount,
      }));

      // Thêm admin mồi từ env chưa có trong DB, đánh dấu chỉ-đọc, để Admin thấy
      // đủ mọi người đang có quyền chứ không "biến mất" chính mình.
      const known = new Set(views.map((v) => v.userId));
      for (const email of deps.bootstrapAdmins) {
        if (!known.has(email)) {
          views.push({
            userId: email,
            role: 'ADMIN',
            displayName: null,
            source: 'ENV',
            membershipCount: 0,
          });
        }
      }

      views.sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.userId.localeCompare(b.userId));
      return { users: views };
    }),
  );

  app.post('/api/admin/users', admin, async (req, reply) =>
    handle(reply, async () => {
      const adminPrincipal = deps.resolvePrincipal(req)!;

      const parsed = upsertUserRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);

      const userId = normalizeIdentity(parsed.data.userId);
      if (userId === null) {
        throw new ApiError(400, 'BAD_REQUEST', 'The user email is empty.');
      }
      assertNotSelf(adminPrincipal, userId);
      assertNotBootstrap(deps, userId);

      await deps.store.upsert({
        userId,
        role: parsed.data.role,
        displayName: parsed.data.displayName,
      });

      // Đếm membership sau upsert: user mới là 0, user sửa role giữ nguyên số cũ.
      const membershipCount =
        (await deps.store.list()).find((r) => r.userId === userId)?.membershipCount ?? 0;

      const view: AppUserView = {
        userId,
        role: parsed.data.role,
        displayName: parsed.data.displayName,
        source: 'DB',
        membershipCount,
      };
      return view;
    }),
  );

  app.delete('/api/admin/users/:userId', admin, async (req, reply) =>
    handle(reply, async () => {
      const adminPrincipal = deps.resolvePrincipal(req)!;

      const userId = normalizeIdentity((req.params as { userId?: string }).userId);
      if (userId === null) {
        throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the user email.');
      }
      assertNotSelf(adminPrincipal, userId);
      assertNotBootstrap(deps, userId);

      const removed = await deps.store.remove(userId);
      if (!removed) {
        throw new ApiError(404, 'NOT_FOUND', `${userId} is not in the user list.`);
      }
      return { ok: true };
    }),
  );
}

/** Không cho tự sửa/xoá chính mình — tránh lỡ tay tự khoá. */
function assertNotSelf(admin: Principal, targetUserId: string): void {
  if (admin.userId === targetUserId) {
    throw new ApiError(
      400,
      'CANNOT_MODIFY_SELF',
      'You cannot change your own role or remove yourself. Ask another Admin to do it.',
    );
  }
}

/** Email cấp qua AUTH_BOOTSTRAP_ADMINS do env quyết, không sửa ở đây. */
function assertNotBootstrap(deps: UsersRouteDeps, userId: string): void {
  if (deps.bootstrapAdmins.has(userId)) {
    throw new ApiError(
      400,
      'BOOTSTRAP_ADMIN',
      `${userId} is granted Admin through the AUTH_BOOTSTRAP_ADMINS env var. Change it there, not here.`,
    );
  }
}

function badRequest(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) {
  return new ApiError(
    400,
    'BAD_REQUEST',
    'The request body is not valid. Fix the highlighted fields and send it again.',
    error.issues.map((i) => ({
      level: 'ERROR' as const,
      code: 'SCHEMA_INVALID',
      message: i.message,
      path: i.path.join('.'),
    })),
  );
}
