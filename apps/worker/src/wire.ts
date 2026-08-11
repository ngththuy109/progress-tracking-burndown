import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  CalendarCache,
  DEFAULT_PHASE_CONFIG,
  findActiveConfigSet,
  findByKey,
  findManyByKeys,
  findProjectConnection,
  getCalendar,
  listActiveEpics,
  toDateString,
  type PrismaClient,
} from '@app/db';
import type { JiraClientRegistry, ProjectJiraContext } from '@app/jira';
import { listWorkdays, localDateOf, mergeInheritance } from '@app/engine';
import {
  parseSyncJobPayload,
  type ConfigPayload,
  type DateOnly,
  type EffectiveConfig,
  type IssueTotals,
} from '@app/shared';
import { addReplacingFinished, createQueues, jobIdFor, type QueueSet } from './queue/queues.js';
import { QUEUE_NAME } from './queue/queues.js';
import { JOB_NAME, createSyncWorker, type HandlerMap } from './queue/worker.js';
import { fetchRootTree } from './pipeline/fetch-epic-tree.js';
import { syncEpic, type SyncEpicDeps } from './jobs/sync-epic.job.js';
import { reconstructEpic, type ReconstructDeps } from './jobs/reconstruct-epic.job.js';
import { reconcileEpic, type ReconcileDeps } from './jobs/reconcile-epic.job.js';
import { sweepDirtyEpics } from './jobs/dirty-epics-sweep.job.js';
import { handleSyncJob, type SyncJobDeps } from './jobs/handle-sync-job.js';
import { resolveRebuildRange } from './jobs/rebuild-range.js';
import {
  createChangelogWritePort,
  createDirtyEpicQueuePort,
  createDirtySweepStorePort,
  createEpicStatePort,
  createIssueWritePort,
  createReconcileReadPort,
  createReconstructPorts,
  createSyncRunPort,
  createWorklogWritePort,
} from './adapters/store.adapters.js';

/**
 * Đấu nối cổng job vào hạ tầng thật — tầng adapter production của worker.
 *
 * `server.ts`/`main.ts` là điểm lắp ráp Ở CẤP TIẾN TRÌNH (env, kết nối). File này
 * là điểm lắp ráp Ở CẤP JOB: nó biết mỗi tên job gọi hàm nghiệp vụ nào và cổng
 * của hàm đó nối vào repo/Jira/engine ra sao. Bản thân logic job đã có test với
 * kho giả; ở đây chỉ ghép chúng vào Prisma/Redis/Jira thật.
 */

// Job "quét" chạy theo LỊCH (không theo Epic): liệt kê Epic ACTIVE rồi đẩy job
// con cho từng Epic. Chạy trên hàng đợi tương ứng, cùng bảng điều phối.
const NIGHTLY_SWEEP = 'nightly-sweep';
const WEEKLY_RECONCILE_SWEEP = 'weekly-reconcile-sweep';
// Quét `dirty:epics` (PRD §2.2.7, §4.7): nhặt Epic bị đánh dấu cần tính lại
// (đổi Phase settings, worklog lùi ngày, mất khoá) và đẩy backfill toàn bộ.
const DIRTY_EPICS_SWEEP = 'dirty-epics-sweep';

export interface WireDeps {
  readonly prisma: PrismaClient;
  /** Kết nối đẩy job (createQueues). */
  readonly queueConn: Redis;
  /** Kết nối cho các Worker (BullMQ tự nhân bản cho chế độ chờ). */
  readonly workerConn: Redis;
  /** Kết nối chung: khoá, token bucket, dirty:epics, cache, status map. */
  readonly generalConn: Redis;
  /**
   * Registry client Jira THEO DỰ ÁN (multi-tenant). Thay cho JiraClient toàn
   * cục cũ: mỗi job tự hỏi registry lấy client + field mapping + status map
   * của đúng tenant nó phục vụ. Khởi động KHÔNG còn chạm Jira.
   */
  readonly registry: JiraClientRegistry;
  readonly log: (event: Record<string, unknown>) => void;
  readonly nightlyCron: string;
  readonly weeklyReconcileCron: string;
  readonly dirtySweepCron: string;
}

export interface WiredWorker {
  readonly workers: readonly Worker[];
  readonly queues: QueueSet;
}

interface JobContext {
  readonly prisma: PrismaClient;
  readonly generalConn: Redis;
  /**
   * Registry theo dự án — client/fields/statusIdMap KHÔNG còn nằm ở cấp tiến
   * trình; `loadEpicContext` lấy chúng cho đúng tenant của từng job.
   *
   * Status map giờ cache theo khoá `meta:statuscategory:<projectKey>` (registry
   * tự lo). Khoá toàn cục cũ `meta:statuscategory` đã CHẾT — không ai đọc nữa,
   * tự hết hạn theo TTL 24h (ghi chú deploy nằm trong plan multi-tenant).
   */
  readonly registry: JiraClientRegistry;
  readonly calendarCache: CalendarCache;
  readonly queues: QueueSet;
  readonly log: (event: Record<string, unknown>) => void;
  readonly now: () => Date;
}

/**
 * Dựng bảng điều phối rồi chạy một Worker cho mỗi hàng đợi.
 *
 * KHÔNG chạm Jira lúc khởi động: field mapping + status map giờ thuộc về từng
 * tenant và được registry nạp lười ở lần job đầu tiên của mỗi dự án — một
 * tenant cấu hình sai không được phép chặn worker phục vụ các tenant còn lại.
 */
export async function wireWorker(deps: WireDeps): Promise<WiredWorker> {
  const { prisma, registry, log } = deps;
  const now = (): Date => new Date();

  const queues = createQueues(deps.queueConn);

  const ctx: JobContext = {
    prisma,
    generalConn: deps.generalConn,
    registry,
    calendarCache: new CalendarCache(),
    queues,
    log,
    now,
  };

  const handlers: HandlerMap = {
    [JOB_NAME.syncEpic]: (payload) => runSyncJob(ctx, payload),
    // Backfill = đồng bộ đọc lại toàn bộ + dựng lại toàn bộ. Ép `full` vào payload
    // vì API đẩy job chỉ kèm `{epicKey}`.
    [JOB_NAME.backfillEpic]: (payload) => runSyncJob(ctx, withFull(payload)),
    [JOB_NAME.reconstructEpic]: (payload) => runReconstructJob(ctx, payload),
    [JOB_NAME.reconcileEpic]: (payload) => runReconcileJob(ctx, payload),
    [NIGHTLY_SWEEP]: () => runNightlySweep(ctx),
    [WEEKLY_RECONCILE_SWEEP]: () => runWeeklyReconcileSweep(ctx),
    [DIRTY_EPICS_SWEEP]: () => runDirtyEpicsSweep(ctx),
  };

  // Một Worker cho mỗi hàng đợi. BullMQ tự nhân bản kết nối cho client chờ, nên
  // ba Worker dùng chung một `workerConn` là an toàn.
  const workers = [
    createSyncWorker({ connection: deps.workerConn, handlers, log, queueName: QUEUE_NAME.sync }),
    createSyncWorker({ connection: deps.workerConn, handlers, log, queueName: QUEUE_NAME.backfill }),
    createSyncWorker({ connection: deps.workerConn, handlers, log, queueName: QUEUE_NAME.reconcile }),
  ];

  // Lịch tự động (BullMQ job scheduler): job quét đêm trên hàng đợi sync, quét
  // đối soát tuần trên hàng đợi reconcile. Worker của từng hàng đợi tự nhặt.
  await queues.sync.upsertJobScheduler(
    NIGHTLY_SWEEP,
    { pattern: deps.nightlyCron },
    { name: NIGHTLY_SWEEP, data: {} },
  );
  await queues.reconcile.upsertJobScheduler(
    WEEKLY_RECONCILE_SWEEP,
    { pattern: deps.weeklyReconcileCron },
    { name: WEEKLY_RECONCILE_SWEEP, data: {} },
  );
  await queues.sync.upsertJobScheduler(
    DIRTY_EPICS_SWEEP,
    { pattern: deps.dirtySweepCron },
    { name: DIRTY_EPICS_SWEEP, data: {} },
  );

  log({ event: 'worker.wired', queues: ['sync', 'backfill', 'reconcile'] });
  return { workers, queues };
}

// ---------------------------------------------------------------------------
// Bộ xử lý từng job
// ---------------------------------------------------------------------------

/** `sync-epic` và `backfill-epic`: đọc Jira (giai đoạn 1–3) rồi dựng lại (4–5). */
async function runSyncJob(ctx: JobContext, rawPayload: unknown): Promise<void> {
  const epicKey = parseSyncJobPayload(rawPayload).epicKey;
  const { config, calendar, projectKey, hierarchyDepth, jira } = await loadEpicContext(ctx, epicKey);
  const sourceReadAtMs = ctx.now().getTime();

  const syncDeps: SyncEpicDeps = {
    jira: jira.client,
    fields: jira.fields,
    projectKey,
    hierarchyDepth,
    config,
    issues: createIssueWritePort(ctx.prisma),
    worklogs: createWorklogWritePort(ctx.prisma),
    changelog: createChangelogWritePort(ctx.prisma),
    syncRuns: createSyncRunPort(ctx.prisma),
    epics: createEpicStatePort(ctx.prisma),
    dirty: createDirtyEpicQueuePort(ctx.generalConn),
    now: ctx.now,
  };

  const reconstructDeps = buildReconstructDeps(ctx, jira, calendar, sourceReadAtMs, epicKey);

  const syncJobDeps: SyncJobDeps = {
    ports: {
      syncFromJira: async (key, { ignoreWatermark }) => {
        const result = await syncEpic(syncDeps, key, { ignoreWatermark });
        // Cảnh báo từ bước phân tách/ghi (PHASE_MISMATCH, FIELD_TRUNCATED, …)
        // trước đây bị bỏ rơi ngay tại đây. Đẩy ra log — cùng khuôn `*.warning`
        // như reconstruct — để vận hành thấy tiêu đề nào đặt sai mà không phải dò
        // DB. Khử trùng lặp theo (code, detail): cảnh báo cấu hình như
        // NO_SUBTASK_PATTERN bị lặp lại một lần cho MỖI Sub-task trong
        // `buildRecords`, còn cảnh báo theo issue (kèm key) thì vẫn khác nhau.
        const seen = new Set<string>();
        for (const w of result.warnings) {
          const dedupKey = `${w.code} ${w.message}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          ctx.log({ event: 'sync.warning', epicKey: key, code: w.code, detail: w.message });
        }
        // syncEpic KHÔNG ném lỗi (nó tự ghi ERROR + sync_run FAILED), nhưng nếu
        // đọc Jira hỏng thì đừng dựng snapshot từ dữ liệu cũ — để job đổ và thử lại.
        if (result.status === 'FAILED') {
          throw new Error(result.errorMessage ?? `Đồng bộ ${key} thất bại`);
        }
      },
      earliestDataDate: (key) => earliestDataDate(ctx.prisma, key),
      earliestMissingSnapshotDate: (key) =>
        earliestMissingSnapshotDate(ctx.prisma, calendar, ctx.now, key),
      rebuild: (args) => reconstructEpic(reconstructDeps, args),
    },
    calendar,
    now: ctx.now,
    log: (e) => ctx.log(e),
  };

  const result = await handleSyncJob(syncJobDeps, rawPayload);
  ctx.log({
    event: 'sync.done',
    epicKey,
    scope: result.range.scope,
    outcome: result.outcome.status,
  });
}

/** `reconstruct-epic`: chỉ dựng lại (4–5), KHÔNG đọc Jira — dùng cho tính lại quá khứ. */
async function runReconstructJob(ctx: JobContext, rawPayload: unknown): Promise<void> {
  const payload = parseSyncJobPayload(rawPayload);
  const epicKey = payload.epicKey;
  // Job này không đọc Jira, nhưng vẫn cần `statusIdMap` của ĐÚNG tenant để
  // dịch changelog — registry trả từ cache Redis theo dự án nên thường không
  // tốn lời gọi Jira nào.
  const { calendar, jira } = await loadEpicContext(ctx, epicKey);

  const reconstructDeps = buildReconstructDeps(ctx, jira, calendar, ctx.now().getTime(), epicKey);
  const range = resolveRebuildRange({
    full: payload.full,
    from: payload.from,
    to: payload.to,
    earliestDataDate: await earliestDataDate(ctx.prisma, epicKey),
    earliestMissingSnapshotDate: await earliestMissingSnapshotDate(
      ctx.prisma,
      calendar,
      ctx.now,
      epicKey,
    ),
    today: localDateOf(ctx.now().getTime(), calendar.timezone),
    timezone: calendar.timezone,
  });

  const outcome = await reconstructEpic(reconstructDeps, {
    epicKey,
    from: range.from,
    to: range.to,
  });
  ctx.log({ event: 'reconstruct.done', epicKey, scope: range.scope, status: outcome.status });
}

/** `reconcile-epic`: so tổng DB với tổng Jira, lệch quá ngưỡng thì đẩy backfill (T-26). */
async function runReconcileJob(ctx: JobContext, rawPayload: unknown): Promise<void> {
  const epicKey = parseSyncJobPayload(rawPayload).epicKey;
  const { hierarchyDepth, jira } = await loadEpicContext(ctx, epicKey);

  const deps: ReconcileDeps = {
    reads: createReconcileReadPort(ctx.prisma),
    jira: { jiraTotals: (key) => jiraTotals(jira, hierarchyDepth, key) },
    writes: {
      recordRun: (record) => {
        // Chưa có bảng riêng cho đối soát; ghi log có cấu trúc để theo dõi xu hướng.
        ctx.log({
          event: 'reconcile.run',
          epicKey: record.epicKey,
          driftRatio: record.driftRatio,
          totalDbS: record.totalDbS,
          totalJiraS: record.totalJiraS,
          driftCount: record.driftCount,
          backfillQueued: record.backfillQueued,
          checkedAt: record.checkedAt.toISOString(),
        });
        return Promise.resolve();
      },
      enqueueFullBackfill: (key) => enqueueBackfill(ctx.queues, key),
    },
    now: ctx.now,
    onAlert: (e) =>
      ctx.log({ event: 'reconcile.alert', level: e.level, code: e.code, message: e.message, epicKey: e.epicKey }),
    log: (e) => ctx.log(e),
  };

  const outcome = await reconcileEpic(deps, epicKey);
  ctx.log({
    event: 'reconcile.done',
    epicKey,
    driftRatio: outcome.result.driftRatio,
    backfillQueued: outcome.backfillQueued,
  });
}

async function runNightlySweep(ctx: JobContext): Promise<void> {
  // Loại Epic của project đã ARCHIVED: lưu trữ tenant đồng nghĩa job đêm phải
  // ngừng đụng vào Jira của họ, dù Epic trong sổ vẫn đang ACTIVE.
  const epics = await listActiveEpics(ctx.prisma, { excludeArchivedProjects: true });
  for (const epicKey of epics) {
    // `addReplacingFinished` dọn xác job hôm trước (completed còn trong 24h giữ
    // lại, hoặc failed giữ vĩnh viễn) — không dọn thì BullMQ nuốt lượt đêm nay.
    await addReplacingFinished(
      ctx.queues.sync,
      JOB_NAME.syncEpic,
      { epicKey },
      jobIdFor(JOB_NAME.syncEpic, epicKey),
    );
  }
  ctx.log({ event: 'nightly.swept', epics: epics.length });
}

async function runWeeklyReconcileSweep(ctx: JobContext): Promise<void> {
  const epics = await listActiveEpics(ctx.prisma, { excludeArchivedProjects: true });
  for (const epicKey of epics) {
    await addReplacingFinished(
      ctx.queues.reconcile,
      JOB_NAME.reconcileEpic,
      { epicKey },
      jobIdFor(JOB_NAME.reconcileEpic, epicKey),
    );
  }
  ctx.log({ event: 'weekly-reconcile.swept', epics: epics.length });
}

/**
 * Quét `dirty:epics` → backfill toàn bộ từng Epic bị đánh dấu.
 *
 * Đây là job nhặt mà PHASE-MAPPING.md mục 7 từng ghi "chưa được nối dây". Nhờ nó,
 * Lưu Phase settings không còn cần Resync thủ công: `phase_code` được gán lại
 * theo cấu hình mới ở lượt quét kế tiếp (tối đa một chu kỳ `dirtySweepCron`).
 */
async function runDirtyEpicsSweep(ctx: JobContext): Promise<void> {
  const store = createDirtySweepStorePort(ctx.generalConn);
  await sweepDirtyEpics({
    ports: {
      takeAll: () => store.takeAll(),
      restore: (epicKeys) => store.restore(epicKeys),
      // Sổ theo dõi đủ điều kiện là "CÓ MẶT", không phải "ACTIVE": Epic đang
      // ERROR/PENDING vẫn đáng được backfill — chính lượt chạy bù có thể là thứ
      // gỡ nó khỏi trạng thái lỗi.
      trackedOf: async (epicKeys) =>
        new Set((await findManyByKeys(ctx.prisma, epicKeys)).map((e) => e.epicKey)),
      enqueueFullBackfill: (epicKey) => enqueueBackfill(ctx.queues, epicKey),
    },
    log: (e) => ctx.log(e),
  });
}

// ---------------------------------------------------------------------------
// Trợ giúp chung
// ---------------------------------------------------------------------------

async function enqueueBackfill(queues: QueueSet, epicKey: string): Promise<void> {
  await addReplacingFinished(
    queues.backfill,
    JOB_NAME.backfillEpic,
    { epicKey, full: true },
    jobIdFor(JOB_NAME.backfillEpic, epicKey),
  );
}

/**
 * Nạp cấu hình hiệu lực + lịch làm việc + NGỮ CẢNH TENANT của một Epic.
 *
 * Từ multi-tenant, đây là chỗ duy nhất nối "epicKey trong payload job" với
 * "dự án sở hữu nó": hàng `project` cho hierarchyDepth, còn registry cho
 * client/field mapping/status map của đúng site Jira. Payload job vẫn chỉ có
 * `{epicKey}` — key đã mang tiền tố dự án nên không cần đổi khuôn payload.
 */
async function loadEpicContext(
  ctx: JobContext,
  epicKey: string,
): Promise<{
  config: EffectiveConfig;
  calendar: Awaited<ReturnType<typeof getCalendar>>;
  projectKey: string;
  hierarchyDepth: number;
  jira: ProjectJiraContext;
}> {
  const epic = await findByKey(ctx.prisma, epicKey);
  if (!epic) {
    throw new Error(`Epic ${epicKey} không có trong sổ theo dõi — không xử lý được.`);
  }
  const project = await findProjectConnection(ctx.prisma, epic.projectKey);
  if (!project) {
    // FK bảo đảm điều này gần như không xảy ra — nhưng nếu xảy ra thì báo rõ
    // thay vì để registry ném lỗi kết nối khó hiểu hơn.
    throw new Error(
      `Epic ${epicKey} trỏ tới dự án ${epic.projectKey} không còn trong bảng project.`,
    );
  }
  const jira = await ctx.registry.forProject(epic.projectKey);
  const config = await loadEffectiveConfig(ctx.prisma, epic.projectKey);
  // Đọc lại lịch ở ĐẦU MỖI JOB thay vì cache vĩnh viễn trong RAM: admin vừa
  // import ngày lễ (T-36) mà worker chạy suốt vài tuần không restart thì lịch
  // cũ vẫn được dùng — và đường Kế hoạch sẽ giảm đều trong cả tuần nghỉ Tết
  // (đúng cảnh báo trong T-12). Cache vẫn giữ để các lần gọi TRONG CÙNG một
  // job dùng chung; query lịch rất nhẹ nên đọc lại mỗi job không đáng kể.
  ctx.calendarCache.invalidate(epic.calendarId);
  const calendar = await getCalendar(ctx.prisma, epic.calendarId, ctx.calendarCache);
  return {
    config,
    calendar,
    projectKey: epic.projectKey,
    hierarchyDepth: project.hierarchyDepth,
    jira,
  };
}

function buildReconstructDeps(
  ctx: JobContext,
  jira: ProjectJiraContext,
  calendar: Awaited<ReturnType<typeof getCalendar>>,
  sourceReadAtMs: number,
  epicKey: string,
): ReconstructDeps {
  return {
    ports: createReconstructPorts(ctx.prisma, ctx.generalConn, jira.statusIdMap, ctx.now),
    redis: ctx.generalConn,
    calendar,
    statusIdMap: jira.statusIdMap,
    sourceReadAtMs,
    now: ctx.now,
    // Token duy nhất mỗi lượt chạy để nhả/gia hạn đúng khoá của mình.
    lockToken: globalThis.crypto.randomUUID(),
    onWarning: (code, detail) => ctx.log({ event: 'reconstruct.warning', epicKey, code, detail }),
  };
}

/** Gộp cấu hình Global + Project thành cấu hình hiệu lực cho Epic. */
async function loadEffectiveConfig(
  prisma: PrismaClient,
  projectKey: string | null,
): Promise<EffectiveConfig> {
  const global = await findActiveConfigSet(prisma, 'GLOBAL', null);
  const globalPayload: ConfigPayload = global ?? DEFAULT_PHASE_CONFIG;
  const project = projectKey ? await findActiveConfigSet(prisma, 'PROJECT', projectKey) : null;
  const projectArg: (Partial<ConfigPayload> & { projectKey: string }) | null =
    project && project.projectKey !== null ? { ...project, projectKey: project.projectKey } : null;

  return mergeInheritance(globalPayload, projectArg, {
    globalVersion: global?.version ?? 0,
    projectVersion: project?.version ?? null,
  });
}

/**
 * Ngày sớm nhất Epic có dữ liệu để dựng lịch sử.
 *
 * Thứ tự ưu tiên: snapshot sớm nhất → ngày kế hoạch (`wbs_start_date`) sớm nhất
 * của Sub-task → ngày tạo issue sớm nhất. Ở lượt BACKFILL ĐẦU TIÊN chưa có
 * snapshot lẫn phase_rollup (chúng được tạo TRONG lúc dựng lại), nên phải đọc từ
 * `jira_issue` thô mà `syncFromJira` vừa ghi — nếu không dải "toàn bộ" rỗng và
 * `resolveRebuildRange` ném lỗi "chưa có dữ liệu nào".
 */
async function earliestDataDate(prisma: PrismaClient, epicKey: string): Promise<DateOnly | null> {
  const snap = await prisma.dailySnapshot.aggregate({
    _min: { snapshotDate: true },
    where: { epicKey },
  });
  if (snap._min.snapshotDate) return toDateString(snap._min.snapshotDate);

  const plan = await prisma.jiraIssue.aggregate({
    _min: { wbsStartDate: true },
    where: { epicKey, issueType: 'SUBTASK', removedAt: null },
  });
  if (plan._min.wbsStartDate) return toDateString(plan._min.wbsStartDate);

  // Không Sub-task nào có ngày kế hoạch: lấy ngày tạo issue sớm nhất làm mốc.
  const created = await prisma.jiraIssue.aggregate({
    _min: { jiraCreatedAt: true },
    where: { epicKey, removedAt: null },
  });
  return created._min.jiraCreatedAt ? toDateString(created._min.jiraCreatedAt) : null;
}

/**
 * Ngày làm việc sớm nhất còn thiếu snapshot (E-12). `null` = không thiếu.
 *
 * CỐ Ý chỉ quét NGÀY LÀM VIỆC dù snapshot giờ được dựng cho mọi ngày lịch
 * (2026-08): coi cuối tuần lịch sử "thiếu" sẽ kéo lượt dựng lại về tận đầu Epic
 * ngay đêm đầu sau khi nâng cấp. Cuối tuần được phủ dần bởi cửa sổ 7 ngày của
 * lượt đồng bộ thường ngày; muốn có đủ lịch sử cuối tuần cũ thì chạy Resync full.
 */
async function earliestMissingSnapshotDate(
  prisma: PrismaClient,
  calendar: Awaited<ReturnType<typeof getCalendar>>,
  now: () => Date,
  epicKey: string,
): Promise<DateOnly | null> {
  const earliest = await earliestDataDate(prisma, epicKey);
  if (earliest === null) return null;

  const today = localDateOf(now().getTime(), calendar.timezone);
  if (earliest > today) return null;

  const existing = await prisma.dailySnapshot
    .findMany({ where: { epicKey }, select: { snapshotDate: true } })
    .then((rows) => new Set(rows.map((r) => toDateString(r.snapshotDate)).filter((d): d is string => d !== null)));

  const workday = listWorkdays(earliest, today, calendar).find((d) => !existing.has(d));
  return workday ?? null;
}

async function jiraTotals(
  jira: ProjectJiraContext,
  hierarchyDepth: number,
  epicKey: string,
): Promise<readonly IssueTotals[]> {
  const tree = await fetchRootTree(jira.client, {
    rootKey: epicKey,
    depth: hierarchyDepth,
    fields: jira.fields,
    since: null,
  });
  // Mọi tầng dưới root — giống bộ [tasks, subtasks] cũ; so tổng theo issueKey
  // nên hàng MIDDLE chỉ khớp với chính nó, không làm lệch phép đối soát.
  return tree.byTier
    .slice(1)
    .flat()
    .map((i) => ({
      issueKey: i.key,
      timeSpentS: numberOf(i.fields['timespent']),
      originalEstimateS: numberOf(i.fields['timeoriginalestimate']),
    }));
}

function numberOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Ép `full: true` vào payload thô trước khi bộ xử lý đọc nó. */
function withFull(raw: unknown): unknown {
  const base = typeof raw === 'object' && raw !== null ? raw : {};
  return { ...base, full: true };
}
