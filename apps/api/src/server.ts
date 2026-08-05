import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@app/db';
import type { StatusIdMap } from '@app/shared';
import type { JiraClient, ResolvedFieldMapping } from '@app/jira';
import { registerConfigPhaseRoutes } from './routes/config-phase.routes.js';
import { registerEpicRoutes } from './routes/epics.routes.js';
import { registerBurndownRoutes } from './routes/burndown.routes.js';
import { registerEpicOpsRoutes } from './routes/epic-ops.routes.js';
import { registerSignboardRoutes } from './routes/signboard.routes.js';
import { createSignboardReadPort } from './adapters/signboard.adapters.js';
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
import { resolvePrincipalFromHeaders } from './adapters/principal.js';

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

export interface ServerDeps {
  readonly prisma: PrismaClient;
  readonly redis: RedisLike;
  readonly jira: JiraClient;
  readonly fieldMapping: ResolvedFieldMapping;
  readonly backfillQueue: QueueLike;
  /** Tra `status_id` sang nhóm trạng thái — nạp một lần lúc khởi động (T-04). */
  readonly statusIdMap: StatusIdMap;
  readonly cache?: { del(pattern: string): Promise<void> };
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

  registerConfigPhaseRoutes(app, {
    store: createPhaseConfigStore(deps.prisma, deps.cache),
    issues: createIssueReadPort(deps.prisma),
    dirty: createDirtyEpicQueue(deps.redis),
    resolvePrincipal: resolvePrincipalFromHeaders,
  });

  registerEpicRoutes(app, {
    store: createTrackedEpicStore(deps.prisma),
    jira: createJiraEpicPort(deps.jira, deps.fieldMapping),
    backfill: createBackfillQueue(deps.backfillQueue),
    resolvePrincipal: resolvePrincipalFromHeaders,
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
    resolvePrincipal: resolvePrincipalFromHeaders,
  });

  registerSignboardRoutes(app, {
    reads: createSignboardReadPort(deps.prisma),
    resolvePrincipal: resolvePrincipalFromHeaders,
    // Đồng hồ đi qua cổng để test đóng băng được — trạng thái Signboard phụ
    // thuộc "hôm nay là ngày nào".
    now: () => new Date(),
  });

  registerEpicOpsRoutes(app, {
    reads: createEpicOpsReadPort(deps.prisma, deps.statusIdMap),
    writes: createEpicOpsWritePort(deps.prisma, deps.backfillQueue),
    resolvePrincipal: resolvePrincipalFromHeaders,
  });

  return app;
}

/** `correlationId` cho mỗi request (C-9), để lần được một luồng qua log. */
function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
