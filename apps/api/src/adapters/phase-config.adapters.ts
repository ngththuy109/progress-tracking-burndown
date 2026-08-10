import type { PrismaClient } from '@app/db';
import {
  findActiveConfigSet,
  listVersions as listVersionsRepo,
  rollbackToVersion,
  saveNewVersion,
} from '@app/db';
import { UNCLASSIFIED_PHASE, type UnmatchedLabel } from '@app/shared';
import type {
  DirtyEpicQueue,
  IssueReadPort,
  PhaseConfigStore,
} from '../services/phase-config.service.js';
import type { PreviewTask } from '../services/config-preview.service.js';

/**
 * Bộ chuyển đổi từ CỔNG của tầng service sang Prisma và Redis thật.
 *
 * Cố ý giữ MỎNG: mỗi hàm chỉ là một truy vấn và một phép đổi tên trường. Toàn
 * bộ phần đáng test nằm ở service, và service test được mà không cần PostgreSQL.
 */

export function createPhaseConfigStore(prisma: PrismaClient, cache?: { del(p: string): Promise<void> }): PhaseConfigStore {
  return {
    findActive: (scope, projectKey) => findActiveConfigSet(prisma, scope, projectKey),
    save: (args) => saveNewVersion(prisma, args, cache),
    rollback: (args) => rollbackToVersion(prisma, args, cache),
    listVersions: (scope, projectKey) => listVersionsRepo(prisma, scope, projectKey),
  };
}

/** Số key ví dụ kèm theo mỗi nhãn chưa nhận diện — đủ để PM bấm sang Jira xem. */
const SAMPLE_KEYS_PER_LABEL = 3;

export function createIssueReadPort(prisma: PrismaClient): IssueReadPort {
  /**
   * `jira_issue` không có cột project. Project nằm ở `tracked_epic`, nên phải
   * lấy danh sách Epic trước rồi mới lọc issue theo `epic_key`.
   */
  const epicKeysOf = async (projectKey: string | null): Promise<string[]> => {
    const rows = await prisma.trackedEpic.findMany({
      where: projectKey === null ? {} : { projectKey },
      select: { epicKey: true },
    });
    return rows.map((r) => r.epicKey);
  };

  return {
    listTrackedEpicKeys: epicKeysOf,

    async listPhaseTasks(projectKey): Promise<readonly PreviewTask[]> {
      const epicKeys = await epicKeysOf(projectKey);
      if (epicKeys.length === 0) return [];

      const rows = await prisma.jiraIssue.findMany({
        where: {
          epicKey: { in: epicKeys },
          resolvedRole: 'GROUP',
          // Issue đã gỡ khỏi Epic không còn là thứ PM cần xem thử phân loại.
          removedAt: null,
        },
        select: { issueKey: true, epicKey: true, summary: true, phaseCode: true },
        orderBy: { issueKey: 'asc' },
      });

      return rows.map((r) => ({
        taskKey: r.issueKey,
        epicKey: r.epicKey ?? '',
        title: r.summary,
        currentPhaseCode: r.phaseCode ?? UNCLASSIFIED_PHASE,
      }));
    },

    async listUnmatchedLabels(projectKey): Promise<readonly UnmatchedLabel[]> {
      const epicKeys = await epicKeysOf(projectKey);
      if (epicKeys.length === 0) return [];

      const rows = await prisma.jiraIssue.findMany({
        where: {
          epicKey: { in: epicKeys },
          resolvedRole: 'GROUP',
          removedAt: null,
          phaseCode: UNCLASSIFIED_PHASE,
        },
        select: { issueKey: true, rawPhaseLabel: true },
        orderBy: { issueKey: 'asc' },
      });

      // Gom theo nhãn ở tầng ứng dụng thay vì `groupBy` của SQL: còn phải kèm
      // vài key ví dụ, mà `groupBy` không trả kèm được.
      const byLabel = new Map<string | null, { count: number; sampleTaskKeys: string[] }>();
      for (const r of rows) {
        const entry = byLabel.get(r.rawPhaseLabel) ?? { count: 0, sampleTaskKeys: [] };
        entry.count += 1;
        if (entry.sampleTaskKeys.length < SAMPLE_KEYS_PER_LABEL) entry.sampleTaskKeys.push(r.issueKey);
        byLabel.set(r.rawPhaseLabel, entry);
      }

      // Sắp GIẢM DẦN theo số lần xuất hiện: nhãn gặp nhiều nhất là thứ PM nên
      // thêm từ khoá trước tiên.
      return [...byLabel.entries()]
        .map(([rawPhaseLabel, v]) => ({ rawPhaseLabel, ...v }))
        .sort((a, b) => b.count - a.count);
    },
  };
}

/**
 * Chỉ cần đúng một lệnh Redis, nên khai interface tối thiểu thay vì kéo cả
 * `ioredis` vào `apps/api`. Bất kỳ client nào có `sadd` đều cắm vừa.
 */
export interface RedisLike {
  sadd(key: string, ...members: string[]): Promise<number>;
}

export const DIRTY_EPICS_KEY = 'dirty:epics';

export function createDirtyEpicQueue(redis: RedisLike): DirtyEpicQueue {
  return {
    async add(epicKeys) {
      if (epicKeys.length === 0) return;
      await redis.sadd(DIRTY_EPICS_KEY, ...epicKeys);
    },
  };
}
