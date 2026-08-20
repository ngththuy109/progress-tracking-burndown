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
import { registerCalendarRoutes } from './routes/calendars.routes.js';
import { createCalendarStore } from './adapters/calendars.adapters.js';
import { registerPlanConflictRoutes } from './routes/plan-conflicts.routes.js';
import { createPlanConflictReadPort } from './adapters/plan-conflicts.adapters.js';
import { registerEpicOpsRoutes } from './routes/epic-ops.routes.js';
import { registerSignboardRoutes } from './routes/signboard.routes.js';
import { registerPhaseSubtaskRoutes } from './routes/phase-subtasks.routes.js';
import { registerLogworkRoutes } from './routes/logwork.routes.js';
import { registerMeRoutes } from './routes/me.routes.js';
import { registerUsersRoutes } from './routes/users.routes.js';
import { registerProjectsRoutes } from './routes/projects.routes.js';
import { createSignboardReadPort } from './adapters/signboard.adapters.js';
import { createPhaseSubtaskReadPort } from './adapters/phase-subtasks.adapters.js';
import { createLogworkReadPort, createLogworkWritePort } from './adapters/logwork.adapters.js';
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
import { createAuthResolver, type AuthConfig } from './adapters/principal.js';
import { createAppUserStore, createAppUserAdminStore } from './adapters/app-user.adapters.js';
import { createProjectStore } from './adapters/project.adapters.js';
import { registerAuthRoutes, type TokenBox } from './routes/auth.routes.js';
import { createLdapConfigLoader, type LdapConfigStore } from './adapters/ldap-config.adapters.js';
import { sessionIdOf, type SessionStore } from './adapters/session.adapters.js';
import type { LdapClientFactory } from './services/ldap.service.js';

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
  /** Phiên đăng nhập LDAP in-app trên Redis (cookie `ptb_sess`). */
  readonly sessions: SessionStore;
  /** Đọc/ghi cấu hình LDAP (bảng một dòng `auth_ldap_config`). */
  readonly ldapConfigs: LdapConfigStore;
  /** Dựng kết nối ldapts theo yêu cầu — test tiêm client giả qua đây. */
  readonly ldapClientFactory: LdapClientFactory;
  /** env AUTH_FORCE_HEADER=1 — van thoát hiểm: ép chế độ header dù LDAP bật. */
  readonly forceHeaderAuth: boolean;
  /** Hộp seal/open bind password LDAP — `null` khi APP_ENCRYPTION_KEY chưa đặt. */
  readonly tokenBox: TokenBox | null;
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

  // Cấu hình LDAP đọc trên TỪNG request (hook bên dưới phải biết "LDAP bật
  // chưa?") — đi qua loader cache ~10s; route admin vô hiệu cache khi lưu.
  const ldapConfigLoader = createLdapConfigLoader(() => deps.ldapConfigs.find());

  // Phân giải danh tính → principal một lần mỗi request, theo thứ tự:
  //   (1) phiên đăng nhập LDAP (cookie `ptb_sess`) — thắng vô điều kiện;
  //   (2) LDAP tắt hoặc AUTH_FORCE_HEADER=1 → header do cổng SSO đặt (như cũ);
  //   (3) LDAP bật mà không có phiên → không có principal (KHÔNG tin header).
  // Vai trò luôn tra `app_user`. KHÔNG tin `role` từ header.
  const resolvePrincipal = createAuthResolver(createAppUserStore(deps.prisma), deps.auth, {
    sessionUserId: async (req) => {
      const sessionId = sessionIdOf(req);
      if (sessionId === null) return null;
      const found = await deps.sessions.find(sessionId);
      return found?.userId ?? null;
    },
    ldapEnabled: async () => (await ldapConfigLoader.load())?.enabled === true,
    forceHeader: deps.forceHeaderAuth,
  });
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

  // Đăng nhập LDAP in-app: /api/auth/mode, /auth/login|logout (public) và
  // /api/admin/auth/ldap[...] (ADMIN — tự kiểm principal trong handler).
  registerAuthRoutes(app, {
    resolvePrincipal: getPrincipal,
    configs: deps.ldapConfigs,
    loadConfig: () => ldapConfigLoader.load(),
    invalidateConfig: () => ldapConfigLoader.invalidate(),
    sessions: deps.sessions,
    clientFactory: deps.ldapClientFactory,
    tokenBox: deps.tokenBox,
    forceHeader: deps.forceHeaderAuth,
  });

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
    resolvePrincipal: getPrincipal,
  });

  // Lịch làm việc & ngày nghỉ (T-36). Dùng CHUNG cache biểu đồ và hàng đợi
  // dirty:epics: sửa ngày lễ phải xoá cache chart và đánh dấu Epic tính lại,
  // y như sửa cấu hình Phase.
  registerCalendarRoutes(app, {
    store: createCalendarStore(deps.prisma),
    dirty: createDirtyEpicQueue(deps.redis),
    invalidateChart: (epicKey) => chartCache.invalidateEpic(epicKey),
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

  // Theo dõi việc log work của member — TOÀN ĐỘI. Đồng hồ đi qua cổng để test
  // đóng băng được ("kỳ này" phụ thuộc hôm nay).
  registerLogworkRoutes(app, {
    reads: createLogworkReadPort(deps.prisma),
    writes: createLogworkWritePort(deps.prisma),
    resolvePrincipal: getPrincipal,
    now: () => new Date(),
  });

  // Kiểm tra plan rơi vào ngày nghỉ (T-37): báo cáo sau-sync, tính lúc đọc.
  // Dùng CHUNG một cổng đọc cho cả route lẫn dashboard giám sát (loại lỗi Data
  // quality thứ sáu ghép từ chính phép tính này).
  const planConflictReads = createPlanConflictReadPort(deps.prisma);
  registerPlanConflictRoutes(app, {
    reads: planConflictReads,
    resolvePrincipal: getPrincipal,
  });

  // Dashboard giám sát (T-33): `/api/ops/health` gom cả bốn nhóm số đo trong một
  // lần đọc, và `/metrics` phát số đo Prometheus. `checks`/`bannerAlerts` cố ý bỏ
  // trống — `main.ts` đã tự mở `/healthz` bằng Prisma/Redis thật (khai lại ở đây
  // sẽ trùng route), còn banner cảnh báo P3 chưa có nơi gọi.
  const opsHealthPort = createOpsHealthPort(deps.prisma, { planConflictReads });
  registerOpsRoutes(app, {
    registry,
    opsHealth: () => opsHealthPort.opsHealth(),
    runDetail: (runId) => opsHealthPort.runDetail(runId),
    dataQuality: {
      issues: () => opsHealthPort.dataQualityIssues(),
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
