import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { METRIC, type MetricsRegistry } from '@app/shared';

/**
 * Số đo HTTP — PRD §9.5.
 *
 * NHÃN `route` PHẢI LÀ MẪU ĐƯỜNG DẪN (`/api/burndown/epic/:epicKey`), KHÔNG
 * PHẢI ĐƯỜNG DẪN THẬT. Dùng đường dẫn thật thì mỗi Epic sinh một chuỗi số đo
 * riêng; 50 Epic × 4 endpoint × 5 mã trạng thái là hàng nghìn chuỗi, và
 * Prometheus sẽ nổ — thường vào đúng lúc hệ thống đang tải nặng nhất.
 */

/**
 * Lấy mẫu đường dẫn từ request.
 *
 * Fastify để mẫu ở `req.routeOptions.url`. Không có (404, hoặc phiên bản cũ)
 * thì trả `unknown` — MỘT nhãn cố định, tuyệt đối không rơi về `req.url`.
 */
export function routeLabel(req: { routeOptions?: { url?: string | undefined } | undefined }): string {
  const pattern = req.routeOptions?.url;
  return typeof pattern === 'string' && pattern !== '' ? pattern : 'unknown';
}

export function registerHttpMetrics(app: FastifyInstance, registry: MetricsRegistry): void {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    registry.observe(
      METRIC.httpRequestDuration,
      'HTTP request processing time, in seconds',
      // `elapsedTime` của Fastify tính bằng mili-giây.
      reply.elapsedTime / 1000,
      {
        route: routeLabel(req),
        method: req.method,
        status_code: String(reply.statusCode),
      },
    );
  });
}

/** Đếm trúng/trượt cache biểu đồ. Hai số riêng biệt, không phải một tỉ lệ. */
export function recordCacheOutcome(registry: MetricsRegistry, hit: boolean): void {
  // Ghi sẵn tỉ lệ thì mất khả năng cộng dồn giữa nhiều tiến trình; Prometheus
  // muốn hai bộ đếm thô rồi tự chia.
  if (hit) registry.increment(METRIC.chartCacheHits, 'Chart cache hits');
  else registry.increment(METRIC.chartCacheMisses, 'Chart cache misses');
}
