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

/**
 * Bug "Màn hình Monitoring 404" — `GET /api/ops/health` không được LẮP.
 *
 * `registerOpsRoutes` và cổng `opsHealth()` đã có sẵn nhưng `createServer` chưa
 * bao giờ gọi, nên endpoint trả 404 "Route GET:/api/ops/health not found" và cả
 * dashboard giám sát chết. Test này đi qua CHÍNH `registerOpsRoutes` và inject
 * request thật, nên chạy được không cần PostgreSQL.
 *
 * Đồng thời canh cạm bẫy lắp ráp: `main.ts` đã tự mở `/healthz` bằng Prisma/Redis
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
    closedNoWorklogRatio: 0.05,
    closeLagRatio: 0.05,
  },
  dataByEpic: [],
  recentRuns: [],
  erroredEpics: [],
  planDrift: [],
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(over: Partial<OpsRouteDeps> = {}): FastifyInstance {
  app = Fastify();
  registerOpsRoutes(app, {
    registry: new MetricsRegistry(),
    opsHealth: () => Promise.resolve(SAMPLE),
    ...over,
  });
  return app;
}

describe('registerOpsRoutes — endpoint dashboard được LẮP', () => {
  it('GET /api/ops/health trả 200 với đủ bốn nhóm số liệu (KHÔNG còn 404)', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/ops/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OpsHealthResponse;
    expect(body.collectedAt).toBe('2026-03-10T02:00:00.000Z');
    expect(body.jobs).toBeDefined();
    expect(body.jira).toBeDefined();
    expect(body.data).toBeDefined();
    expect(body.planDrift).toBeDefined();
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

  it('KHÔNG mở /api/epic/:key/alerts khi thiếu bannerAlerts', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/epic/PAY-1/alerts' });
    expect(res.statusCode).toBe(404);
  });

  it('mở /api/epic/:key/alerts khi CÓ bannerAlerts, và chỉ giữ cảnh báo P3', async () => {
    const alerts: Alert[] = [
      { code: 'MISSING_WBS_DATE', level: 'P3', epicKey: 'PAY-1', message: 'x', value: 1, threshold: 0 },
      { code: 'JOB_FAILED', level: 'P1', epicKey: 'PAY-1', message: 'y', value: 1, threshold: 0 },
    ];
    const res = await build({ bannerAlerts: () => Promise.resolve(alerts) }).inject({
      method: 'GET',
      url: '/api/epic/PAY-1/alerts',
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

describe('registerOpsRoutes — GET /api/ops/runs/:runId', () => {
  it('KHÔNG mở route khi thiếu runDetail (deps tuỳ chọn)', async () => {
    const res = await build().inject({ method: 'GET', url: '/api/ops/runs/7' });
    expect(res.statusCode).toBe(404);
  });

  it('trả về bước lỗi + stack nguyên văn của lần chạy', async () => {
    const res = await build({ runDetail: () => Promise.resolve(RUN_DETAIL) }).inject({
      method: 'GET',
      url: '/api/ops/runs/7',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SyncRunDetail;
    expect(body.errorStep).toBe('FETCH_TREE');
    expect(body.errorDetail).toContain('at fetchEpicTree');
  });

  it('lần chạy không tồn tại → 404 kèm câu chỉ dẫn, không phải 500', async () => {
    const res = await build({ runDetail: () => Promise.resolve(null) }).inject({
      method: 'GET',
      url: '/api/ops/runs/999',
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('RUN_NOT_FOUND');
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

const ADMIN: Principal = { userId: 'admin@x.vn', role: 'ADMIN', projects: [] };
const PM_PAY: Principal = { userId: 'pm@x.vn', role: 'PM', projects: ['PAY'] };
const VIEWER: Principal = { userId: 'viewer@x.vn', role: 'VIEWER', projects: [] };

function buildDq(over: {
  principal?: Principal | null;
  issueProject?: () => Promise<{ projectKey: string } | null>;
} = {}) {
  const calls: Array<{ issueKey: string; exempt: boolean; by: string }> = [];
  const instance = build({
    dataQuality: {
      issues: () => Promise.resolve([DQ_ISSUE]),
      issueProject: over.issueProject ?? (() => Promise.resolve({ projectKey: 'PAY' })),
      setExempt: (args) => {
        calls.push({ issueKey: args.issueKey, exempt: args.exempt, by: args.by });
        return Promise.resolve();
      },
    },
    resolvePrincipal: () => over.principal ?? null,
    now: () => new Date('2026-03-10T02:00:00.000Z'),
  });
  return { instance, calls };
}

describe('registerOpsRoutes — GET /api/ops/data-quality/issues', () => {
  it('trả về từng ticket kèm loại lỗi và cờ exempt — nguồn của file CSV', async () => {
    const res = await buildDq().instance.inject({ method: 'GET', url: '/api/ops/data-quality/issues' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { collectedAt: string; issues: DataQualityIssue[] };
    expect(body.collectedAt).toBe('2026-03-10T02:00:00.000Z');
    expect(body.issues[0]?.problems).toEqual(['MISSING_ESTIMATE', 'MISSING_WBS_DATE']);
  });
});

describe('registerOpsRoutes — PUT /api/ops/data-quality/issues/:key/exempt', () => {
  const put = (p: { principal?: Principal | null; body?: unknown; issueProject?: () => Promise<{ projectKey: string } | null> }) => {
    const { instance, calls } = buildDq(p);
    return {
      calls,
      res: instance.inject({
        method: 'PUT',
        url: '/api/ops/data-quality/issues/PAY-101/exempt',
        payload: p.body ?? { exempt: true },
      }),
    };
  };

  it('chưa đăng nhập → 401, không ghi gì', async () => {
    const { res, calls } = put({ principal: null });
    expect((await res).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it('VIEWER → 403: tắt cảnh báo là quyết định của người chịu trách nhiệm dữ liệu', async () => {
    const { res } = put({ principal: VIEWER });
    expect((await res).statusCode).toBe(403);
  });

  it('PM đúng project → 200 và ghi lại AI đánh dấu', async () => {
    const { res, calls } = put({ principal: PM_PAY });
    expect((await res).statusCode).toBe(200);
    expect(calls).toEqual([{ issueKey: 'PAY-101', exempt: true, by: 'pm@x.vn' }]);
  });

  it('ADMIN gỡ đánh dấu bằng {"exempt": false} → cảnh báo hiện trở lại', async () => {
    const { res, calls } = put({ principal: ADMIN, body: { exempt: false } });
    expect((await res).statusCode).toBe(200);
    expect(calls[0]?.exempt).toBe(false);
  });

  it('ticket không thuộc Epic nào đang theo dõi → 404', async () => {
    const { res } = put({ principal: ADMIN, issueProject: () => Promise.resolve(null) });
    expect((await res).statusCode).toBe(404);
  });

  it('thân yêu cầu sai kiểu ({"exempt":"true"} có nháy) → 400, nói rõ dạng đúng', async () => {
    const { res } = put({ principal: ADMIN, body: { exempt: 'true' } });
    expect((await res).statusCode).toBe(400);
  });
});
