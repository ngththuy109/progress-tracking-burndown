import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@app/shared';
import { registerEpicRoutes } from './epics.routes.js';
import { registerConfigPhaseRoutes } from './config-phase.routes.js';
import { registerUsersRoutes } from './users.routes.js';
import { registerOpsRoutes } from './ops.routes.js';
import { MetricsRegistry } from '@app/shared';
import { buildOpsHealth } from '../services/ops-health.service.js';
import {
  FakeBackfillQueue,
  FakeConfigStore,
  FakeDirtyQueue,
  FakeIssueRead,
  FakeJiraEpicPort,
  FakeTrackedEpicStore,
  asAdmin,
  asNobody,
  asPm,
  asViewer,
  testGuards,
} from '../test-fakes.js';

/**
 * MA TRẬN PHÂN QUYỀN — bảng chân trị của Phase B, chạy trên guard THẬT
 * (createAuthzGuards) và route THẬT, chỉ cổng dữ liệu là giả.
 *
 * Hai luật phải đúng trên MỌI route, không riêng route nào:
 *
 *   1. 404-THAY-VÌ-403: người ngoài dự án (kể cả PM của dự án khác) nhận
 *      CÙNG câu trả lời với "dự án không tồn tại" — không dò được danh sách
 *      tenant. 403 chỉ dành cho thành viên thiếu bậc quyền (VIEWER gọi route
 *      PM) và cho người không phải ADMIN gọi /api/admin.
 *   2. Bậc quyền PM ≥ VIEWER; ADMIN vượt membership với role hiệu dụng PM.
 */

type Who = 'anon' | 'nonMember' | 'viewerPay' | 'pmPay' | 'pmCrm' | 'admin';

const WHO: Record<Who, Principal | null> = {
  anon: null,
  nonMember: asNobody(),
  viewerPay: asViewer('PAY'),
  pmPay: asPm('PAY'),
  pmCrm: asPm('CRM'), // thành viên của CRM, NGƯỜI NGOÀI với PAY
  admin: asAdmin(),
};

interface Case {
  readonly name: string;
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly url: string;
  readonly payload?: Record<string, unknown>;
  /** Trạng thái mong đợi cho từng vai. */
  readonly expect: Record<Who, number>;
}

/**
 * Một route đại diện cho mỗi "bậc" quyền:
 *   - VIEWER của dự án (GET danh sách Epic)
 *   - PM của dự án     (POST validate Epic, PUT config, GET ops/health)
 *   - ADMIN            (GET /api/admin/users, GET /api/admin/ops/health,
 *                       GET /api/admin/config/phase)
 * Cộng ca dự án KHÔNG TỒN TẠI (NOPE) để chốt "404 giống hệt non-member".
 */
const CASES: readonly Case[] = [
  {
    name: 'GET epics — đọc mức VIEWER của dự án',
    method: 'GET',
    url: '/api/projects/PAY/epics',
    expect: { anon: 401, nonMember: 404, viewerPay: 200, pmPay: 200, pmCrm: 404, admin: 200 },
  },
  {
    name: 'POST epics/validate — ghi mức PM của dự án',
    method: 'POST',
    url: '/api/projects/PAY/epics/validate',
    payload: { keys: ['PAY-1'] },
    expect: { anon: 401, nonMember: 404, viewerPay: 403, pmPay: 200, pmCrm: 404, admin: 200 },
  },
  {
    name: 'GET config/phase — đọc mức VIEWER của dự án',
    method: 'GET',
    url: '/api/projects/PAY/config/phase',
    expect: { anon: 401, nonMember: 404, viewerPay: 200, pmPay: 200, pmCrm: 404, admin: 200 },
  },
  {
    name: 'GET ops/health của tenant — mức PM',
    method: 'GET',
    url: '/api/projects/PAY/ops/health',
    expect: { anon: 401, nonMember: 404, viewerPay: 403, pmPay: 200, pmCrm: 404, admin: 200 },
  },
  {
    name: 'GET /api/admin/users — chỉ ADMIN',
    method: 'GET',
    url: '/api/admin/users',
    expect: { anon: 401, nonMember: 403, viewerPay: 403, pmPay: 403, pmCrm: 403, admin: 200 },
  },
  {
    name: 'GET /api/admin/ops/health — chỉ ADMIN',
    method: 'GET',
    url: '/api/admin/ops/health',
    expect: { anon: 401, nonMember: 403, viewerPay: 403, pmPay: 403, pmCrm: 403, admin: 200 },
  },
  {
    name: 'GET /api/admin/config/phase — chỉ ADMIN (bộ Mặc định)',
    method: 'GET',
    url: '/api/admin/config/phase',
    expect: { anon: 401, nonMember: 403, viewerPay: 403, pmPay: 403, pmCrm: 403, admin: 200 },
  },
  {
    name: 'dự án KHÔNG TỒN TẠI — 404 cho mọi người đã đăng nhập, kể cả ADMIN',
    method: 'GET',
    url: '/api/projects/NOPE/epics',
    expect: { anon: 401, nonMember: 404, viewerPay: 404, pmPay: 404, pmCrm: 404, admin: 404 },
  },
];

let app: FastifyInstance;
let principal: Principal | null;

beforeAll(async () => {
  principal = null;
  const guards = testGuards({ principal: () => principal, projects: ['PAY', 'CRM'] });
  const resolvePrincipal = () => principal;

  app = Fastify({ logger: false });

  registerEpicRoutes(app, {
    store: new FakeTrackedEpicStore(),
    jira: new FakeJiraEpicPort(new Map()),
    backfill: new FakeBackfillQueue(),
    resolvePrincipal,
    guards,
  });

  registerConfigPhaseRoutes(app, {
    store: new FakeConfigStore([]),
    issues: new FakeIssueRead(),
    dirty: new FakeDirtyQueue(),
    resolvePrincipal,
    guards,
  });

  registerUsersRoutes(app, {
    resolvePrincipal,
    store: { list: async () => [], upsert: async () => {}, remove: async () => false },
    guards,
    bootstrapAdmins: new Set(),
  });

  registerOpsRoutes(app, {
    registry: new MetricsRegistry(),
    guards,
    opsHealth: async () =>
      buildOpsHealth({
        collectedAt: new Date('2026-08-11T00:00:00.000Z'),
        nightlyDurationMinutes: null,
        rateLimitHits24h: 0,
        erroredEpicCount: 0,
        snapshotBehindCount: 0,
        data: {
          total: 0,
          missingEstimateRatio: 0,
          unclassifiedPhaseRatio: 0,
          missingWbsDateRatio: 0,
          unparsedSubtaskRatio: 0,
        },
        dataByEpic: [],
        recentRuns: [],
        erroredEpics: [],
        planDrift: [],
      }),
  });

  await app.ready();
});

describe('ma trận phân quyền route × vai', () => {
  for (const c of CASES) {
    for (const who of Object.keys(c.expect) as Who[]) {
      it(`${c.name} — ${who} → ${c.expect[who]}`, async () => {
        principal = WHO[who];
        const res = await app.inject({
          method: c.method,
          url: c.url,
          ...(c.payload !== undefined ? { payload: c.payload } : {}),
        });
        expect(res.statusCode).toBe(c.expect[who]);
      });
    }
  }
});

describe('luật 404-thay-vì-403 (chống dò tenant)', () => {
  it('người ngoài dự án nhận Y HỆT câu trả lời của dự án không tồn tại', async () => {
    principal = asPm('CRM');
    const real = await app.inject({ method: 'GET', url: '/api/projects/PAY/epics' });
    const ghost = await app.inject({ method: 'GET', url: '/api/projects/NOPE/epics' });

    expect(real.statusCode).toBe(404);
    expect(ghost.statusCode).toBe(404);
    // Cùng mã lỗi, cùng khuôn thông điệp — chỉ khác tên project mà chính họ gõ
    // vào URL. Không có gì phân biệt "có thật nhưng cấm" với "không có".
    expect((real.json() as { error: string }).error).toBe('PROJECT_NOT_FOUND');
    expect((ghost.json() as { error: string }).error).toBe('PROJECT_NOT_FOUND');
    expect((real.json() as { message: string }).message.replace('PAY', 'X')).toBe(
      (ghost.json() as { message: string }).message.replace('NOPE', 'X'),
    );
  });

  it('CROSS-TENANT: PM của CRM gọi route ghi của PAY → 404, không phải 403', async () => {
    principal = asPm('CRM');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/epics/validate',
      payload: { keys: ['PAY-1'] },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('PROJECT_NOT_FOUND');
  });

  it('403 CHỈ xuất hiện với người ĐÃ ở trong dự án (VIEWER gọi route PM)', async () => {
    principal = asViewer('PAY');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/epics/validate',
      payload: { keys: ['PAY-1'] },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('FORBIDDEN');
  });

  it('key dự án sai định dạng bị chặn 400 trước khi chạm DB', async () => {
    principal = asAdmin();
    const res = await app.inject({ method: 'GET', url: '/api/projects/1bad/epics' });
    expect(res.statusCode).toBe(400);
  });
});
