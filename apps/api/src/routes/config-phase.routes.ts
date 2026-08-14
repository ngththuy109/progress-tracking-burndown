import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  fieldPath,
  previewRequestSchema,
  saveConfigRequestSchema,
  tiersPreviewRequestSchema,
  type Principal,
} from '@app/shared';
import { previewTierKeys } from '@app/engine';
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

/**
 * Nhóm API cấu hình nhận diện Phase — PRD Phụ lục B.
 *
 * Tầng này CHỈ điều phối: đọc tham số, gọi service, đổi lỗi thành mã HTTP.
 * Không có một dòng logic nghiệp vụ nào ở đây.
 */

export interface ConfigPhaseRouteDeps extends PhaseConfigDeps {
  /**
   * Xác định người gọi.
   *
   * Là một CỔNG chứ không phải cách xác thực cố định: GĐ 1 chưa chốt dùng SSO
   * hay JWT. Bộ chuyển đổi mặc định đọc header do gateway đặt; đổi sang cách
   * khác chỉ cần thay hàm này, không đụng tới route.
   */
  resolvePrincipal(req: FastifyRequest): Principal | null;
}

/** `?project=KEY` vắng mặt hoặc rỗng nghĩa là đang thao tác trên bộ Mặc định. */
function projectFromQuery(req: FastifyRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['project'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function requirePrincipal(deps: ConfigPhaseRouteDeps, req: FastifyRequest): Principal {
  const p = deps.resolvePrincipal(req);
  if (!p) throw new ApiError(401, 'UNAUTHENTICATED', 'This request has no signed-in user. Reload the page to sign in again.');
  return p;
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

  app.get('/api/config/phase', async (req, reply) =>
    handle(reply, () => getEffective(deps, projectFromQuery(req))),
  );

  app.post('/api/config/phase/preview', async (req, reply) =>
    handle(reply, async () => {
      const parsed = previewRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);
      return preview(deps, parsed.data);
    }),
  );

  // Xem thử CẤU TRÚC TẦNG: dán một tiêu đề Task, xem từng tầng (bản nháp chưa lưu)
  // bóc ra mã gì. Chạy trên cấu hình GLOBAL — màn Cấu trúc tầng là single-tenant.
  app.post('/api/config/phase/tiers-preview', async (req, reply) =>
    handle(reply, async () => {
      const parsed = tiersPreviewRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);
      const effective = await getEffective(deps, null);
      return previewTierKeys(effective, parsed.data.tiers, parsed.data.taskTitle);
    }),
  );

  app.put('/api/config/phase', async (req, reply) =>
    handle(reply, async () => {
      const principal = requirePrincipal(deps, req);
      const parsed = saveConfigRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);
      return save(deps, principal, {
        projectKey: parsed.data.projectKey,
        payload: parsed.data.payload,
        note: parsed.data.note,
      });
    }),
  );

  app.get('/api/config/phase/versions', async (req, reply) =>
    handle(reply, async () => ({ versions: await listVersions(deps, projectFromQuery(req)) })),
  );

  app.post('/api/config/phase/rollback/:version', async (req, reply) =>
    handle(reply, async () => {
      const principal = requirePrincipal(deps, req);
      const raw = (req.params as { version?: string }).version;
      const version = Number(raw);
      if (!Number.isInteger(version) || version < 1) {
        throw new ApiError(400, 'BAD_REQUEST', `Invalid version number: "${raw}".`);
      }
      return rollback(deps, principal, { projectKey: projectFromQuery(req), version });
    }),
  );

  app.get('/api/config/phase/unmatched', async (req, reply) =>
    handle(reply, async () => ({ labels: await listUnmatched(deps, projectFromQuery(req)) })),
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
      // `fieldPath` (shared) đổi đường dẫn zod về dạng `phaseDefinitions[2].phaseCode`
      // để màn hình neo được lỗi vào đúng dòng. Xem `@app/shared/issue-path.ts`.
      path: fieldPath(i.path),
    })),
  );
}
