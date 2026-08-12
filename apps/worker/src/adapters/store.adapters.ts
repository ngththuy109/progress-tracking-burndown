import type { PrismaClient } from '@app/db';
import {
  deleteObsoleteGroupRollups,
  deleteObsoleteRollups,
  finishSyncRun,
  findByKey,
  groupKeyOf,
  insertPlanShifts,
  knownIdToKey,
  listSnapshotDates,
  loadExplainBundle,
  loadPhaseRollups,
  markRemovedIssues,
  markWorklogsDeleted,
  previousTotalScope,
  startSyncRun,
  updateEpic,
  upsertChangelog,
  upsertGroupRollups,
  upsertIssues,
  upsertPhaseRollups,
  upsertSnapshots,
  upsertSubtaskActualDates,
  upsertWorklogs,
} from '@app/db';
import type { IssueTotals, StatusIdMap, TrackedEpicStatus } from '@app/shared';
import type {
  ChangelogWritePort,
  DirtyEpicQueuePort,
  EpicStatePort,
  IssueWritePort,
  SyncRunPort,
  WorklogWritePort,
} from '../jobs/sync-epic.job.js';
import type { ReconstructPorts } from '../jobs/reconstruct-epic.job.js';
import type { ReconcileReadPort } from '../jobs/reconcile-epic.job.js';

/**
 * Bộ chuyển đổi từ CỔNG của các job sang Prisma và Redis thật.
 *
 * Cùng triết lý với `apps/api/src/adapters`: giữ MỎNG. Toàn bộ phần đáng test
 * nằm ở job (đã có test với kho giả), nên ở đây mỗi hàm chỉ là một lời gọi repo
 * và một phép đổi tên trường. Kiểu được ràng bằng chú thích trả về (`: XxxPort`)
 * — sai một trường là không biên dịch được.
 */

/** Phần `ioredis` mà các cổng cần. Hẹp lại để không kéo cả ioredis vào chữ ký. */
export interface AdapterRedis {
  sadd(key: string, ...members: string[]): Promise<number>;
  spop(key: string, count: number): Promise<string[]>;
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  unlink(...keys: string[]): Promise<number>;
}

/** Tập Epic cần tính lại — worker khác nhặt ra ở lượt sau (PRD §4.7). */
export const DIRTY_EPICS_KEY = 'dirty:epics';

/** Số key mỗi vòng SCAN khi xoá cache. Khớp với `apps/api` SCAN_COUNT. */
const SCAN_COUNT = 200;

// ---------------------------------------------------------------------------
// Cổng ghi của luồng đồng bộ (giai đoạn 1–3)
// ---------------------------------------------------------------------------

export function createIssueWritePort(prisma: PrismaClient): IssueWritePort {
  // `IssueRecord` (persist-issues) và `IssueUpsertRow` (repo) trùng nhau từng
  // trường, nên truyền thẳng.
  return {
    upsertMany: (rows) => upsertIssues(prisma, rows),
    markRemoved: (epicKey, liveKeys, at) => markRemovedIssues(prisma, epicKey, liveKeys, at),
    knownIdToKey: (epicKey) => knownIdToKey(prisma, epicKey),
  };
}

export function createWorklogWritePort(prisma: PrismaClient): WorklogWritePort {
  return {
    upsertMany: (rows) => upsertWorklogs(prisma, rows),
    markDeleted: (ids) => markWorklogsDeleted(prisma, ids),
  };
}

export function createChangelogWritePort(prisma: PrismaClient): ChangelogWritePort {
  return {
    upsertMany: (rows) => upsertChangelog(prisma, rows),
  };
}

export function createSyncRunPort(prisma: PrismaClient): SyncRunPort {
  return {
    start: (args) => startSyncRun(prisma, args),
    // `sync_run` không có cột issues_read / worklogs_read — hai số đó chỉ để job
    // trả về cho log. Bỏ chúng khi ghi xuống DB, không phải quên.
    finish: (args) =>
      finishSyncRun(prisma, {
        id: args.id,
        status: args.status,
        finishedAt: args.finishedAt,
        apiCalls: args.apiCalls,
        rateLimitHits: args.rateLimitHits,
        errorMessage: args.errorMessage,
        errorStep: args.errorStep,
        errorDetail: args.errorDetail,
      }),
  };
}

export function createEpicStatePort(prisma: PrismaClient): EpicStatePort {
  return {
    read: async (epicKey) => {
      const row = await findByKey(prisma, epicKey);
      // `status` trong DB là chuỗi tự do; CHECK constraint mới là thứ ép nó vào 5
      // giá trị. Ép kiểu ở BIÊN đọc, một chỗ duy nhất.
      return row ? { status: row.status as TrackedEpicStatus, lastSyncedAt: row.lastSyncedAt } : null;
    },
    setStatus: (epicKey, status, lastError) => updateEpic(prisma, epicKey, { status, lastError }),
    setSynced: (epicKey, at) => updateEpic(prisma, epicKey, { lastSyncedAt: at }),
  };
}

export function createDirtyEpicQueuePort(redis: Pick<AdapterRedis, 'sadd'>): DirtyEpicQueuePort {
  return {
    add: async (epicKeys) => {
      if (epicKeys.length === 0) return;
      await redis.sadd(DIRTY_EPICS_KEY, ...epicKeys);
    },
  };
}

/** Số phần tử mỗi lệnh SPOP khi quét `dirty:epics`. */
const SPOP_BATCH = 100;

/**
 * Cổng đọc/trả `dirty:epics` cho job quét (dirty-epics-sweep).
 *
 * `takeAll` dùng SPOP theo lô — lấy VÀ xoá trong một lệnh, nên key SADD thêm
 * giữa chừng bởi tiến trình khác không bao giờ bị xoá oan (khác với
 * SMEMBERS + DEL). Key đã pop ra thuộc trách nhiệm của job quét: đẩy hàng đợi
 * thất bại thì phải `restore` lại.
 */
export function createDirtySweepStorePort(redis: Pick<AdapterRedis, 'sadd' | 'spop'>): {
  takeAll(): Promise<readonly string[]>;
  restore(epicKeys: readonly string[]): Promise<void>;
} {
  return {
    takeAll: async () => {
      const all: string[] = [];
      // Vòng lặp dừng khi SPOP trả ít hơn cỡ lô — set đã cạn. Set này cỡ vài
      // chục Epic nên thường chỉ một vòng.
      for (;;) {
        const batch = await redis.spop(DIRTY_EPICS_KEY, SPOP_BATCH);
        all.push(...batch);
        if (batch.length < SPOP_BATCH) return all;
      }
    },
    restore: async (epicKeys) => {
      if (epicKeys.length === 0) return;
      await redis.sadd(DIRTY_EPICS_KEY, ...epicKeys);
    },
  };
}

// ---------------------------------------------------------------------------
// Cổng của luồng dựng lại (giai đoạn 4–5)
// ---------------------------------------------------------------------------

/**
 * Xoá mọi cache biểu đồ của một Epic bằng SCAN (KHÔNG dùng KEYS — KEYS khoá cả
 * Redis vài trăm ms, kéo theo cả token bucket giới hạn Jira).
 *
 * Mẫu key `chart:<epicKey>:*` PHẢI khớp `chartCachePattern` bên
 * `apps/api/src/adapters/chart-cache.ts`. Hai app không import lẫn nhau nên mẫu
 * này lặp lại có chủ đích.
 */
export async function invalidateChartCache(
  redis: Pick<AdapterRedis, 'scan' | 'unlink'>,
  epicKey: string,
): Promise<void> {
  const pattern = `chart:${epicKey}:*`;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
    cursor = next;
    if (keys.length > 0) await redis.unlink(...keys);
  } while (cursor !== '0');
}

export function createReconstructPorts(
  prisma: PrismaClient,
  redis: AdapterRedis,
  statusIdMap: StatusIdMap,
  now: () => Date,
): ReconstructPorts {
  return {
    // `loadExplainBundle` đã dựng sẵn `SubtaskRecord[]` kèm đủ changelog/worklog.
    loadSubtasks: async (epicKey) => (await loadExplainBundle(prisma, epicKey, statusIdMap)).subtasks,
    loadPreviousRollups: (epicKey) => loadPhaseRollups(prisma, epicKey),
    savePhaseRollups: (epicKey, rollups) => upsertPhaseRollups(prisma, epicKey, rollups, now()),
    deleteObsoleteRollups: (epicKey, livePhaseCodes) =>
      deleteObsoleteRollups(prisma, epicKey, livePhaseCodes),
    saveGroupRollups: (epicKey, rollups) => upsertGroupRollups(prisma, epicKey, rollups, now()),
    deleteObsoleteGroupRollups: (epicKey, liveGroupPaths) =>
      deleteObsoleteGroupRollups(prisma, epicKey, liveGroupPaths.map(groupKeyOf)),
    saveSubtaskActualDates: (rows) => upsertSubtaskActualDates(prisma, rows, now()),
    savePlanShifts: async (epicKey, shifts) => {
      const r = await insertPlanShifts(prisma, epicKey, shifts, now());
      return { skippedNullBoundary: r.skippedNullBoundary };
    },
    existingSnapshotDates: (epicKey) => listSnapshotDates(prisma, epicKey),
    previousTotalScope: (epicKey, date) => previousTotalScope(prisma, epicKey, date),
    saveSnapshots: (rows) => upsertSnapshots(prisma, rows, now()),
    invalidateChartCache: (epicKey) => invalidateChartCache(redis, epicKey),
    markDirty: async (epicKey) => {
      await redis.sadd(DIRTY_EPICS_KEY, epicKey);
    },
  };
}

// ---------------------------------------------------------------------------
// Cổng đọc của luồng đối soát (T-26)
// ---------------------------------------------------------------------------

/**
 * Tổng thời gian đã ghi trong DB, theo từng issue. So với `jiraTotals` để phát
 * hiện lệch (E-25). Chỉ tính issue CÒN trong Epic — issue đã gỡ vẫn giữ số cũ.
 */
export function createReconcileReadPort(prisma: PrismaClient): ReconcileReadPort {
  return {
    dbTotals: async (epicKey): Promise<readonly IssueTotals[]> => {
      const rows = await prisma.jiraIssue.findMany({
        where: { epicKey, removedAt: null },
        select: { issueKey: true, timeSpentS: true, originalEstimateS: true },
      });
      return rows.map((r) => ({
        issueKey: r.issueKey,
        timeSpentS: Number(r.timeSpentS),
        originalEstimateS: Number(r.originalEstimateS),
      }));
    },
  };
}
