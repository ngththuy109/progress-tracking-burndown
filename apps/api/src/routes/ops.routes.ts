import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  dqExemptRequestSchema,
  type Alert,
  type DataQualityIssue,
  type MetricsRegistry,
  type OpsHealthResponse,
  type Principal,
  type SyncRunDetail,
} from '@app/shared';

/**
 * Các endpoint vận hành — PRD §9.5 + màn hình Monitoring (T-33).
 *
 *   • `GET /metrics`  — Prometheus lấy số đo
 *   • `GET /healthz`  — bộ cân bằng tải hỏi "còn sống không"
 *   • `GET /api/epic/:epicKey/alerts` — cảnh báo P3 để giao diện hiện banner
 *   • `GET /api/ops/runs/:runId` — chi tiết một lần chạy job (bước lỗi, stack)
 *   • `GET /api/ops/data-quality/issues` — từng ticket lỗi dữ liệu (để xuất file)
 *   • `PUT /api/ops/data-quality/issues/:issueKey/exempt` — đánh dấu "không cần sửa"
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
  /** Chi tiết một lần chạy job. TUỲ CHỌN — thiếu thì không mở route. */
  runDetail?(runId: string): Promise<SyncRunDetail | null>;
  /** Ba cổng của phần Data quality chi tiết. TUỲ CHỌN — thiếu thì không mở route. */
  readonly dataQuality?: {
    issues(): Promise<readonly DataQualityIssue[]>;
    issueProject(issueKey: string): Promise<{ projectKey: string } | null>;
    setExempt(args: { issueKey: string; exempt: boolean; by: string; at: Date }): Promise<void>;
  };
  /** Cần cho route GHI (đánh dấu exempt) — chỉ ADMIN hoặc PM của project đó. */
  resolvePrincipal?(req: FastifyRequest): Principal | null;
  /** Đồng hồ đi qua cổng để test đóng băng được. */
  readonly now?: () => Date;
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
            app.log.warn({ component: c.name, err }, 'Health check failed');
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

  // Chi tiết một lần chạy job: dòng FAILED ở bảng Recent runs dẫn tới đây để
  // trả lời "lỗi ở bước nào, nguyên nhân gì" thay vì chỉ một dòng error_message.
  const runDetail = deps.runDetail;
  if (runDetail !== undefined) {
    app.get('/api/ops/runs/:runId', async (req, reply) => {
      const runId = (req.params as { runId?: string }).runId ?? '';
      const detail = await runDetail(runId);
      if (detail === null) {
        await reply.status(404).send({
          error: 'RUN_NOT_FOUND',
          message: `Job run ${runId} does not exist. It may have been pruned — reload the Monitoring screen.`,
        });
        return;
      }
      await reply.send(detail);
    });
  }

  const dataQuality = deps.dataQuality;
  if (dataQuality !== undefined) {
    const now = deps.now ?? (() => new Date());

    // Danh sách TỪNG ticket lỗi dữ liệu — nguồn của bảng chi tiết và file CSV.
    app.get('/api/ops/data-quality/issues', async (_req, reply) => {
      await reply.send({ collectedAt: now().toISOString(), issues: await dataQuality.issues() });
    });

    // Đánh dấu "không cần sửa dữ liệu" là thao tác GHI: chỉ ADMIN, hoặc PM của
    // đúng project chứa ticket. Viewer nhìn thấy nút nhưng API vẫn tự chặn.
    app.put('/api/ops/data-quality/issues/:issueKey/exempt', async (req, reply) => {
      const principal = deps.resolvePrincipal?.(req) ?? null;
      if (principal === null) {
        await reply.status(401).send({
          error: 'UNAUTHENTICATED',
          message: 'This request has no signed-in user. Reload the page to sign in again.',
        });
        return;
      }

      const parsed = dqExemptRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        await reply.status(400).send({
          error: 'BAD_REQUEST',
          message: 'The request body is not valid — send {"exempt": true} or {"exempt": false}.',
        });
        return;
      }

      const issueKey = ((req.params as { issueKey?: string }).issueKey ?? '').trim();
      const found = await dataQuality.issueProject(issueKey);
      if (found === null) {
        await reply.status(404).send({
          error: 'ISSUE_NOT_FOUND',
          message: `Sub-task ${issueKey} is not in any tracked Epic. Reload the list and try again.`,
        });
        return;
      }

      const allowed =
        principal.role === 'ADMIN' ||
        (principal.role === 'PM' && principal.projects.includes(found.projectKey));
      if (!allowed) {
        await reply.status(403).send({
          error: 'FORBIDDEN',
          message:
            `Only an Admin, or the PM assigned to project ${found.projectKey}, can mark a sub-task as ` +
            '"no data fix needed" — it silences a data-quality warning for everyone.',
        });
        return;
      }

      await dataQuality.setExempt({
        issueKey,
        exempt: parsed.data.exempt,
        by: principal.userId,
        at: now(),
      });
      await reply.send({ issueKey, exempt: parsed.data.exempt });
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
