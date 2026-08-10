import type { FastifyInstance } from 'fastify';
import type { Alert, MetricsRegistry, OpsHealthResponse } from '@app/shared';

/**
 * Ba endpoint vận hành — PRD §9.5.
 *
 *   • `GET /metrics`  — Prometheus lấy số đo
 *   • `GET /healthz`  — bộ cân bằng tải hỏi "còn sống không"
 *   • `GET /api/epic/:epicKey/alerts` — cảnh báo P3 để giao diện hiện banner
 */

export interface HealthCheck {
  readonly name: string;
  /** Trả về `true` nếu thành phần đó còn khoẻ. Không được ném lỗi. */
  check(): Promise<boolean>;
}

export interface OpsRouteDeps {
  readonly registry: MetricsRegistry;
  /**
   * Gom MỌI số đo vận hành trong MỘT lần đọc — dashboard T-33 dùng.
   *
   * Để dashboard gọi sáu endpoint thì lúc hệ thống đang tải nặng chính nó lại
   * góp phần làm nặng thêm, đúng lúc không nên.
   */
  opsHealth(): Promise<OpsHealthResponse>;
  /**
   * Kiểm tra sức khoẻ cho `/healthz`. TUỲ CHỌN: điểm lắp ráp (`main.ts`) đã tự
   * mở `/healthz` bằng Prisma/Redis thật, nên khi dựng app thuần trong test/route
   * ta bỏ trống để KHÔNG khai trùng route (`FST_ERR_DUPLICATED_ROUTE`).
   */
  readonly checks?: readonly HealthCheck[];
  /** Cảnh báo mức P3 của một Epic, để giao diện hiện banner. TUỲ CHỌN — chưa có nơi gọi thì không mở route. */
  bannerAlerts?(epicKey: string): Promise<readonly Alert[]>;
}

export function registerOpsRoutes(app: FastifyInstance, deps: OpsRouteDeps): void {
  app.get('/metrics', async (_req, reply) => {
    await reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(deps.registry.render());
  });

  app.get('/api/ops/health', async (_req, reply) => {
    await reply.send(await deps.opsHealth());
  });

  // `/healthz` chỉ mở khi có bộ kiểm tra. Không có thì điểm lắp ráp tự lo —
  // khai hai lần cùng một route làm Fastify ném lỗi ngay lúc khởi động.
  const checks = deps.checks;
  if (checks !== undefined) {
    app.get('/healthz', async (_req, reply) => {
      const results = await Promise.all(
        checks.map(async (c) => {
          try {
            return { name: c.name, ok: await c.check() };
          } catch (err) {
            // Một thành phần ném lỗi nghĩa là nó KHÔNG khoẻ, không phải là chưa
            // biết. Nuốt lỗi rồi báo OK là kiểu nói dối tệ nhất ở endpoint này.
            app.log.warn({ component: c.name, err }, 'Kiểm tra sức khoẻ thất bại');
            return { name: c.name, ok: false };
          }
        }),
      );

      const healthy = results.every((r) => r.ok);
      // 503 để bộ cân bằng tải rút tiến trình này ra khỏi vòng quay.
      await reply.status(healthy ? 200 : 503).send({
        status: healthy ? 'ok' : 'degraded',
        components: Object.fromEntries(results.map((r) => [r.name, r.ok ? 'ok' : 'down'])),
      });
    });
  }

  // Banner cảnh báo P3: chỉ mở route khi đã có bộ đánh giá cảnh báo.
  const bannerAlerts = deps.bannerAlerts;
  if (bannerAlerts !== undefined) {
    app.get('/api/epic/:epicKey/alerts', async (req, reply) => {
      const epicKey = (req.params as { epicKey?: string }).epicKey ?? '';
      const alerts = await bannerAlerts(epicKey);
      // Chỉ P3 mới lên banner: P1 và P2 đã gọi người trực rồi, hiện thêm lên màn
      // hình của PM chỉ làm nhiễu.
      await reply.send({ epicKey, alerts: alerts.filter((a) => a.level === 'P3') });
    });
  }
}
