import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  addEpicsRequestSchema,
  deleteEpicRequestSchema,
  patchEpicRequestSchema,
  validateEpicsRequestSchema,
  type Principal,
} from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import {
  addEpics,
  browseEpics,
  listEpics,
  listMissingDates,
  patchEpic,
  removeEpic,
  validateKeys,
  type EpicRegistryDeps,
} from '../services/epic-registry.service.js';

/** Số Epic mỗi trang khi duyệt. Project lớn có hàng trăm Epic. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export interface EpicRouteDeps extends EpicRegistryDeps {
  resolvePrincipal(req: FastifyRequest): Principal | null;
}

export function registerEpicRoutes(app: FastifyInstance, deps: EpicRouteDeps): void {
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
      app.log.error({ err }, 'Lỗi ngoài dự kiến ở nhóm API sổ đăng ký Epic');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const requireWriter = (req: FastifyRequest): Principal => {
    const p = deps.resolvePrincipal(req);
    if (!p) throw new ApiError(401, 'UNAUTHENTICATED', 'This request has no signed-in user. Reload the page to sign in again.');
    if (p.role === 'VIEWER') {
      throw new ApiError(403, 'FORBIDDEN', 'Only Admins and PMs can change which Epics are tracked.');
    }
    return p;
  };

  app.post('/api/epics/validate', async (req, reply) =>
    handle(reply, async () => {
      const parsed = validateEpicsRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);
      return validateKeys(deps, parsed.data.keys);
    }),
  );

  app.post('/api/epics', async (req, reply) =>
    handle(reply, async () => {
      const principal = requireWriter(req);
      const parsed = addEpicsRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);
      return addEpics(deps, parsed.data, principal.userId);
    }),
  );

  app.get('/api/epics', async (req, reply) =>
    handle(reply, async () => ({ epics: await listEpics(deps, queryString(req, 'project')) })),
  );

  app.get('/api/epics/browse', async (req, reply) =>
    handle(reply, async () => {
      const projectKey = queryString(req, 'project');
      if (!projectKey) throw new ApiError(400, 'BAD_REQUEST', 'Missing the ?project=KEY parameter.');
      return browseEpics(deps, projectKey, {
        startAt: queryInt(req, 'startAt', 0),
        maxResults: Math.min(queryInt(req, 'maxResults', DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE),
      });
    }),
  );

  app.patch('/api/epics/:epicKey', async (req, reply) =>
    handle(reply, async () => {
      requireWriter(req);
      const parsed = patchEpicRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);
      await patchEpic(deps, epicKeyParam(req), parsed.data);
      return { ok: true };
    }),
  );

  app.delete('/api/epics/:epicKey', async (req, reply) =>
    handle(reply, async () => {
      requireWriter(req);
      // `purge` đến từ query (`?purge=true`), `confirmKey` từ body — cố ý tách
      // hai chỗ để không xoá sạch được chỉ bằng một đường link.
      const parsed = deleteEpicRequestSchema.safeParse({
        purge: queryString(req, 'purge') === 'true',
        confirmKey: (req.body as { confirmKey?: string } | undefined)?.confirmKey ?? null,
      });
      if (!parsed.success) throw badRequest(parsed.error);
      await removeEpic(deps, epicKeyParam(req), parsed.data);
      return { ok: true };
    }),
  );

  app.get('/api/epics/:epicKey/missing-dates', async (req, reply) =>
    handle(reply, async () => {
      // `missingDatesResponseSchema` yêu cầu cả `epicKey` — thiếu nó là client
      // từ chối toàn bộ response (RESPONSE_SHAPE_INVALID), không chỉ thiếu chữ.
      const epicKey = epicKeyParam(req);
      return { epicKey, rows: await listMissingDates(deps, epicKey) };
    }),
  );
}

function epicKeyParam(req: FastifyRequest): string {
  const key = (req.params as { epicKey?: string }).epicKey?.trim();
  if (!key) throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the Epic key.');
  return key;
}

function queryString(req: FastifyRequest, name: string): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function queryInt(req: FastifyRequest, name: string, fallback: number): number {
  const raw = queryString(req, name);
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
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
