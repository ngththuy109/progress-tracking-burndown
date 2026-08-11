import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fieldPath, previewRequestSchema, saveConfigRequestSchema, type Principal } from '@app/shared';
import {
  ApiError,
  getEffective,
  listUnmatched,
  listVersions,
  preview,
  rollback,
  save,
  type PhaseConfigDeps,
} from '../services/phase-config.service.js';
import { projectCtxOf, type AuthzGuard, type AuthzGuards } from '../adapters/project-scope.js';

/**
 * Nhóm API cấu hình nhận diện Phase — PRD Phụ lục B — mount HAI nơi:
 *
 *   - `/api/projects/:projectKey/config/phase...` — bản ghi đè của MỘT tenant.
 *     Đọc (GET effective/versions/unmatched) → VIEWER của dự án;
 *     preview/lưu/rollback → PM của dự án. `projectKey` luôn lấy từ URL —
 *     client không tự chọn được tenant qua query/body nữa.
 *   - `/api/admin/config/phase...` — bộ Mặc định (GLOBAL, `projectKey = null`),
 *     CHỈ ADMIN: nó ảnh hưởng tới MỌI dự án đang kế thừa.
 *
 * Tầng này CHỈ điều phối: đọc tham số, gọi service, đổi lỗi thành mã HTTP.
 * Quyền nằm ở guard tập trung (adapters/project-scope), không còn
 * `assertCanWrite` trong service.
 */

export interface ConfigPhaseRouteDeps extends PhaseConfigDeps {
  resolvePrincipal(req: FastifyRequest): Principal | null;
  readonly guards: AuthzGuards;
}

export function registerConfigPhaseRoutes(app: FastifyInstance, deps: ConfigPhaseRouteDeps): void {
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      const body = await fn();
      await reply.send(body);
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({
          error: err.code,
          message: err.message,
          ...(err.issues ? { issues: err.issues } : {}),
        });
        return;
      }
      // Lỗi ngoài dự kiến: KHÔNG trả nguyên văn ra ngoài — thông báo của Prisma
      // có thể chứa tên bảng, câu SQL, thậm chí giá trị dữ liệu.
      app.log.error({ err }, 'Lỗi ngoài dự kiến ở nhóm API cấu hình Phase');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const userIdOf = (req: FastifyRequest): string => deps.resolvePrincipal(req)?.userId ?? '';

  /**
   * Đăng ký trọn bộ endpoint cho MỘT phạm vi. `scopeKey(req)` trả `null` với bộ
   * Mặc định (admin) và trả key tenant với bản project — phần còn lại giống hệt
   * nhau nên viết một lần.
   */
  const registerScope = (args: {
    prefix: string;
    scopeKey(req: FastifyRequest): string | null;
    read: { preHandler: AuthzGuard };
    write: { preHandler: AuthzGuard };
  }): void => {
    const { prefix, scopeKey, read, write } = args;

    app.get(`${prefix}/config/phase`, read, async (req, reply) =>
      handle(reply, () => getEffective(deps, scopeKey(req))),
    );

    app.post(`${prefix}/config/phase/preview`, write, async (req, reply) =>
      handle(reply, async () => {
        // `projectKey` trong body bị BỎ QUA có chủ đích — phạm vi là của URL.
        const parsed = previewRequestSchema.safeParse({
          ...(req.body as Record<string, unknown>),
          projectKey: scopeKey(req),
        });
        if (!parsed.success) throw badRequest(parsed.error);
        return preview(deps, parsed.data);
      }),
    );

    app.put(`${prefix}/config/phase`, write, async (req, reply) =>
      handle(reply, async () => {
        const parsed = saveConfigRequestSchema.safeParse({
          ...(req.body as Record<string, unknown>),
          projectKey: scopeKey(req),
        });
        if (!parsed.success) throw badRequest(parsed.error);
        return save(deps, userIdOf(req), {
          projectKey: parsed.data.projectKey,
          payload: parsed.data.payload,
          note: parsed.data.note,
        });
      }),
    );

    app.get(`${prefix}/config/phase/versions`, read, async (req, reply) =>
      handle(reply, async () => ({ versions: await listVersions(deps, scopeKey(req)) })),
    );

    app.post(`${prefix}/config/phase/rollback/:version`, write, async (req, reply) =>
      handle(reply, async () => {
        const raw = (req.params as { version?: string }).version;
        const version = Number(raw);
        if (!Number.isInteger(version) || version < 1) {
          throw new ApiError(400, 'BAD_REQUEST', `Invalid version number: "${raw}".`);
        }
        return rollback(deps, userIdOf(req), { projectKey: scopeKey(req), version });
      }),
    );

    app.get(`${prefix}/config/phase/unmatched`, read, async (req, reply) =>
      handle(reply, async () => ({ labels: await listUnmatched(deps, scopeKey(req)) })),
    );
  };

  // Bản ghi đè theo tenant.
  registerScope({
    prefix: '/api/projects/:projectKey',
    scopeKey: (req) => projectCtxOf(req).projectKey,
    read: { preHandler: deps.guards.requireProject('VIEWER') },
    write: { preHandler: deps.guards.requireProject('PM') },
  });

  // Bộ Mặc định (GLOBAL) — chỉ ADMIN, kể cả đọc: đây là màn hình quản trị.
  registerScope({
    prefix: '/api/admin',
    scopeKey: () => null,
    read: { preHandler: deps.guards.requireAdmin },
    write: { preHandler: deps.guards.requireAdmin },
  });
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
      // `fieldPath` (shared) đổi đường dẫn zod về dạng `phaseDefinitions[2].phaseCode`
      // để màn hình neo được lỗi vào đúng dòng. Xem `@app/shared/issue-path.ts`.
      path: fieldPath(i.path),
    })),
  );
}
