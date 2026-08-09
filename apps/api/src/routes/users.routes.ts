import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  upsertUserRequestSchema,
  type AppUserView,
  type Principal,
  type UserRole,
} from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import { normalizeIdentity } from '../adapters/principal.js';
import type { AppUserAdminStore } from '../adapters/app-user.adapters.js';

/**
 * Quản lý người dùng — `/api/users`, CHỈ ADMIN.
 *
 * Đây là nơi Admin tự cấp quyền cho Admin/PM/Viewer trên giao diện thay vì phải
 * chạy `pnpm auth:grant` hay SQL. Vai trò vẫn nằm ở bảng `app_user` (nguồn sự
 * thật) — màn hình chỉ là lối vào có kiểm soát.
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
  /** Email admin mồi từ env — hiện dưới dạng chỉ-đọc, không sửa được ở đây. */
  readonly bootstrapAdmins: ReadonlySet<string>;
}

const ROLE_RANK: Record<UserRole, number> = { ADMIN: 0, PM: 1, VIEWER: 2 };

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

  const requireAdmin = (req: FastifyRequest): Principal => {
    const p = deps.resolvePrincipal(req);
    if (!p) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'This request has no signed-in user. Reload the page to sign in again.');
    }
    if (p.role !== 'ADMIN') {
      throw new ApiError(403, 'FORBIDDEN', 'Only Admins can manage users.');
    }
    return p;
  };

  app.get('/api/users', async (req, reply) =>
    handle(reply, async () => {
      requireAdmin(req);
      const rows = await deps.store.list();

      const views: AppUserView[] = rows.map((r) => ({
        userId: r.userId,
        role: r.role,
        projects: [...r.projects],
        displayName: r.displayName,
        source: 'DB' as const,
      }));

      // Thêm admin mồi từ env chưa có trong DB, đánh dấu chỉ-đọc, để Admin thấy
      // đủ mọi người đang có quyền chứ không "biến mất" chính mình.
      const known = new Set(views.map((v) => v.userId));
      for (const email of deps.bootstrapAdmins) {
        if (!known.has(email)) {
          views.push({ userId: email, role: 'ADMIN', projects: [], displayName: null, source: 'ENV' });
        }
      }

      views.sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.userId.localeCompare(b.userId));
      return { users: views };
    }),
  );

  app.post('/api/users', async (req, reply) =>
    handle(reply, async () => {
      const admin = requireAdmin(req);

      const parsed = upsertUserRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);

      const userId = normalizeIdentity(parsed.data.userId);
      if (userId === null) {
        throw new ApiError(400, 'BAD_REQUEST', 'The user email is empty.');
      }
      assertNotSelf(admin, userId);
      assertNotBootstrap(deps, userId);

      const { role } = parsed.data;
      // `projects` chỉ có nghĩa với PM. Gán cho ADMIN/VIEWER là hiểu nhầm mô hình
      // — chặn thẳng thay vì âm thầm bỏ đi.
      if (role !== 'PM' && parsed.data.projects.length > 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Only PMs are scoped to projects. Clear the projects field for Admin/Viewer.');
      }
      const projects = role === 'PM' ? parsed.data.projects : [];

      await deps.store.upsert({ userId, role, projects, displayName: parsed.data.displayName });

      const view: AppUserView = {
        userId,
        role,
        projects,
        displayName: parsed.data.displayName,
        source: 'DB',
      };
      return view;
    }),
  );

  app.delete('/api/users/:userId', async (req, reply) =>
    handle(reply, async () => {
      const admin = requireAdmin(req);

      const userId = normalizeIdentity((req.params as { userId?: string }).userId);
      if (userId === null) {
        throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the user email.');
      }
      assertNotSelf(admin, userId);
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
