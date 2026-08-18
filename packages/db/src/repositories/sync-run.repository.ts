import type { PrismaClient } from '../client.js';

/**
 * Nhật ký chạy job — PRD §4.2.
 *
 * `sync_run` PHẢI được ghi cả khi job thất bại. Không có bản ghi thì người vận
 * hành không phân biệt được "job chạy rồi và hỏng" với "job chưa từng chạy" —
 * hai tình huống cần xử lý hoàn toàn khác nhau.
 */

/**
 * Thông báo mặc định gắn cho lần chạy bị dọn vì kẹt — cố ý ngắn gọn, nói rõ đây
 * là dọn TỰ ĐỘNG chứ không phải lỗi nghiệp vụ, để người trực khỏi đi tìm stack.
 */
export const STALE_RUN_ERROR_MESSAGE =
  'Worker dừng giữa chừng — lần chạy không kết thúc (dọn tự động).';

/**
 * Dọn các lần chạy KẸT ở `RUNNING` — trả về số dòng đã dọn.
 *
 * VÌ SAO CẦN: `start()` ghi `RUNNING` ngay từ đầu, `finish()` mới đổi sang
 * SUCCESS/FAILED. Nếu worker bị giết cứng (SIGKILL/OOM/mất điện) hoặc chính
 * database sập ĐÚNG LÚC `finish(FAILED)` đang ghi, dòng đó kẹt ở `RUNNING` MÃI
 * MÃI: màn hình Monitoring báo "đang chạy" cho một job đã chết từ lâu, người
 * trực không biết nó xong chưa. Hạn chót cấp driver (xem `client.ts`) chặn được
 * job treo, nhưng KHÔNG cứu được dòng đã mồ côi — chỉ có quét dọn này làm được.
 *
 * `olderThanMs` là biên an toàn: một lần chạy thật KHÔNG bao giờ ở `RUNNING` lâu
 * tới vậy (kể cả backfill 500 Sub-task cũng chỉ vài phút), nên quá mốc này gần
 * như chắc chắn là mồ côi. Đặt rộng (mặc định 1 giờ ở nơi gọi) để TUYỆT ĐỐI
 * không dọn nhầm một job đang chạy thật — nếu nó xong muộn, `finish()` vẫn ghi
 * đè SUCCESS theo `id` như thường.
 *
 * KHÔNG lọc theo `run_type`: một lần DAILY/RECONCILE mồ côi cũng gây hiểu nhầm y
 * hệt BACKFILL. KHÔNG đụng tới `tracked_epic`: dòng kẹt chỉ là vết quan sát, đổi
 * trạng thái Epic là việc của luồng đồng bộ, không phải của quét dọn.
 */
export async function failStaleSyncRuns(
  prisma: PrismaClient,
  args: { now: Date; olderThanMs: number; errorMessage?: string },
): Promise<number> {
  const cutoff = new Date(args.now.getTime() - args.olderThanMs);
  const result = await prisma.syncRun.updateMany({
    where: { status: 'RUNNING', startedAt: { lt: cutoff } },
    data: {
      status: 'FAILED',
      finishedAt: args.now,
      // `updateMany` không tính được duration theo từng dòng; để 0 như runbook.
      durationMs: 0,
      errorMessage: args.errorMessage ?? STALE_RUN_ERROR_MESSAGE,
    },
  });
  return result.count;
}

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
