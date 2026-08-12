import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { PrismaClient } from '@app/db';
import { MetricsRegistry, type Principal } from '@app/shared';
import type { JiraClientRegistry } from '@app/jira';
import { registerConfigPhaseRoutes } from './routes/config-phase.routes.js';
import { registerOpsRoutes } from './routes/ops.routes.js';
import { registerHttpMetrics } from './observability/http-metrics.js';
import { createOpsHealthPort } from './adapters/ops.adapters.js';
import { registerEpicRoutes } from './routes/epics.routes.js';
import { registerBurndownRoutes } from './routes/burndown.routes.js';
import { registerCalendarRoutes } from './routes/calendars.routes.js';
import { createCalendarStore } from './adapters/calendars.adapters.js';
import { registerPlanConflictRoutes } from './routes/plan-conflicts.routes.js';
import { createPlanConflictReadPort } from './adapters/plan-conflicts.adapters.js';
import { registerEpicOpsRoutes } from './routes/epic-ops.routes.js';
import { registerSignboardRoutes } from './routes/signboard.routes.js';
import { registerPhaseSubtaskRoutes } from './routes/phase-subtasks.routes.js';
import { registerMeRoutes } from './routes/me.routes.js';
import { registerUsersRoutes } from './routes/users.routes.js';
import {
  registerProjectsRoutes,
  type JiraConnectionTester,
  type TokenBox,
} from './routes/projects.routes.js';
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
import {
  createAuditLogStore,
  createProjectDirectory,
  createProjectMemberStore,
  createProjectStore,
} from './adapters/project.adapters.js';
import { createAuthzGuards } from './adapters/project-scope.js';

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
 *
 * PHÂN QUYỀN (Phase B, multi-tenant): mọi route nghiệp vụ mount dưới
 * `/api/projects/:projectKey/...` và đi qua guard tập trung
 * (`adapters/project-scope.ts`); nhóm quản trị nằm dưới `/api/admin/...`.
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
  /**
   * Registry client Jira THEO TENANT (@app/jira). KHÔNG còn JiraClient/field
   * mapping toàn cục nạp lúc boot — kết nối dựng theo yêu cầu cho từng dự án,
   * dự án legacy rơi về env JIRA_*.
   */
  readonly jiraRegistry: JiraClientRegistry;
  readonly backfillQueue: QueueLike;
  readonly cache?: { del(pattern: string): Promise<void> };
  /** Cấu hình xác thực (danh tính do cổng SSO đặt, quyền tra `app_user`). */
  readonly auth: AuthConfig;
  /** Hộp seal/open token Jira của tenant — `null` khi APP_ENCRYPTION_KEY chưa đặt. */
  readonly tokenBox: TokenBox | null;
  /** "Test connection" — bộ chuyển đổi thật dựng JiraClient theo yêu cầu. */
  readonly jiraTester: JiraConnectionTester;
  /** env JIRA_* + config/jira-fields.yaml — fallback cho tenant chưa khai riêng. */
  readonly envJira: {
    baseUrl: string;
    email: string;
    apiToken: string;
    fieldsConfig: unknown;
  } | null;
  /** Kiểm cấu trúc fieldsConfig (zod của @app/jira, tiêm từ điểm lắp ráp). */
  validateFieldsConfig(v: unknown): { ok: true } | { ok: false; message: string };
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
  // do cổng SSO đặt; quyền tra `app_user` + `project_member`. KHÔNG tin `role`
  // từ header.
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

  // Guard phân quyền TẬP TRUNG: 401/403/404 và luật "404 thay vì 403" nằm hết ở
  // adapters/project-scope.ts — route chỉ khai minRole.
  const guards = createAuthzGuards({
    resolvePrincipal: getPrincipal,
    directory: createProjectDirectory(deps.prisma),
  });

  const projectStore = createProjectStore(deps.prisma);

  registerMeRoutes(app, {
    resolvePrincipal: getPrincipal,
    listProjects: () => projectStore.list(),
  });

  registerUsersRoutes(app, {
    resolvePrincipal: getPrincipal,
    store: createAppUserAdminStore(deps.prisma),
    guards,
    bootstrapAdmins: deps.auth.bootstrapAdmins,
  });

  registerProjectsRoutes(app, {
    resolvePrincipal: getPrincipal,
    guards,
    projects: projectStore,
    members: createProjectMemberStore(deps.prisma),
    audit: createAuditLogStore(deps.prisma),
    tokenBox: deps.tokenBox,
    jiraTester: deps.jiraTester,
    envJira: deps.envJira,
    validateFieldsConfig: deps.validateFieldsConfig,
  });

  registerConfigPhaseRoutes(app, {
    store: createPhaseConfigStore(deps.prisma, deps.cache),
    issues: createIssueReadPort(deps.prisma),
    dirty: createDirtyEpicQueue(deps.redis),
    resolvePrincipal: getPrincipal,
    guards,
  });

  registerEpicRoutes(app, {
    store: createTrackedEpicStore(deps.prisma),
    jira: createJiraEpicPort(deps.jiraRegistry),
    backfill: createBackfillQueue(deps.backfillQueue),
    resolvePrincipal: getPrincipal,
    guards,
  });

  const chartCache = createChartCache({
    redis: deps.redis as unknown as CacheRedis,
    // Cache trượt hay Redis chết đều chỉ là cảnh báo — biểu đồ vẫn phải vẽ
    // được từ database. Coi Redis chết là lỗi 500 sẽ biến một tối ưu thành
    // phụ thuộc cứng.
    onWarning: (code, detail) => app.log.warn({ event: code, detail }, 'Cache biểu đồ trượt'),
  });

  registerBurndownRoutes(app, {
    reads: createBurndownReadPort(deps.prisma),
    cache: chartCache,
    guards,
  });

  // Lịch làm việc & ngày nghỉ/làm bù (T-36/T-39). Dùng CHUNG cache biểu đồ và
  // hàng đợi dirty:epics: sửa ngày lễ/làm bù phải xoá cache chart và đánh dấu
  // Epic tính lại, y như sửa cấu hình Phase.
  registerCalendarRoutes(app, {
    store: createCalendarStore(deps.prisma),
    dirty: createDirtyEpicQueue(deps.redis),
    invalidateChart: (epicKey) => chartCache.invalidateEpic(epicKey),
    guards,
  });

  registerSignboardRoutes(app, {
    reads: createSignboardReadPort(deps.prisma),
    guards,
    // Đồng hồ đi qua cổng để test đóng băng được — trạng thái Signboard phụ
    // thuộc "hôm nay là ngày nào".
    now: () => new Date(),
  });

  registerEpicOpsRoutes(app, {
    // Bảng tra status nạp THEO TENANT qua registry (đa site Jira thì status ID
    // số đụng nhau) — không còn StatusIdMap toàn cục nạp lúc boot.
    reads: createEpicOpsReadPort(deps.prisma, async (projectKey) => {
      const ctx = await deps.jiraRegistry.forProject(projectKey);
      return ctx.statusIdMap;
    }),
    writes: createEpicOpsWritePort(deps.prisma, deps.backfillQueue),
    guards,
  });

  registerPhaseSubtaskRoutes(app, {
    reads: createPhaseSubtaskReadPort(deps.prisma),
    guards,
  });

  // Kiểm tra plan rơi vào ngày nghỉ (T-37): báo cáo sau-sync, tính lúc đọc.
  registerPlanConflictRoutes(app, {
    reads: createPlanConflictReadPort(deps.prisma),
    guards,
  });

  // Dashboard giám sát (T-33): `/api/admin/ops/...` gom số đo TOÀN hệ thống
  // (CHỈ ADMIN); `/api/projects/:key/ops/...` là cùng các endpoint nhưng mọi số
  // đo đã bó theo tenant (PM); `/metrics` phát số đo Prometheus.
  // `checks`/`bannerAlerts` cố ý bỏ trống — `main.ts` đã tự mở `/healthz` bằng
  // Prisma/Redis thật (khai lại ở đây sẽ trùng route), còn banner cảnh báo P3
  // chưa có nơi gọi.
  const opsHealthPort = createOpsHealthPort(deps.prisma);
  registerOpsRoutes(app, {
    registry,
    guards,
    opsHealth: (projectKey) => opsHealthPort.opsHealth(projectKey),
    runDetail: (runId, projectKey) => opsHealthPort.runDetail(runId, projectKey),
    dataQuality: {
      issues: (projectKey) => opsHealthPort.dataQualityIssues(projectKey),
      issueProject: (issueKey) => opsHealthPort.issueProject(issueKey),
      setExempt: (args) => opsHealthPort.setDataQualityExempt(args),
    },
    resolvePrincipal: getPrincipal,
  });

  return app;
}

/** `correlationId` cho mỗi request (C-9), để lần được một luồng qua log. */
function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
