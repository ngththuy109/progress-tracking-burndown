import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MetricsRegistry,
  type Alert,
  type DataQualityIssue,
  type OpsHealthResponse,
  type Principal,
  type SyncRunDetail,
} from '@app/shared';
import { registerOpsRoutes, type OpsRouteDeps } from './ops.routes.js';
import { buildOpsHealth } from '../services/ops-health.service.js';
import { asAdmin, asPm, asViewer, testGuards } from '../test-fakes.js';

/**
 * Test nhóm route vận hành sau Phase B: dashboard toàn cục dưới /api/admin/ops
 * (CHỈ ADMIN), bản theo tenant dưới /api/projects/:key/ops (PM, mọi số đo đã
 * bó theo dự án — run/ticket của tenant khác là 404).
 *
 * Vẫn canh cạm bẫy lắp ráp cũ: `main.ts` đã tự mở `/healthz` bằng Prisma/Redis
 * thật. Nếu `registerOpsRoutes` cũng mở `/healthz` vô điều kiện thì Fastify ném
 * `FST_ERR_DUPLICATED_ROUTE` lúc khởi động và MỌI route chết. Vậy `/healthz` chỉ
 * được mở khi có `checks`.
 */

const SAMPLE: OpsHealthResponse = buildOpsHealth({
  collectedAt: new Date('2026-03-10T02:00:00.000Z'),
  nightlyDurationMinutes: 18,
  rateLimitHits24h: 3,
  erroredEpicCount: 0,
  snapshotBehindCount: 0,
  data: {
    total: 100,
    missingEstimateRatio: 0.05,
    unclassifiedPhaseRatio: 0.05,
    missingWbsDateRatio: 0.05,
    unparsedSubtaskRatio: 0.05,
  },
  dataByEpic: [],
  recentRuns: [],
  erroredEpics: [],
  planDrift: [],
});

let app: FastifyInstance | undefined;
let principal: Principal | null = asAdmin();

afterEach(async () => {
  await app?.close();
  app = undefined;
  principal = asAdmin();
});

function build(over: Partial<OpsRouteDeps> = {}): FastifyInstance {
  app = Fastify();
  registerOpsRoutes(app, {
    registry: new MetricsRegistry(),
    guards: testGuards({ principal: () => principal }),
    opsHealth: () => Promise.resolve(SAMPLE),
    ...over,
  });
  return app;
}

describe('registerOpsRoutes — endpoint dashboard được LẮP', () => {
  it('GET /api/admin/ops/health trả 200 với đủ bốn nhóm số liệu (KHÔNG còn 404)', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/admin/ops/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OpsHealthResponse;
    expect(body.collectedAt).toBe('2026-03-10T02:00:00.000Z');
    expect(body.jobs).toBeDefined();
    expect(body.jira).toBeDefined();
    expect(body.data).toBeDefined();
    expect(body.planDrift).toBeDefined();
  });

  it('dashboard toàn cục là của ADMIN: PM → 403, chưa đăng nhập → 401', async () => {
    const instance = build();
    principal = asPm('PAY');
    expect((await instance.inject({ method: 'GET', url: '/api/admin/ops/health' })).statusCode).toBe(403);
    principal = null;
    expect((await instance.inject({ method: 'GET', url: '/api/admin/ops/health' })).statusCode).toBe(401);
  });

  it('GET /api/projects/:key/ops/health — PM của dự án nhận bản đã bó theo tenant', async () => {
    const asked: (string | undefined)[] = [];
    const instance = build({
      opsHealth: (projectKey) => {
        asked.push(projectKey);
        return Promise.resolve(SAMPLE);
      },
    });
    principal = asPm('PAY');
    const res = await instance.inject({ method: 'GET', url: '/api/projects/PAY/ops/health' });
    expect(res.statusCode).toBe(200);
    expect(asked).toEqual(['PAY']); // cổng được gọi VỚI projectKey — số liệu đã lọc

    // VIEWER của dự án không xem được cửa sổ ops (nó thuộc việc vận hành của PM).
    principal = asViewer('PAY');
    expect((await instance.inject({ method: 'GET', url: '/api/projects/PAY/ops/health' })).statusCode).toBe(403);

    // Không phải thành viên → 404, không lộ tenant.
    principal = asPm('CRM');
    expect((await instance.inject({ method: 'GET', url: '/api/projects/PAY/ops/health' })).statusCode).toBe(404);
  });

  it('GET /metrics trả 200 dạng text Prometheus', async () => {
    const res = await build().inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });
});

describe('registerOpsRoutes — route tuỳ chọn chỉ mở khi có phụ thuộc', () => {
  it('KHÔNG mở /healthz khi thiếu checks (tránh khai trùng với main.ts)', async () => {
    const res = await build().inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(404);
  });

  it('mở /healthz khi CÓ checks, và báo 503 khi một thành phần chết', async () => {
    const res = await build({
      checks: [
        { name: 'postgres', check: () => Promise.resolve(true) },
        { name: 'redis', check: () => Promise.resolve(false) },
      ],
    }).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', components: { postgres: 'ok', redis: 'down' } });
  });

  it('KHÔNG mở route alerts khi thiếu bannerAlerts', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/projects/PAY/epics/PAY-1/alerts' });
    expect(res.statusCode).toBe(404);
  });

  it('mở route alerts khi CÓ bannerAlerts, và chỉ giữ cảnh báo P3', async () => {
    const alerts: Alert[] = [
      { code: 'MISSING_WBS_DATE', level: 'P3', epicKey: 'PAY-1', message: 'x', value: 1, threshold: 0 },
      { code: 'JOB_FAILED', level: 'P1', epicKey: 'PAY-1', message: 'y', value: 1, threshold: 0 },
    ];
    const res = await build({ bannerAlerts: () => Promise.resolve(alerts) }).inject({
      method: 'GET',
      url: '/api/projects/PAY/epics/PAY-1/alerts',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { alerts: Alert[] };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]?.level).toBe('P3');
  });
});

// ---------------------------------------------------------------------------
// Chi tiết một lần chạy job — "lỗi ở đâu, nguyên nhân gì"
// ---------------------------------------------------------------------------

const RUN_DETAIL: SyncRunDetail = {
  runId: '7',
  epicKey: 'PAY-1',
  runType: 'DAILY',
  status: 'FAILED',
  startedAt: '2026-03-10T00:01:00.000Z',
  finishedAt: '2026-03-10T00:02:00.000Z',
  durationSeconds: 60,
  apiCallsMade: 3,
  rateLimitHits: 0,
  daysComputed: 0,
  errorStep: 'FETCH_TREE',
  errorMessage: 'Jira trả 401: token hết hạn',
  errorDetail: 'Error: Jira trả 401\n    at fetchEpicTree (…)',
};

describe('registerOpsRoutes — chi tiết một lần chạy job', () => {
  it('KHÔNG mở route khi thiếu runDetail (deps tuỳ chọn)', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/admin/ops/runs/7' });
    expect(res.statusCode).toBe(404);
  });

  it('bản admin trả về bước lỗi + stack nguyên văn của lần chạy', async () => {
    const res = await build({ runDetail: () => Promise.resolve(RUN_DETAIL) }).inject({
      method: 'GET',
      url: '/api/admin/ops/runs/7',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SyncRunDetail;
    expect(body.errorStep).toBe('FETCH_TREE');
    expect(body.errorDetail).toContain('at fetchEpicTree');
  });

  it('lần chạy không tồn tại → 404 kèm câu chỉ dẫn, không phải 500', async () => {
    const res = await build({ runDetail: () => Promise.resolve(null) }).inject({
      method: 'GET',
      url: '/api/admin/ops/runs/999',
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('RUN_NOT_FOUND');
  });

  it('bản theo tenant chuyển projectKey xuống cổng — run của tenant khác thành 404', async () => {
    const asked: Array<[string, string | undefined]> = [];
    const instance = build({
      runDetail: (runId, projectKey) => {
        asked.push([runId, projectKey]);
        // Cổng thật lọc bằng SQL: run 7 thuộc CRM nên khi hỏi kèm PAY → null.
        return Promise.resolve(projectKey === 'PAY' ? null : RUN_DETAIL);
      },
    });
    principal = asPm('PAY');
    const res = await instance.inject({ method: 'GET', url: '/api/projects/PAY/ops/runs/7' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('RUN_NOT_FOUND');
    expect(asked).toEqual([['7', 'PAY']]);
  });
});

// ---------------------------------------------------------------------------
// Data quality chi tiết — danh sách ticket lỗi + đánh dấu "không cần sửa"
// ---------------------------------------------------------------------------

const DQ_ISSUE: DataQualityIssue = {
  issueKey: 'PAY-101',
  epicKey: 'PAY-1',
  epicDisplayName: 'Payment',
  summary: '[PAY][BE][DEV][Login]_Create',
  problems: ['MISSING_ESTIMATE', 'MISSING_WBS_DATE'],
  exempt: false,
  exemptBy: null,
};

function buildDq(over: {
  issueProject?: () => Promise<{ projectKey: string } | null>;
} = {}) {
  const calls: Array<{ issueKey: string; exempt: boolean; by: string }> = [];
  const askedIssueScopes: (string | undefined)[] = [];
  const instance = build({
    dataQuality: {
      issues: (projectKey) => {
        askedIssueScopes.push(projectKey);
        return Promise.resolve([DQ_ISSUE]);
      },
      issueProject: over.issueProject ?? (() => Promise.resolve({ projectKey: 'PAY' })),
      setExempt: (args) => {
        calls.push({ issueKey: args.issueKey, exempt: args.exempt, by: args.by });
        return Promise.resolve();
      },
    },
    resolvePrincipal: () => principal,
    now: () => new Date('2026-03-10T02:00:00.000Z'),
  });
  return { instance, calls, askedIssueScopes };
}

describe('registerOpsRoutes — danh sách ticket lỗi dữ liệu', () => {
  it('bản admin trả về từng ticket kèm loại lỗi và cờ exempt — nguồn của file CSV', async () => {
    const res = await buildDq().instance.inject({ method: 'GET', url: '/api/admin/ops/data-quality/issues' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { collectedAt: string; issues: DataQualityIssue[] };
    expect(body.collectedAt).toBe('2026-03-10T02:00:00.000Z');
    expect(body.issues[0]?.problems).toEqual(['MISSING_ESTIMATE', 'MISSING_WBS_DATE']);
  });

  it('bản theo tenant gọi cổng VỚI projectKey — không rò ticket của tenant khác', async () => {
    const { instance, askedIssueScopes } = buildDq();
    principal = asPm('PAY');
    const res = await instance.inject({ method: 'GET', url: '/api/projects/PAY/ops/data-quality/issues' });
    expect(res.statusCode).toBe(200);
    expect(askedIssueScopes).toEqual(['PAY']);
  });
});

describe('registerOpsRoutes — đánh dấu "không cần sửa dữ liệu"', () => {
  const putAdmin = (p: { body?: unknown; issueProject?: () => Promise<{ projectKey: string } | null> }) => {
    const { instance, calls } = buildDq(p);
    return {
      calls,
      res: instance.inject({
        method: 'PUT',
        url: '/api/admin/ops/data-quality/issues/PAY-101/exempt',
        payload: p.body ?? { exempt: true },
      }),
    };
  };

  it('chưa đăng nhập → 401, không ghi gì', async () => {
    principal = null;
    const { res, calls } = putAdmin({});
    expect((await res).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it('bản admin là của ADMIN: PM/VIEWER bị 403 ngay tại guard', async () => {
    for (const p of [asPm('PAY'), asViewer('PAY')]) {
      principal = p;
      const { res, calls } = putAdmin({});
      expect((await res).statusCode, p.userId).toBe(403);
      expect(calls).toEqual([]);
    }
  });

  it('ADMIN đánh dấu → 200 và ghi lại AI đánh dấu', async () => {
    const { res, calls } = putAdmin({});
    expect((await res).statusCode).toBe(200);
    expect(calls).toEqual([{ issueKey: 'PAY-101', exempt: true, by: 'admin@x.com' }]);
  });

  it('ADMIN gỡ đánh dấu bằng {"exempt": false} → cảnh báo hiện trở lại', async () => {
    const { res, calls } = putAdmin({ body: { exempt: false } });
    expect((await res).statusCode).toBe(200);
    expect(calls[0]?.exempt).toBe(false);
  });

  it('ticket không thuộc Epic nào đang theo dõi → 404', async () => {
    const { res } = putAdmin({ issueProject: () => Promise.resolve(null) });
    expect((await res).statusCode).toBe(404);
  });

  it('thân yêu cầu sai kiểu ({"exempt":"true"} có nháy) → 400, nói rõ dạng đúng', async () => {
    const { res } = putAdmin({ body: { exempt: 'true' } });
    expect((await res).statusCode).toBe(400);
  });

  it('PM đánh dấu được qua ĐƯỜNG DỰ ÁN khi ticket thuộc đúng tenant', async () => {
    const { instance, calls } = buildDq();
    principal = asPm('PAY');
    const res = await instance.inject({
      method: 'PUT',
      url: '/api/projects/PAY/ops/data-quality/issues/PAY-101/exempt',
      payload: { exempt: true },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ issueKey: 'PAY-101', exempt: true, by: 'pm@x.com' }]);
  });

  it('ticket của TENANT KHÁC qua đường dự án mình → 404, không ghi gì', async () => {
    const { instance, calls } = buildDq({
      issueProject: () => Promise.resolve({ projectKey: 'CRM' }),
    });
    principal = asPm('PAY');
    const res = await instance.inject({
      method: 'PUT',
      url: '/api/projects/PAY/ops/data-quality/issues/CRM-101/exempt',
      payload: { exempt: true },
    });
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
});
