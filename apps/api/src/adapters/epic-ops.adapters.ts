import type { PrismaClient } from '@app/db';
import {
  listPlanShifts,
  loadExplainBundle,
  loadHealthRatios,
  loadPhaseRollups,
  storedRemainingSeconds,
} from '@app/db';
import type { StatusIdMap, TrackedEpicStatus } from '@app/shared';
import { enqueueReplacingFinished, type QueueLike } from './epic-registry.adapters.js';
import type { EpicOpsReadPort, EpicOpsWritePort } from '../routes/epic-ops.routes.js';
import { createBurndownReadPort } from './burndown.adapters.js';

/**
 * Nối cổng vận hành Epic vào Prisma và hàng đợi.
 *
 * File DUY NHẤT của nhóm này biết tới Prisma và BullMQ. Tầng route và hai
 * service đều chỉ nhìn thấy cổng, nhờ vậy test được mà không cần hạ tầng.
 */

export const SYNC_JOB_NAME = 'sync-epic';

/**
 * Bảng tra status THEO TENANT: đa site Jira thì status ID số đụng nhau giữa các
 * site, nên không còn một `StatusIdMap` toàn cục nạp lúc boot nữa — endpoint
 * explain nạp theo yêu cầu qua cổng này (registry per-project cache sẵn).
 */
export type StatusMapLoader = (projectKey: string) => Promise<StatusIdMap>;

export function createEpicOpsReadPort(prisma: PrismaClient, loadStatusMap: StatusMapLoader): EpicOpsReadPort {
  // Dùng lại phần đọc lịch và project của nhóm Burndown thay vì viết lại truy
  // vấn thứ hai — hai bản sao sẽ có ngày trả về hai múi giờ khác nhau.
  const burndown = createBurndownReadPort(prisma);

  return {
    async epicMeta(epicKey) {
      const base = await burndown.epicMeta(epicKey);
      if (base === null) return null;

      const [row] = await prisma.$queryRawUnsafe<
        { status: string; last_synced_at: Date | null; last_error: string | null }[]
      >(
        `SELECT status, last_synced_at, last_error FROM tracked_epic WHERE epic_key = $1`,
        epicKey,
      );

      const [range] = await prisma.$queryRawUnsafe<{ first_date: Date | null; last_date: Date | null }[]>(
        `SELECT MIN(snapshot_date) AS first_date, MAX(snapshot_date) AS last_date
           FROM daily_snapshot WHERE epic_key = $1`,
        epicKey,
      );

      return {
        projectKey: base.projectKey,
        status: (row?.status ?? 'PENDING') as TrackedEpicStatus,
        lastSyncedAt: row?.last_synced_at ?? null,
        lastError: row?.last_error ?? null,
        calendar: base.calendar,
        firstSnapshotDate: range?.first_date?.toISOString().slice(0, 10) ?? null,
        lastSnapshotDate: range?.last_date?.toISOString().slice(0, 10) ?? null,
      };
    },

    healthRatios: (epicKey) => loadHealthRatios(prisma, epicKey),

    async snapshotDates(epicKey) {
      const rows = await prisma.$queryRawUnsafe<{ snapshot_date: Date }[]>(
        `SELECT snapshot_date FROM daily_snapshot WHERE epic_key = $1`,
        epicKey,
      );
      return new Set(rows.map((r) => r.snapshot_date.toISOString().slice(0, 10)));
    },

    storedRemaining: (epicKey, date) => storedRemainingSeconds(prisma, epicKey, date),

    subtasksWithHistory: async (epicKey, projectKey) =>
      loadExplainBundle(prisma, epicKey, await loadStatusMap(projectKey)),

    async planShifts(epicKey) {
      const rows = await listPlanShifts(prisma, epicKey);
      // `listPlanShifts` chưa trả `detectedAt`; đọc thêm để sắp mới nhất trước.
      const times = await prisma.$queryRawUnsafe<{ phase_code: string; shift_type: string; detected_at: Date }[]>(
        `SELECT phase_code, shift_type, detected_at FROM plan_shift_history WHERE epic_key = $1`,
        epicKey,
      );
      const at = new Map(times.map((t) => [`${t.phase_code}:${t.shift_type}`, t.detected_at]));
      return rows.map((r) => ({
        ...r,
        detectedAt: at.get(`${r.phaseCode}:${r.shiftType}`) ?? new Date(0),
      }));
    },

    async totalPlanWorkdays(epicKey) {
      const rollups = await loadPhaseRollups(prisma, epicKey);
      return [...rollups.values()].reduce((sum, r) => sum + (r.planWorkdays ?? 0), 0);
    },
  };
}

export function createEpicOpsWritePort(prisma: PrismaClient, queue: QueueLike): EpicOpsWritePort {
  return {
    async setStatus(epicKey, status) {
      // Đi qua Prisma CÓ KIỂU, KHÔNG raw SQL: bảng `tracked_epic` KHÔNG có cột
      // `updated_at` (xem schema.prisma và migration 20260803000000_init — chỉ có
      // `added_at`, `last_synced_at`). Câu `UPDATE ... SET updated_at = NOW()` cũ
      // vì thế ném lỗi Postgres `column "updated_at" does not exist`. Đây là thao
      // tác GHI duy nhất trên đường đồng bộ lại một Epic đang ERROR/PENDING, nên
      // lỗi đó biến CẢ nút Resync thành 500 INTERNAL_ERROR. Qua
      // `prisma.trackedEpic.update`, tham chiếu một cột không tồn tại là lỗi BIÊN
      // DỊCH, không còn lọt xuống runtime được nữa.
      await prisma.trackedEpic.update({ where: { epicKey }, data: { status } });
    },

    async enqueueSync(epicKey, args) {
      // `jobId` theo Epic để bấm hai lần không tạo hai job cùng chạy (C-6).
      // Dấu `__` chứ không phải `:` — BullMQ cấm `:` trong jobId tuỳ biến.
      // Đi qua `enqueueReplacingFinished`: xác job resync TRƯỚC còn nằm trong
      // Redis sẽ nuốt lặng lẽ mọi lượt resync sau nếu không dọn đi.
      const jobId = `${SYNC_JOB_NAME}__${epicKey}`;
      await enqueueReplacingFinished(queue, SYNC_JOB_NAME, { epicKey, ...args }, jobId);
      return jobId;
    },
  };
}
