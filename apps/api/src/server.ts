import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { PrismaClient } from '@app/db';
import { MetricsRegistry, type Principal, type StatusIdMap } from '@app/shared';
import type { JiraClient, ResolvedFieldMapping } from '@app/jira';
import { registerConfigPhaseRoutes } from './routes/config-phase.routes.js';
import { registerOpsRoutes } from './routes/ops.routes.js';
import { registerHttpMetrics } from './observability/http-metrics.js';
import { createOpsHealthPort } from './adapters/ops.adapters.js';
import { registerEpicRoutes } from './routes/epics.routes.js';
import { registerBurndownRoutes } from './routes/burndown.routes.js';
import { registerEpicOpsRoutes } from './routes/epic-ops.routes.js';
import { registerSignboardRoutes } from './routes/signboard.routes.js';
import { registerPhaseSubtaskRoutes } from './routes/phase-subtasks.routes.js';
import { registerMeRoutes } from './routes/me.routes.js';
import { registerUsersRoutes } from './routes/users.routes.js';
import { registerProjectsRoutes } from './routes/projects.routes.js';
import { createSignboardReadPort } from './adapters/signboard.adapters.js';
import { createPhaseSubtaskReadPort } from './adapters/phase-subtasks.adapters.js';
import { createEpicOpsReadPort, createEpicOpsWritePort } from './adapters/epic-ops.adapters.js';
import { createBurndownReadPort } from './adapters/burndown.adapters.js';
import { createChartCache, type CacheRedis } from './adapters/chart-cache.js';
import {
  createDirtyEpicQueue,
  createIssueReadPort,
  createPhaseConfigStore,
  type RedisLike,
} from './adapters/phase-config.adapters.js';
import {
  createBackfillQueue,
  createJiraEpicPort,
  createTrackedEpicStore,
  type QueueLike,
} from './adapters/epic-registry.adapters.js';
import { createPrincipalResolver, type AuthConfig } from './adapters/principal.js';
import { createAppUserStore, createAppUserAdminStore } from './adapters/app-user.adapters.js';
import { createProjectStore } from './adapters/project.adapters.js';

/**
 * REST API — chỉ điều phối, không chứa logic nghiệp vụ.
 *
 * Ranh giới (ARCHITECTURE.md §2): được import `@app/engine`, `@app/db`,
 * `@app/shared`, và `@app/jira` NHƯNG CHỈ để tra cứu ngắn — kiểm tra key Epic
 * và duyệt danh sách Epic. Mọi việc dài hơi (đồng bộ, backfill, tính lại) vẫn
 * thuộc về worker: chúng mất vài phút và sẽ làm request timeout.
 *
 * File này là ĐIỂM LẮP RÁP: nơi duy nhất biết Prisma, Redis và Jira thật. Mọi
 * tầng dưới chỉ nhìn thấy cổng, nhờ vậy test được mà không cần dựng hạ tầng.
 */

export const DEFAULT_PORT = 3000;

/**
 * Principal được phân giải MỘT lần mỗi request trong hook `onRequest` rồi gắn
 * vào đây, để tầng route đọc đồng bộ (`resolvePrincipal(req)`) như trước — dù
 * việc phân giải phải tra database nên bản thân nó bất đồng bộ.
 */
declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface ServerDeps {
  readonly prisma: PrismaClient;
  readonly redis: RedisLike;
  readonly jira: JiraClient;
  readonly fieldMapping: ResolvedFieldMapping;
  readonly backfillQueue: QueueLike;
  /** Tra `status_id` sang nhóm trạng thái — nạp một lần lúc khởi động (T-04). */
  readonly statusIdMap: StatusIdMap;
  readonly cache?: { del(pattern: string): Promise<void> };
  /** Cấu hình xác thực (danh tính do cổng SSO đặt, vai trò tra `app_user`). */
  readonly auth: AuthConfig;
}

export function createServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      // Log JSON có cấu trúc (C-9). `redact` là tuyến chặn cuối cùng để token
      // không bao giờ lọt vào log, kể cả khi có ai đó lỡ log nguyên request.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    genReqId: () => cryptoRandomId(),
  });

  // Số đo HTTP (PRD §9.5): một registry cho tiến trình này, ghi thời gian mọi
  // response rồi phát ra ở `/metrics`. Registry theo tiến trình nên số đo là của
  // riêng API — worker phát số đo của nó ở registry riêng.
  const registry = new MetricsRegistry();
  registerHttpMetrics(app, registry);

  // Phân giải danh tính → principal một lần mỗi request. Danh tính đến từ header
  // do cổng SSO đặt; vai trò tra bảng `app_user`. KHÔNG tin `role` từ header.
  const resolvePrincipal = createPrincipalResolver(createAppUserStore(deps.prisma), deps.auth);
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req, reply) => {
    try {
      req.principal = await resolvePrincipal(req);
    } catch (err) {
      // Tra `app_user` hỏng (DB chết…) KHÔNG được âm thầm thành "không có quyền"
      // — đó là lỗi máy chủ. Không trả nguyên văn lỗi Prisma ra ngoài (có thể lộ
      // tên bảng/câu SQL). `return reply` để Fastify dừng hẳn, không gọi handler.
      app.log.error({ err }, 'Không phân giải được danh tính người gọi');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
      return reply;
    }
  });
  const getPrincipal = (req: FastifyRequest): Principal | null => req.principal;

  registerMeRoutes(app, { resolvePrincipal: getPrincipal });

  const appUserAdminStore = createAppUserAdminStore(deps.prisma);
  const projectStore = createProjectStore(deps.prisma);

  registerUsersRoutes(app, {
    resolvePrincipal: getPrincipal,
    store: appUserAdminStore,
    bootstrapAdmins: deps.auth.bootstrapAdmins,
    knownProjectKeys: () => projectStore.keys(),
  });

  registerProjectsRoutes(app, {
    resolvePrincipal: getPrincipal,
    projects: projectStore,
    users: appUserAdminStore,
  });

  registerConfigPhaseRoutes(app, {
    store: createPhaseConfigStore(deps.prisma, deps.cache),
    issues: createIssueReadPort(deps.prisma),
    dirty: createDirtyEpicQueue(deps.redis),
    resolvePrincipal: getPrincipal,
  });

  registerEpicRoutes(app, {
    store: createTrackedEpicStore(deps.prisma),
    jira: createJiraEpicPort(deps.jira, deps.fieldMapping),
    backfill: createBackfillQueue(deps.backfillQueue),
    resolvePrincipal: getPrincipal,
  });

  registerBurndownRoutes(app, {
    reads: createBurndownReadPort(deps.prisma),
    cache: createChartCache({
      redis: deps.redis as unknown as CacheRedis,
      // Cache trượt hay Redis chết đều chỉ là cảnh báo — biểu đồ vẫn phải vẽ
      // được từ database. Coi Redis chết là lỗi 500 sẽ biến một tối ưu thành
      // phụ thuộc cứng.
      onWarning: (code, detail) => app.log.warn({ event: code, detail }, 'Cache biểu đồ trượt'),
    }),
    resolvePrincipal: getPrincipal,
  });

  registerSignboardRoutes(app, {
    reads: createSignboardReadPort(deps.prisma),
    resolvePrincipal: getPrincipal,
    // Đồng hồ đi qua cổng để test đóng băng được — trạng thái Signboard phụ
    // thuộc "hôm nay là ngày nào".
    now: () => new Date(),
  });

  registerEpicOpsRoutes(app, {
    reads: createEpicOpsReadPort(deps.prisma, deps.statusIdMap),
    writes: createEpicOpsWritePort(deps.prisma, deps.backfillQueue),
    resolvePrincipal: getPrincipal,
  });

  registerPhaseSubtaskRoutes(app, {
    reads: createPhaseSubtaskReadPort(deps.prisma),
    resolvePrincipal: getPrincipal,
  });

  // Dashboard giám sát (T-33): `/api/ops/health` gom cả bốn nhóm số đo trong một
  // lần đọc, và `/metrics` phát số đo Prometheus. `checks`/`bannerAlerts` cố ý bỏ
  // trống — `main.ts` đã tự mở `/healthz` bằng Prisma/Redis thật (khai lại ở đây
  // sẽ trùng route), còn banner cảnh báo P3 chưa có nơi gọi.
  const opsHealthPort = createOpsHealthPort(deps.prisma);
  registerOpsRoutes(app, {
    registry,
    opsHealth: () => opsHealthPort.opsHealth(),
  });

  return app;
}

/** `correlationId` cho mỗi request (C-9), để lần được một luồng qua log. */
function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
