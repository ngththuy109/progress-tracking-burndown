import type { DailySnapshotData } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Ghi và đọc `daily_snapshot` — PRD §4.4, E-12, E-19.
 *
 * `UNIQUE (epic_key, snapshot_date)` là lớp đảm bảo chạy lại không nhân đôi
 * (C-6). Nó hoạt động kể cả khi khoá Redis hỏng hoàn toàn.
 */

const toDate = (d: string): Date => new Date(`${d}T00:00:00Z`);
const fromDate = (d: Date): string => d.toISOString().slice(0, 10);

export interface UpsertSnapshotResult {
  readonly written: number;
  /**
   * Số snapshot bị BỎ QUA vì dữ liệu trong DB mới hơn (E-19).
   *
   * Trả về con số này thay vì bỏ qua im lặng: nếu nó luôn khác 0 thì có hai job
   * đang giẫm chân nhau và người vận hành cần biết.
   */
  readonly skippedStale: number;
}

/**
 * UPSERT snapshot, CHỐNG GHI ĐÈ BẰNG DỮ LIỆU CŨ — E-19.
 *
 * `UNIQUE` một mình KHÔNG chống được ca này: UPSERT là "ai ghi sau thì thắng",
 * mà ghi sau chưa chắc là mới hơn. Job đọc Jira lúc 00:01 có thể ghi xong SAU
 * job đọc lúc 00:03 (vì nó chậm hơn) và đè mất dữ liệu mới.
 *
 * Bắt buộc phải có mệnh đề `WHERE source_read_at < EXCLUDED.source_read_at`.
 * Prisma không sinh được mệnh đề đó nên phải viết SQL thô.
 */
export async function upsertSnapshots(
  prisma: PrismaClient,
  rows: readonly DailySnapshotData[],
  computedAt: Date,
): Promise<UpsertSnapshotResult> {
  if (rows.length === 0) return { written: 0, skippedStale: 0 };

  let written = 0;

  // Một transaction cho cả lô: ghi dở dang sẽ để lại biểu đồ nửa cũ nửa mới.
  await prisma.$transaction(async (tx) => {
    for (const s of rows) {
      const affected = await tx.$executeRaw`
        INSERT INTO daily_snapshot (
          epic_key, snapshot_date, snapshot_at_utc,
          planned_remaining_s, actual_remaining_s,
          total_scope_s, total_spent_s,
          scope_added_s, scope_removed_s,
          count_todo, count_in_progress, count_done,
          per_phase, per_tier, is_recomputed, computed_at, source_read_at
        ) VALUES (
          ${s.epicKey}, ${toDate(s.snapshotDate)}::date, ${new Date(s.snapshotAtUtcMs)},
          ${BigInt(Math.round(s.plannedRemainingS))}, ${BigInt(Math.round(s.actualRemainingS))},
          ${BigInt(Math.round(s.totalScopeS))}, ${BigInt(Math.round(s.totalSpentS))},
          ${BigInt(Math.round(s.scopeAddedS))}, ${BigInt(Math.round(s.scopeRemovedS))},
          ${s.countTodo}, ${s.countInProgress}, ${s.countDone},
          ${JSON.stringify(s.perPhase)}::jsonb,
          ${s.perTier === undefined ? null : JSON.stringify(s.perTier)}::jsonb,
          false, ${computedAt}, ${new Date(s.sourceReadAtMs)}
        )
        ON CONFLICT (epic_key, snapshot_date) DO UPDATE SET
          snapshot_at_utc     = EXCLUDED.snapshot_at_utc,
          planned_remaining_s = EXCLUDED.planned_remaining_s,
          actual_remaining_s  = EXCLUDED.actual_remaining_s,
          total_scope_s       = EXCLUDED.total_scope_s,
          total_spent_s       = EXCLUDED.total_spent_s,
          scope_added_s       = EXCLUDED.scope_added_s,
          scope_removed_s     = EXCLUDED.scope_removed_s,
          count_todo          = EXCLUDED.count_todo,
          count_in_progress   = EXCLUDED.count_in_progress,
          count_done          = EXCLUDED.count_done,
          per_phase           = EXCLUDED.per_phase,
          per_tier            = EXCLUDED.per_tier,
          is_recomputed       = true,
          computed_at         = EXCLUDED.computed_at,
          source_read_at      = EXCLUDED.source_read_at
        WHERE daily_snapshot.source_read_at < EXCLUDED.source_read_at`;

      written += affected;
    }
  });

  return { written, skippedStale: rows.length - written };
}

/** Ngày ĐÃ CÓ snapshot — để dò ngày thiếu (E-12). */
export async function listSnapshotDates(
  prisma: PrismaClient,
  epicKey: string,
): Promise<Set<string>> {
  const rows = await prisma.dailySnapshot.findMany({
    where: { epicKey },
    select: { snapshotDate: true },
  });
  return new Set(rows.map((r) => fromDate(r.snapshotDate)));
}

/**
 * Tổng phạm vi của ngày ngay TRƯỚC `date` — để tính `scope_added/removed`.
 *
 * Lấy ngày gần nhất trước đó chứ không phải `date − 1`: ngày hôm trước có thể
 * là cuối tuần và không có snapshot.
 */
export async function previousTotalScope(
  prisma: PrismaClient,
  epicKey: string,
  date: string,
): Promise<number | undefined> {
  const row = await prisma.dailySnapshot.findFirst({
    where: { epicKey, snapshotDate: { lt: toDate(date) } },
    orderBy: { snapshotDate: 'desc' },
    select: { totalScopeS: true },
  });
  return row === null ? undefined : Number(row.totalScopeS);
}

export async function loadSnapshots(
  prisma: PrismaClient,
  epicKey: string,
  from?: string,
  to?: string,
) {
  return prisma.dailySnapshot.findMany({
    where: {
      epicKey,
      ...(from || to
        ? {
            snapshotDate: {
              ...(from ? { gte: toDate(from) } : {}),
              ...(to ? { lte: toDate(to) } : {}),
            },
          }
        : {}),
    },
    orderBy: { snapshotDate: 'asc' },
  });
}
