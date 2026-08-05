import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  RECOMPUTE_SECONDS_PER_EPIC,
  resyncRequestSchema,
  type DateOnly,
  type EpicHealthResponse,
  type ExplainResponse,
  type HealthLevel,
  type PlanShiftHistoryResponse,
  type PlanShiftRecord,
  type Principal,
  type ResyncResponse,
  type StatusIdMap,
  type SubtaskRecord,
  type TrackedEpicStatus,
  type WorkCalendar,
} from '@app/shared';
import { listWorkdays } from '@app/engine';
import { ApiError } from '../services/phase-config.service.js';
import { assertTransition } from '../services/epic-registry.service.js';
import { buildEpicHealth, type HealthRatios } from '../services/epic-health.service.js';
import { explainDay } from '../services/explain-day.service.js';

/**
 * Bốn endpoint vận hành Epic — PRD Phụ lục B.
 *
 * Tầng này CHỈ điều phối. Toàn bộ tính toán nằm ở hai service thuần bên cạnh.
 */

export interface EpicOpsReadPort {
  epicMeta(epicKey: string): Promise<{
    projectKey: string;
    status: TrackedEpicStatus;
    lastSyncedAt: Date | null;
    lastError: string | null;
    calendar: WorkCalendar;
    firstSnapshotDate: DateOnly | null;
    lastSnapshotDate: DateOnly | null;
  } | null>;
  healthRatios(epicKey: string): Promise<HealthRatios>;
  snapshotDates(epicKey: string): Promise<ReadonlySet<string>>;
  /** `actual_remaining_s` của một ngày. `null` = ngày đó không có snapshot. */
  storedRemaining(epicKey: string, date: DateOnly): Promise<number | null>;
  /** Sub-task kèm đủ lịch sử để tính lại — cùng dữ liệu mà T-18 dùng. */
  subtasksWithHistory(epicKey: string): Promise<{
    subtasks: readonly SubtaskRecord[];
    summaries: Record<string, string>;
    statusIdMap: StatusIdMap;
    changeAuthors: Record<string, string | null>;
  }>;
  planShifts(epicKey: string): Promise<readonly (PlanShiftRecord & { detectedAt: Date })[]>;
  totalPlanWorkdays(epicKey: string): Promise<number>;
}

export interface EpicOpsWritePort {
  setStatus(epicKey: string, status: TrackedEpicStatus): Promise<void>;
  /** Đẩy job vào hàng đợi `sync`. Trả về `jobId` đã dùng. */
  enqueueSync(epicKey: string, args: { from: string | null; to: string | null; full: boolean }): Promise<string>;
}

export interface EpicOpsRouteDeps {
  readonly reads: EpicOpsReadPort;
  readonly writes: EpicOpsWritePort;
  resolvePrincipal(req: FastifyRequest): Principal | null;
}

/** Ngưỡng R-11: tổng số ngày lùi vượt 20% độ dài kế hoạch. */
export const PLAN_SHIFT_WARN_RATIO = 0.2;

export function planShiftLevel(totalShifted: number, planWorkdays: number): HealthLevel {
  if (planWorkdays <= 0) return 'OK';
  const ratio = totalShifted / planWorkdays;
  if (ratio > PLAN_SHIFT_WARN_RATIO * 2) return 'CRITICAL';
  if (ratio > PLAN_SHIFT_WARN_RATIO) return 'WARN';
  return 'OK';
}

export function registerEpicOpsRoutes(app: FastifyInstance, deps: EpicOpsRouteDeps): void {
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await reply.send(await fn());
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      app.log.error({ err }, 'Unexpected error in the Epic operations API');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const principalOf = (req: FastifyRequest): Principal => {
    const p = deps.resolvePrincipal(req);
    if (!p) throw new ApiError(401, 'UNAUTHENTICATED', 'This request has no signed-in user. Reload the page to sign in again.');
    return p;
  };

  async function metaOrThrow(epicKey: string) {
    const meta = await deps.reads.epicMeta(epicKey);
    if (meta === null) {
      throw new ApiError(
        404,
        'EPIC_NOT_FOUND',
        `Epic ${epicKey} is not tracked. Add it on the Epics screen first.`,
      );
    }
    return meta;
  }

  function assertCanRead(principal: Principal, projectKey: string): void {
    if (principal.role === 'ADMIN' || principal.role === 'VIEWER') return;
    if (principal.projects.includes(projectKey)) return;
    throw new ApiError(403, 'FORBIDDEN', `You are not assigned to project ${projectKey}.`);
  }

  /** Đồng bộ lại là thao tác GHI: người xem không được phép. */
  function assertCanOperate(principal: Principal, projectKey: string): void {
    if (principal.role === 'ADMIN') return;
    if (principal.role === 'PM' && principal.projects.includes(projectKey)) return;
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Only an Admin, or the PM assigned to project ${projectKey}, can trigger a resync. ` +
        'It uses the Jira rate limit shared by the whole system.',
    );
  }

  // -------------------------------------------------------------------------

  app.get('/api/epic/:epicKey/health', async (req, reply) =>
    handle(reply, async (): Promise<EpicHealthResponse> => {
      const epicKey = param(req, 'epicKey');
      const meta = await metaOrThrow(epicKey);
      assertCanRead(principalOf(req), meta.projectKey);

      const [ratios, snapshotDates] = await Promise.all([
        deps.reads.healthRatios(epicKey),
        deps.reads.snapshotDates(epicKey),
      ]);

      // Chỉ dò ngày thiếu TRONG khoảng đã từng có snapshot. Dò từ ngày tạo Epic
      // sẽ báo thiếu cả những ngày mà job đêm chưa từng chạy tới — đúng nhưng
      // vô dụng, và làm chìm mất những lỗ thủng thật.
      const workdays =
        meta.firstSnapshotDate === null || meta.lastSnapshotDate === null
          ? []
          : listWorkdays(meta.firstSnapshotDate, meta.lastSnapshotDate, meta.calendar);

      return buildEpicHealth({
        epicKey,
        status: meta.status,
        lastSyncedAt: meta.lastSyncedAt,
        lastError: meta.lastError,
        workdays,
        snapshotDates,
        ratios,
      });
    }),
  );

  app.get('/api/burndown/epic/:epicKey/day/:date/explain', async (req, reply) =>
    handle(reply, async (): Promise<ExplainResponse> => {
      const epicKey = param(req, 'epicKey');
      const date = dateParam(req);
      const meta = await metaOrThrow(epicKey);
      assertCanRead(principalOf(req), meta.projectKey);

      const stored = await deps.reads.storedRemaining(epicKey, date);
      if (stored === null) {
        // KHÔNG tính bù tại chỗ. Ngày thiếu snapshot là triệu chứng cần nhìn
        // thấy — tính bù sẽ che mất việc job đêm đang hỏng (E-12).
        throw new ApiError(
          404,
          'NO_SNAPSHOT',
          `${date} has no snapshot, so there is nothing to explain. ` +
            'Check "missing snapshot days" on /health, then click Resync to rebuild it.',
        );
      }

      const { subtasks, summaries, statusIdMap, changeAuthors } =
        await deps.reads.subtasksWithHistory(epicKey);

      return explainDay({
        epicKey,
        date,
        subtasks,
        summaries,
        calendar: meta.calendar,
        statusIdMap,
        storedRemainingSeconds: stored,
        changeAuthors,
      });
    }),
  );

  app.post('/api/epic/:epicKey/resync', async (req, reply) =>
    handle(reply, async (): Promise<ResyncResponse> => {
      const epicKey = param(req, 'epicKey');
      const meta = await metaOrThrow(epicKey);
      assertCanOperate(principalOf(req), meta.projectKey);

      const parsed = resyncRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        // Nói rõ TRƯỜNG NÀO sai và ví dụ đúng trông thế nào (C-9). Lệnh này hay
        // được gõ tay từ runbook, và `"full": "true"` có nháy kép là lỗi phổ biến
        // nhất — bị từ chối ở đây còn hơn được hiểu nhầm thành một thứ khác.
        const detail = parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `The request body is not valid — ${detail}. ` +
            'Valid examples: {"full": true} to rebuild the whole history, ' +
            'or {"from": "2026-03-01", "to": "2026-03-11"} to rebuild one date range. ' +
            '`full` must be true/false, not the string "true".',
        );
      }

      // Epic tạm dừng nghĩa là "đừng đồng bộ nữa" — đánh thức nó ở đây sẽ vô
      // hiệu hoá chính nút Tạm dừng mà PM vừa bấm.
      if (meta.status === 'PAUSED') {
        throw new ApiError(
          409,
          'EPIC_PAUSED',
          `Epic ${epicKey} is paused, so it cannot sync. ` +
            'Resume it on the Epics screen, then try again.',
        );
      }

      // Chỉ Epic đang LỖI hoặc CHỜ mới đổi trạng thái. Epic đang chạy bình
      // thường vẫn ở ACTIVE trong lúc đồng bộ lại — máy trạng thái của T-10 cố
      // ý không có nhánh ACTIVE → BACKFILLING, và đó là quyết định đúng.
      //
      // Luôn đi qua `assertTransition`, KHÔNG sửa `status` bằng tay: sửa tay sẽ
      // mở đường cho những chuyển trạng thái mà máy trạng thái cố ý cấm.
      if (meta.status === 'ERROR' || meta.status === 'PENDING') {
        assertTransition(meta.status, 'BACKFILLING');
        await deps.writes.setStatus(epicKey, 'BACKFILLING');
      }

      // Đẩy job rồi TRẢ VỀ NGAY. Chạy đồng bộ trong request sẽ timeout với
      // backfill 6 tháng, và PM tưởng thất bại rồi bấm lại.
      const jobId = await deps.writes.enqueueSync(epicKey, {
        from: parsed.data.from,
        to: parsed.data.to,
        full: parsed.data.full,
      });

      return { jobId, queued: true, estimatedSeconds: RECOMPUTE_SECONDS_PER_EPIC };
    }),
  );

  app.get('/api/epic/:epicKey/plan-shift-history', async (req, reply) =>
    handle(reply, async (): Promise<PlanShiftHistoryResponse> => {
      const epicKey = param(req, 'epicKey');
      const meta = await metaOrThrow(epicKey);
      assertCanRead(principalOf(req), meta.projectKey);

      const [raw, planWorkdays] = await Promise.all([
        deps.reads.planShifts(epicKey),
        deps.reads.totalPlanWorkdays(epicKey),
      ]);

      const shifts = [...raw]
        .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())
        .map((s) => ({
          phaseCode: s.phaseCode,
          shiftType: s.shiftType,
          fromDate: s.fromDate,
          toDate: s.toDate,
          shiftedWorkdays: s.shiftedWorkdays,
          causedByKeys: [...s.causedByKeys],
          detectedAt: s.detectedAt.toISOString(),
        }));

      // CHỈ cộng phần lùi ra xa. Trừ đi phần kéo sớm lên sẽ để một Phase về sớm
      // che mất một Phase đang trễ — đúng thứ R-11 sinh ra để phát hiện.
      const total = shifts
        .filter((s) => s.shiftedWorkdays > 0)
        .reduce((sum, s) => sum + s.shiftedWorkdays, 0);

      return {
        epicKey,
        shifts,
        totalShiftedWorkdays: total,
        warningLevel: planShiftLevel(total, planWorkdays),
      };
    }),
  );
}

function param(req: FastifyRequest, name: string): string {
  const value = (req.params as Record<string, string | undefined>)[name]?.trim();
  if (value === undefined || value === '') {
    throw new ApiError(400, 'BAD_REQUEST', `The URL is missing the "${name}" parameter.`);
  }
  return value;
}

function dateParam(req: FastifyRequest): DateOnly {
  const value = param(req, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, 'BAD_REQUEST', `Dates must look like YYYY-MM-DD, got "${value}".`);
  }
  return value;
}
