import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  BurndownResponse,
  ChartMode,
  DateOnly,
  PhaseRollup,
  PlanShiftRecord,
  SnapshotRow,
  WorkCalendar,
} from '@app/shared';
import { listCalendarDays, listWorkdays } from '@app/engine';
import { ApiError } from '../services/phase-config.service.js';
import { resolveEpicInProject } from '../services/epic-scope.js';
import { projectCtxOf, type AuthzGuards } from '../adapters/project-scope.js';
import {
  assertComparablePhases,
  assertPhasesExist,
  buildChart,
  resolveRange,
} from '../services/burndown.service.js';
import { chartCacheKey, type ChartCache } from '../adapters/chart-cache.js';

/**
 * Ba endpoint biểu đồ Burndown, mount theo tenant:
 * `/api/projects/:projectKey/epics/:epicKey/burndown[...]`.
 *
 * Quyền: thành viên dự án (VIEWER trở lên) qua guard `requireProject('VIEWER')`
 * — không còn kiểu "VIEWER toàn cục xem tất cả". Epic phải thuộc đúng tenant
 * của URL (`resolveEpicInProject`), sai là 404 EPIC_NOT_FOUND.
 *
 * Tầng này CHỈ điều phối: đọc tham số, gọi cổng, gọi hàm thuần, đổi lỗi thành
 * mã HTTP. Không một dòng logic tính toán nào ở đây.
 */

export interface BurndownReadPort {
  /** Epic có tồn tại trong sổ theo dõi không, và thuộc project nào. */
  epicMeta(epicKey: string): Promise<{ projectKey: string; calendar: WorkCalendar } | null>;
  loadSnapshots(epicKey: string, from: DateOnly, to: DateOnly): Promise<readonly SnapshotRow[]>;
  /** Ngày snapshot mới nhất — nới trục qua `plan_end` khi Epic đã trễ. `null` = chưa có snapshot. */
  latestSnapshotDate(epicKey: string): Promise<DateOnly | null>;
  loadRollups(epicKey: string): Promise<readonly PhaseRollup[]>;
  loadPlanShifts(epicKey: string): Promise<readonly PlanShiftRecord[]>;
  /** Tỉ lệ dữ liệu bẩn, đếm bằng SQL chứ không duyệt trong bộ nhớ. */
  loadRatios(epicKey: string): Promise<{
    missingEstimateRatio: number;
    unclassifiedPhaseRatio: number;
    missingWbsDateRatio: number;
  }>;
  /** Nhãn và màu của Phase, lấy từ cấu hình đang hiệu lực. */
  phaseLabels(projectKey: string): Promise<Record<string, { label: string; colorHex: string | null }>>;
}

export interface BurndownRouteDeps {
  readonly reads: BurndownReadPort;
  readonly cache: ChartCache;
  readonly guards: AuthzGuards;
}

interface ChartRequest {
  readonly epicKey: string;
  readonly mode: ChartMode;
  readonly phaseCodes: readonly string[];
  readonly from: DateOnly | null;
  readonly to: DateOnly | null;
}

export function registerBurndownRoutes(app: FastifyInstance, deps: BurndownRouteDeps): void {
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await reply.send(await fn());
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      app.log.error({ err }, 'Unexpected error in the Burndown chart API');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const asViewer = { preHandler: deps.guards.requireProject('VIEWER') };

  async function buildResponse(req: FastifyRequest, args: ChartRequest): Promise<BurndownResponse> {
    // Guard đã kiểm quyền; ở đây chỉ còn kiểm Epic thuộc đúng tenant của URL.
    const meta = await resolveEpicInProject(
      (k) => deps.reads.epicMeta(k),
      args.epicKey,
      projectCtxOf(req).projectKey,
    );

    const rollups = await deps.reads.loadRollups(args.epicKey);

    if (args.mode === 'COMPARE') assertComparablePhases(args.phaseCodes, rollups);
    else if (args.mode === 'PHASE') assertPhasesExist(args.phaseCodes, rollups);

    // Trục ngang: chế độ một Phase CO LẠI đúng khoảng của Phase đó.
    const auto = resolveRange(args.mode, rollups, args.phaseCodes);
    const from = args.from ?? auto.from;
    let to = args.to ?? auto.to;

    // Epic đã TRỄ so với kế hoạch: đội vẫn làm tiếp sau `plan_end` nên snapshot
    // của hôm qua/hôm nay VẪN được dựng, nhưng trục lấy `plan_end` làm cận trên
    // đã cắt mất chúng — người xem tưởng biểu đồ ngừng vẽ từ mấy hôm trước. Nới
    // cận trên tới ngày snapshot mới nhất để phần "vượt kế hoạch" hiện ra.
    //
    // CHỈ ở chế độ Tổng Epic. Chế độ một Phase cố ý co về đúng khoảng kế hoạch
    // của Phase đó (PRD §5.1); nới theo snapshot mức Epic sẽ kéo dài đuôi phẳng
    // cho những Phase đã xong sớm. Và chỉ nới khi người dùng KHÔNG tự chọn `to`.
    if (args.mode === 'EPIC' && args.to === null && to !== null) {
      const latest = await deps.reads.latestSnapshotDate(args.epicKey);
      if (latest !== null && latest > to) to = latest;
    }

    if (from === null || to === null) {
      throw new ApiError(
        409,
        'NO_PLAN_DATES',
        'No sub-task in this Epic has planned dates, so there is no time axis to draw. ' +
          'Fill in wbs_start_date and wbs_end_date in Jira, then resync.',
      );
    }

    const cacheKey = chartCacheKey(
      args.epicKey,
      from,
      to,
      `${args.mode}:${[...args.phaseCodes].sort().join(',')}`,
    );
    const cached = await deps.cache.get<BurndownResponse>(cacheKey);
    if (cached !== null) return cached;

    const [snapshots, planShifts, ratios, labels] = await Promise.all([
      deps.reads.loadSnapshots(args.epicKey, from, to),
      deps.reads.loadPlanShifts(args.epicKey),
      deps.reads.loadRatios(args.epicKey),
      deps.reads.phaseLabels(meta.projectKey),
    ]);

    const response = buildChart({
      epicKey: args.epicKey,
      mode: args.mode,
      workdays: listWorkdays(from, to, meta.calendar),
      // Trục vẽ đủ ngày lịch (2026-08): ngày nghỉ bôi xám, và snapshot cuối
      // tuần (nếu team có làm) hiện đúng ngày trên đường Thực tế.
      days: listCalendarDays(from, to, meta.calendar.timezone),
      calendar: meta.calendar,
      snapshots,
      rollups,
      planShifts,
      phaseCodes: args.phaseCodes,
      labels,
      ratios,
    });

    await deps.cache.set(cacheKey, response);
    return response;
  }

  app.get('/api/projects/:projectKey/epics/:epicKey/burndown', asViewer, async (req, reply) =>
    handle(reply, () =>
      buildResponse(req, {
        epicKey: paramEpicKey(req),
        mode: 'EPIC',
        phaseCodes: [],
        from: dateQuery(req, 'from'),
        to: dateQuery(req, 'to'),
      }),
    ),
  );

  app.get(
    '/api/projects/:projectKey/epics/:epicKey/burndown/phase/:phaseCode',
    asViewer,
    async (req, reply) =>
      handle(reply, () => {
        const phaseCode = (req.params as { phaseCode?: string }).phaseCode ?? '';
        return buildResponse(req, {
          epicKey: paramEpicKey(req),
          mode: 'PHASE',
          phaseCodes: [phaseCode],
          from: dateQuery(req, 'from'),
          to: dateQuery(req, 'to'),
        });
      }),
  );

  app.get(
    '/api/projects/:projectKey/epics/:epicKey/burndown/phases/compare',
    asViewer,
    async (req, reply) =>
      handle(reply, () => {
        const raw = (req.query as { codes?: string }).codes ?? '';
        const codes = raw
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c !== '');
        return buildResponse(req, {
          epicKey: paramEpicKey(req),
          mode: 'COMPARE',
          phaseCodes: codes,
          from: dateQuery(req, 'from'),
          to: dateQuery(req, 'to'),
        });
      }),
  );
}

function paramEpicKey(req: FastifyRequest): string {
  const key = (req.params as { epicKey?: string }).epicKey?.trim();
  if (key === undefined || key === '') {
    throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the Epic key.');
  }
  return key;
}

/** `?from=` và `?to=` là tuỳ chọn; sai định dạng phải báo ngay, không im lặng bỏ qua. */
function dateQuery(req: FastifyRequest, name: 'from' | 'to'): DateOnly | null {
  const raw = (req.query as Record<string, unknown>)[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Parameter "${name}" must look like YYYY-MM-DD, got "${value}".`,
    );
  }
  return value;
}
