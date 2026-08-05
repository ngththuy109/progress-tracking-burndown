import type { MissingDateRow, TrackedEpicSummary } from '@app/shared';
import { UNCLASSIFIED_PHASE } from '@app/shared';
import type { Prisma, PrismaClient } from '../client.js';

/**
 * Sổ đăng ký Epic — PRD §2.6.
 *
 * Bảng này là NGUỒN DUY NHẤT trả lời "job đêm phải chạy cho Epic nào".
 */

const SECONDS_PER_HOUR = 3600;

export interface UpsertTrackedEpicArgs {
  epicKey: string;
  epicId: bigint;
  projectKey: string;
  displayName: string;
  timezone: string;
  calendarId: string;
  addedBy: string;
  note: string | null;
}

/**
 * Thêm Epic vào sổ. Đã có thì BỎ QUA, không ném lỗi trùng khoá (C-6).
 *
 * Cố tình KHÔNG ghi đè bản ghi cũ: Epic đang `ACTIVE` mà bị thêm lại sẽ bị đẩy
 * ngược về `PENDING` và mất `last_synced_at` → chạy backfill lại từ đầu một
 * cách vô nghĩa.
 */
export async function insertIfAbsent(
  prisma: PrismaClient,
  rows: readonly UpsertTrackedEpicArgs[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await prisma.trackedEpic.createMany({
    data: rows.map((r) => ({ ...r, status: 'PENDING' })),
    skipDuplicates: true,
  });
  return result.count;
}

export async function findByKey(prisma: PrismaClient, epicKey: string) {
  return prisma.trackedEpic.findUnique({ where: { epicKey } });
}

export async function findManyByKeys(prisma: PrismaClient, keys: readonly string[]) {
  if (keys.length === 0) return [];
  return prisma.trackedEpic.findMany({ where: { epicKey: { in: [...keys] } } });
}

/**
 * Epic mà job đêm phải chạy — CHỈ `ACTIVE`.
 *
 * Dùng đúng partial index `idx_tracked_active`, nên vẫn nhanh khi sổ có hàng
 * nghìn Epic mà chỉ vài chục đang chạy.
 */
export async function listActiveEpics(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.trackedEpic.findMany({
    where: { status: 'ACTIVE' },
    select: { epicKey: true },
    orderBy: { epicKey: 'asc' },
  });
  return rows.map((r) => r.epicKey);
}

/**
 * Trường nào cũng có thể vắng mặt. Viết `| undefined` tường minh vì dự án bật
 * `exactOptionalPropertyTypes`: ở chế độ đó `status?: string` nghĩa là "được
 * phép vắng mặt" chứ KHÔNG phải "được phép bằng undefined".
 */
export interface UpdateEpicData {
  readonly status?: string | undefined;
  readonly timezone?: string | undefined;
  readonly calendarId?: string | undefined;
  readonly note?: string | null | undefined;
  readonly lastError?: string | null | undefined;
  readonly lastSyncedAt?: Date | null | undefined;
}

export async function updateEpic(
  prisma: PrismaClient,
  epicKey: string,
  data: UpdateEpicData,
): Promise<void> {
  // Dựng từng trường thay vì truyền thẳng cả object: `calendarId` là khoá ngoại
  // nên Prisma chỉ nhận nó ở dạng "unchecked", và chỉ đặt đúng những trường
  // NGƯỜI GỌI THẬT SỰ muốn đổi — không lẫn `undefined` vào câu UPDATE.
  const patch: Prisma.TrackedEpicUncheckedUpdateInput = {};
  if (data.status !== undefined) patch.status = data.status;
  if (data.timezone !== undefined) patch.timezone = data.timezone;
  if (data.calendarId !== undefined) patch.calendarId = data.calendarId;
  if (data.note !== undefined) patch.note = data.note;
  if (data.lastError !== undefined) patch.lastError = data.lastError;
  if (data.lastSyncedAt !== undefined) patch.lastSyncedAt = data.lastSyncedAt;

  if (Object.keys(patch).length === 0) return;
  await prisma.trackedEpic.update({ where: { epicKey }, data: patch });
}

/**
 * Bỏ theo dõi — PRD §2.6.4.
 *
 * `purge = false` (mặc định) chỉ gỡ khỏi sổ, GIỮ NGUYÊN toàn bộ dữ liệu lịch
 * sử. Thêm lại sau là có ngay biểu đồ cũ, không phải backfill lại.
 *
 * `purge = true` xoá sạch và KHÔNG HOÀN TÁC ĐƯỢC.
 */
export async function removeEpic(
  prisma: PrismaClient,
  epicKey: string,
  purge: boolean,
): Promise<void> {
  if (!purge) {
    // `phase_rollup` có khoá ngoại ON DELETE CASCADE nên tự đi theo. Đó là dữ
    // liệu suy ra được, không phải lịch sử gốc, nên mất cũng không sao.
    await prisma.trackedEpic.delete({ where: { epicKey } });
    return;
  }

  // Một transaction: xoá dở dang để lại Epic không còn trong sổ nhưng dữ liệu
  // vẫn nằm rải rác, và không ai biết để dọn.
  await prisma.$transaction([
    prisma.dailySnapshot.deleteMany({ where: { epicKey } }),
    prisma.worklogEntry.deleteMany({ where: { epicKey } }),
    prisma.planShiftHistory.deleteMany({ where: { epicKey } }),
    prisma.syncRun.deleteMany({ where: { epicKey } }),
    // Changelog gắn theo issue chứ không theo Epic, nên phải lọc qua issue trước.
    prisma.issueChangelogEvent.deleteMany({
      where: { issueKey: { in: await issueKeysOf(prisma, epicKey) } },
    }),
    prisma.jiraIssue.deleteMany({ where: { epicKey } }),
    prisma.trackedEpic.delete({ where: { epicKey } }),
  ]);
}

async function issueKeysOf(prisma: PrismaClient, epicKey: string): Promise<string[]> {
  const rows = await prisma.jiraIssue.findMany({ where: { epicKey }, select: { issueKey: true } });
  return rows.map((r) => r.issueKey);
}

/** Danh sách Epic kèm tình trạng dữ liệu — `GET /api/epics`. */
export async function listWithHealth(
  prisma: PrismaClient,
  projectKey: string | null,
): Promise<TrackedEpicSummary[]> {
  const epics = await prisma.trackedEpic.findMany({
    where: projectKey === null ? {} : { projectKey },
    orderBy: { epicKey: 'asc' },
  });
  if (epics.length === 0) return [];

  const keys = epics.map((e) => e.epicKey);
  const issues = await prisma.jiraIssue.findMany({
    where: { epicKey: { in: keys }, removedAt: null },
    select: {
      epicKey: true,
      issueType: true,
      phaseCode: true,
      originalEstimateS: true,
      wbsStartDate: true,
      wbsEndDate: true,
    },
  });

  const health = new Map<string, { phaseCount: number; subtaskCount: number; totalOriginalS: bigint; missingWbsDateCount: number; unclassifiedTaskCount: number }>();
  for (const key of keys) {
    health.set(key, { phaseCount: 0, subtaskCount: 0, totalOriginalS: 0n, missingWbsDateCount: 0, unclassifiedTaskCount: 0 });
  }

  for (const i of issues) {
    const h = health.get(i.epicKey ?? '');
    if (!h) continue;

    if (i.issueType === 'TASK') {
      h.phaseCount += 1;
      if ((i.phaseCode ?? UNCLASSIFIED_PHASE) === UNCLASSIFIED_PHASE) h.unclassifiedTaskCount += 1;
    } else if (i.issueType === 'SUBTASK') {
      h.subtaskCount += 1;
      h.totalOriginalS += i.originalEstimateS;
      // Thiếu MỘT trong hai ngày đã là không so sánh được sớm/trễ — đếm là
      // thiếu, không đợi thiếu cả hai.
      if (i.wbsStartDate === null || i.wbsEndDate === null) h.missingWbsDateCount += 1;
    }
  }

  return epics.map((e) => {
    const h = health.get(e.epicKey)!;
    return {
      epicKey: e.epicKey,
      displayName: e.displayName,
      projectKey: e.projectKey,
      status: e.status,
      timezone: e.timezone,
      calendarId: e.calendarId,
      lastSyncedAt: e.lastSyncedAt?.toISOString() ?? null,
      lastError: e.lastError,
      note: e.note,
      dataHealth: {
        phaseCount: h.phaseCount,
        subtaskCount: h.subtaskCount,
        totalEstimateHours: Number(h.totalOriginalS) / SECONDS_PER_HOUR,
        missingWbsDateCount: h.missingWbsDateCount,
        unclassifiedTaskCount: h.unclassifiedTaskCount,
      },
    };
  });
}

/** Sub-task thiếu ngày kế hoạch — phục vụ rủi ro R-08. */
export async function listMissingDates(
  prisma: PrismaClient,
  epicKey: string,
): Promise<MissingDateRow[]> {
  const rows = await prisma.jiraIssue.findMany({
    where: {
      epicKey,
      issueType: 'SUBTASK',
      removedAt: null,
      OR: [{ wbsStartDate: null }, { wbsEndDate: null }],
    },
    select: {
      issueKey: true,
      summary: true,
      parentKey: true,
      wbsStartDate: true,
      wbsEndDate: true,
    },
    orderBy: { issueKey: 'asc' },
  });

  return rows.map((r) => ({
    issueKey: r.issueKey,
    summary: r.summary,
    parentKey: r.parentKey,
    missingStart: r.wbsStartDate === null,
    missingEnd: r.wbsEndDate === null,
  }));
}
