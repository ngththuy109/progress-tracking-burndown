import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  dqExemptRequestSchema,
  type Alert,
  type DataQualityIssue,
  type MetricsRegistry,
  type OpsHealthResponse,
  type Principal,
  type SyncRunDetail,
} from '@app/shared';
import { projectCtxOf, type AuthzGuards } from '../adapters/project-scope.js';

/**
 * Các endpoint vận hành — PRD §9.5 + màn hình Monitoring (T-33) — sau Phase B:
 *
 *   • `GET /metrics`                 — Prometheus lấy số đo (không auth — nội bộ)
 *   • `GET /healthz`                 — bộ cân bằng tải hỏi "còn sống không"
 *   • `GET /api/admin/ops/health`    — dashboard toàn hệ thống, CHỈ ADMIN
 *   • `GET /api/admin/ops/runs/:runId`                — chi tiết một lần chạy job
 *   • `GET /api/admin/ops/data-quality/issues`        — từng ticket lỗi dữ liệu
 *   • `PUT /api/admin/ops/data-quality/issues/:issueKey/exempt` — đánh dấu bỏ qua
 *   • `/api/projects/:projectKey/ops/...` — CÙNG các đường con, nhưng mọi số đo
 *     đã BÓ trong một tenant (PM của dự án đó): run của tenant khác là 404,
 *     ticket lỗi của tenant khác không bao giờ xuất hiện.
 *
 * Dashboard toàn cục gom số liệu của MỌI tenant (tên Epic, lỗi, chất lượng dữ
 * liệu) nên thuộc ADMIN; PM chỉ còn cửa sổ đã bó theo dự án của mình.
 */

export interface HealthCheck {
  readonly name: string;
  /** Trả về `true` nếu thành phần đó còn khoẻ. Không được ném lỗi. */
  check(): Promise<boolean>;
}

export interface OpsRouteDeps {
  readonly registry: MetricsRegistry;
  readonly guards: AuthzGuards;
  /**
   * Gom MỌI số đo vận hành trong MỘT lần đọc — dashboard T-33 dùng.
   *
   * Để dashboard gọi sáu endpoint thì lúc hệ thống đang tải nặng chính nó lại
   * góp phần làm nặng thêm, đúng lúc không nên.
   */
  opsHealth(projectKey?: string): Promise<OpsHealthResponse>;
  /**
   * Kiểm tra sức khoẻ cho `/healthz`. TUỲ CHỌN: điểm lắp ráp (`main.ts`) đã tự
   * mở `/healthz` bằng Prisma/Redis thật, nên khi dựng app thuần trong test/route
   * ta bỏ trống để KHÔNG khai trùng route (`FST_ERR_DUPLICATED_ROUTE`).
   */
  readonly checks?: readonly HealthCheck[];
  /** Cảnh báo mức P3 của một Epic, để giao diện hiện banner. TUỲ CHỌN — chưa có nơi gọi thì không mở route. */
  bannerAlerts?(epicKey: string): Promise<readonly Alert[]>;
  /** Chi tiết một lần chạy job; kèm `projectKey` = bó trong tenant (khác → null). TUỲ CHỌN — thiếu thì không mở route. */
  runDetail?(runId: string, projectKey?: string): Promise<SyncRunDetail | null>;
  /** Ba cổng của phần Data quality chi tiết. TUỲ CHỌN — thiếu thì không mở route. */
  readonly dataQuality?: {
    issues(projectKey?: string): Promise<readonly DataQualityIssue[]>;
    issueProject(issueKey: string): Promise<{ projectKey: string } | null>;
    setExempt(args: { issueKey: string; exempt: boolean; by: string; at: Date }): Promise<void>;
  };
  /** Ai đang gọi — ghi `by` khi đánh dấu exempt. */
  resolvePrincipal?(req: FastifyRequest): Principal | null;
  /** Đồng hồ đi qua cổng để test đóng băng được. */
  readonly now?: () => Date;
}

export function registerOpsRoutes(app: FastifyInstance, deps: OpsRouteDeps): void {
  const admin = { preHandler: deps.guards.requireAdmin };
  const asPm = { preHandler: deps.guards.requireProject('PM') };

  app.get('/metrics', async (_req, reply) => {
    await reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(deps.registry.render());
  });

  app.get('/api/admin/ops/health', admin, async (_req, reply) => {
    await reply.send(await deps.opsHealth());
  });

  // Cửa sổ ops của MỘT tenant — cùng shape response, nhưng mọi số đo đã lọc
  // theo project của URL nên PM không đọc được Epic/lỗi của tenant khác.
  app.get('/api/projects/:projectKey/ops/health', asPm, async (req, reply) => {
    await reply.send(await deps.opsHealth(projectCtxOf(req).projectKey));
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

  // Chi tiết một lần chạy job: dòng FAILED ở bảng Recent runs dẫn tới đây để
  // trả lời "lỗi ở bước nào, nguyên nhân gì" thay vì chỉ một dòng error_message.
  const runDetail = deps.runDetail;
  if (runDetail !== undefined) {
    const sendDetail = async (
      reply: FastifyReply,
      runId: string,
      detail: SyncRunDetail | null,
    ): Promise<void> => {
      if (detail === null) {
        await reply.status(404).send({
          error: 'RUN_NOT_FOUND',
          message: `Job run ${runId} does not exist. It may have been pruned — reload the Monitoring screen.`,
        });
        return;
      }
      await reply.send(detail);
    };

    app.get('/api/admin/ops/runs/:runId', admin, async (req, reply) => {
      const runId = (req.params as { runId?: string }).runId ?? '';
      await sendDetail(reply, runId, await runDetail(runId));
    });

    // Run của tenant khác trả về CÙNG 404 như run không tồn tại — không dò được.
    app.get('/api/projects/:projectKey/ops/runs/:runId', asPm, async (req, reply) => {
      const runId = (req.params as { runId?: string }).runId ?? '';
      await sendDetail(reply, runId, await runDetail(runId, projectCtxOf(req).projectKey));
    });
  }

  const dataQuality = deps.dataQuality;
  if (dataQuality !== undefined) {
    const now = deps.now ?? (() => new Date());

    // Danh sách TỪNG ticket lỗi dữ liệu — nguồn của bảng chi tiết và file CSV.
    app.get('/api/admin/ops/data-quality/issues', admin, async (_req, reply) => {
      await reply.send({ collectedAt: now().toISOString(), issues: await dataQuality.issues() });
    });

    app.get('/api/projects/:projectKey/ops/data-quality/issues', asPm, async (req, reply) => {
      await reply.send({
        collectedAt: now().toISOString(),
        issues: await dataQuality.issues(projectCtxOf(req).projectKey),
      });
    });

    // Đánh dấu "không cần sửa dữ liệu" — nó tắt một cảnh báo chất lượng dữ liệu
    // cho tất cả mọi người. `scopeProject`: bản theo tenant phải kiểm ticket
    // THUỘC đúng tenant của URL; khác tenant trả cùng 404 như không tồn tại.
    const exemptHandler = (scopeProject: (req: FastifyRequest) => string | null) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
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
        const scope = scopeProject(req);
        if (found === null || (scope !== null && found.projectKey !== scope)) {
          await reply.status(404).send({
            error: 'ISSUE_NOT_FOUND',
            message: `Sub-task ${issueKey} is not in any tracked Epic. Reload the list and try again.`,
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
      };

    app.put(
      '/api/admin/ops/data-quality/issues/:issueKey/exempt',
      admin,
      exemptHandler(() => null),
    );
    app.put(
      '/api/projects/:projectKey/ops/data-quality/issues/:issueKey/exempt',
      asPm,
      exemptHandler((req) => projectCtxOf(req).projectKey),
    );
  }

  // Banner cảnh báo P3: chỉ mở route khi đã có bộ đánh giá cảnh báo.
  const bannerAlerts = deps.bannerAlerts;
  if (bannerAlerts !== undefined) {
    app.get(
      '/api/projects/:projectKey/epics/:epicKey/alerts',
      { preHandler: deps.guards.requireProject('VIEWER') },
      async (req, reply) => {
        const epicKey = (req.params as { epicKey?: string }).epicKey ?? '';
        const alerts = await bannerAlerts(epicKey);
        // Chỉ P3 mới lên banner: P1 và P2 đã gọi người trực rồi, hiện thêm lên màn
        // hình của PM chỉ làm nhiễu.
        await reply.send({ epicKey, alerts: alerts.filter((a) => a.level === 'P3') });
      },
    );
  }
}
