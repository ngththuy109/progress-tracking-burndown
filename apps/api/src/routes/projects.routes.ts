import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  PROJECT_KEY_PATTERN,
  upsertProjectRequestSchema,
  type Principal,
  type ProjectView,
} from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import type { ProjectStore } from '../adapters/project.adapters.js';
import type { AppUserAdminStore } from '../adapters/app-user.adapters.js';

/**
 * Danh mục Project — `/api/projects`, CHỈ ADMIN.
 *
 * Admin đăng ký trước các project ở đây; màn hình cấp quyền chỉ cho gán PM vào
 * project đã đăng ký (users.routes kiểm lại phía server). Một project gắn được
 * nhiều PM — `pmCount` cho Admin thấy con số đó.
 */
export interface ProjectsRouteDeps {
  resolvePrincipal(req: FastifyRequest): Principal | null;
  readonly projects: ProjectStore;
  /** Đọc danh sách người dùng để đếm PM/đảm bảo không xoá project đang có PM. */
  readonly users: Pick<AppUserAdminStore, 'list'>;
}

/** Chuẩn hoá key: trim + viết HOA (khớp key Jira như PAY, CRM). */
export function normalizeProjectKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const v = raw.trim().toUpperCase();
  return v === '' ? null : v;
}

export function registerProjectsRoutes(app: FastifyInstance, deps: ProjectsRouteDeps): void {
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
      app.log.error({ err }, 'Unexpected error in the Project catalog API group');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const requireAdmin = (req: FastifyRequest): Principal => {
    const p = deps.resolvePrincipal(req);
    if (!p) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'This request has no signed-in user. Reload the page to sign in again.');
    }
    if (p.role !== 'ADMIN') {
      throw new ApiError(403, 'FORBIDDEN', 'Only Admins can manage projects.');
    }
    return p;
  };

  /** Đếm số PM gắn vào mỗi project (chỉ PM mới có `projects` khác rỗng). */
  const pmCounts = async (): Promise<Map<string, number>> => {
    const users = await deps.users.list();
    const counts = new Map<string, number>();
    for (const u of users) {
      for (const key of u.projects) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };

  app.get('/api/projects', async (req, reply) =>
    handle(reply, async () => {
      requireAdmin(req);
      const [rows, counts] = await Promise.all([deps.projects.list(), pmCounts()]);
      const projects: ProjectView[] = rows.map((r) => ({
        projectKey: r.projectKey,
        displayName: r.displayName,
        pmCount: counts.get(r.projectKey) ?? 0,
      }));
      return { projects };
    }),
  );

  app.post('/api/projects', async (req, reply) =>
    handle(reply, async () => {
      requireAdmin(req);
      const parsed = upsertProjectRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);

      const projectKey = normalizeProjectKey(parsed.data.projectKey);
      if (projectKey === null || !PROJECT_KEY_PATTERN.test(projectKey)) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'A project key must be uppercase, start with a letter, and use only A–Z, 0–9 and _ (e.g. PAY, CRM).',
        );
      }

      await deps.projects.upsert({ projectKey, displayName: parsed.data.displayName });

      const counts = await pmCounts();
      const view: ProjectView = {
        projectKey,
        displayName: parsed.data.displayName,
        pmCount: counts.get(projectKey) ?? 0,
      };
      return view;
    }),
  );

  app.delete('/api/projects/:projectKey', async (req, reply) =>
    handle(reply, async () => {
      requireAdmin(req);
      const projectKey = normalizeProjectKey((req.params as { projectKey?: string }).projectKey);
      if (projectKey === null) {
        throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the project key.');
      }

      // Một project đang có PM thì KHÔNG xoá được — gỡ khỏi các PM trước, để không
      // để lại tham chiếu treo (PM gắn một project không còn trong danh mục).
      const counts = await pmCounts();
      const used = counts.get(projectKey) ?? 0;
      if (used > 0) {
        throw new ApiError(
          409,
          'PROJECT_IN_USE',
          `${projectKey} is still assigned to ${used} PM${used === 1 ? '' : 's'}. Remove it from them first.`,
        );
      }

      const removed = await deps.projects.remove(projectKey);
      if (!removed) throw new ApiError(404, 'NOT_FOUND', `${projectKey} is not in the project list.`);
      return { ok: true };
    }),
  );
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
