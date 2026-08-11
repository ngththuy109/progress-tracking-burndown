import type { PrismaClient } from '../client.js';

/**
 * Nhật ký chạy job — PRD §4.2.
 *
 * `sync_run` PHẢI được ghi cả khi job thất bại. Không có bản ghi thì người vận
 * hành không phân biệt được "job chạy rồi và hỏng" với "job chưa từng chạy" —
 * hai tình huống cần xử lý hoàn toàn khác nhau.
 */

export async function startSyncRun(
  prisma: PrismaClient,
  args: { epicKey: string; runType: string; startedAt: Date; watermarkBefore?: Date | null },
): Promise<number> {
  const row = await prisma.syncRun.create({
    data: {
      epicKey: args.epicKey,
      runType: args.runType,
      status: 'RUNNING',
      startedAt: args.startedAt,
      watermarkBefore: args.watermarkBefore ?? null,
    },
    select: { id: true },
  });
  return Number(row.id);
}

export async function finishSyncRun(
  prisma: PrismaClient,
  args: {
    id: number;
    status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
    finishedAt: Date;
    startedAt?: Date;
    apiCalls: number;
    rateLimitHits: number;
    daysComputed?: number;
    watermarkAfter?: Date | null;
    errorMessage: string | null;
    /** Bước đang chạy khi job ném lỗi — để màn hình Monitoring chỉ được "lỗi ở đâu". */
    errorStep?: string | null;
    /** Stack trace nguyên văn — chỉ hiện ở màn hình chi tiết lần chạy. */
    errorDetail?: string | null;
  },
): Promise<void> {
  const existing = await prisma.syncRun.findUnique({
    where: { id: BigInt(args.id) },
    select: { startedAt: true },
  });
  const startedAt = args.startedAt ?? existing?.startedAt ?? args.finishedAt;

  await prisma.syncRun.update({
    where: { id: BigInt(args.id) },
    data: {
      status: args.status,
      finishedAt: args.finishedAt,
      durationMs: args.finishedAt.getTime() - startedAt.getTime(),
      apiCallsMade: args.apiCalls,
      rateLimitHits: args.rateLimitHits,
      daysComputed: args.daysComputed ?? 0,
      watermarkAfter: args.watermarkAfter ?? null,
      errorMessage: args.errorMessage,
      errorStep: args.errorStep ?? null,
      errorDetail: args.errorDetail ?? null,
    },
  });
}
