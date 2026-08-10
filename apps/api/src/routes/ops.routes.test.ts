import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MetricsRegistry, type Alert, type OpsHealthResponse } from '@app/shared';
import { registerOpsRoutes, type HealthCheck } from './ops.routes.js';
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
  },
  recentRuns: [],
  erroredEpics: [],
  planDrift: [],
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(over: {
  checks?: readonly HealthCheck[];
  bannerAlerts?: (epicKey: string) => Promise<readonly Alert[]>;
} = {}): FastifyInstance {
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
