import type { DateOnly, SnapshotRow } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Đọc snapshot để vẽ biểu đồ — PRD §5.1.
 *
 * MỘT truy vấn duy nhất trên `daily_snapshot`, dùng index `idx_snapshot_chart`
 * `(epic_key, snapshot_date)`. Card T-24 có test đếm số truy vấn: API biểu đồ
 * chạm database đúng một lần cho phần snapshot, không hơn.
 */

interface RawSnapshot {
  snapshot_date: Date;
  planned_remaining_s: bigint | number;
  actual_remaining_s: bigint | number;
  total_scope_s: bigint | number;
  total_spent_s: bigint | number;
  scope_added_s: bigint | number;
  scope_removed_s: bigint | number;
  count_todo: number;
  count_in_progress: number;
  count_done: number;
  per_phase: unknown;
}

/** `BigInt` không so sánh được bằng `toEqual` và không lọt qua `JSON.stringify`. */
function toNumber(v: bigint | number): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

function toDateOnly(d: Date): DateOnly {
  return d.toISOString().slice(0, 10);
}

export async function loadSnapshotsForChart(
  prisma: PrismaClient,
  epicKey: string,
  from: DateOnly,
  to: DateOnly,
): Promise<SnapshotRow[]> {
  const rows = await prisma.$queryRawUnsafe<RawSnapshot[]>(
    `SELECT snapshot_date, planned_remaining_s, actual_remaining_s, total_scope_s,
            total_spent_s, scope_added_s, scope_removed_s,
            count_todo, count_in_progress, count_done, per_phase
       FROM daily_snapshot
      WHERE epic_key = $1
        AND snapshot_date BETWEEN $2::date AND $3::date
      ORDER BY snapshot_date ASC`,
    epicKey,
    from,
    to,
  );

  return rows.map((r) => ({
    snapshotDate: toDateOnly(r.snapshot_date),
    plannedRemainingS: toNumber(r.planned_remaining_s),
    actualRemainingS: toNumber(r.actual_remaining_s),
    totalScopeS: toNumber(r.total_scope_s),
    totalSpentS: toNumber(r.total_spent_s),
    scopeAddedS: toNumber(r.scope_added_s),
    scopeRemovedS: toNumber(r.scope_removed_s),
    countTodo: r.count_todo,
    countInProgress: r.count_in_progress,
    countDone: r.count_done,
    perPhase: readPerPhase(r.per_phase),
  }));
}

/**
 * Đọc cột JSON `per_phase`.
 *
 * Cột JSON là biên giữa hai hệ kiểu — dữ liệu cũ có thể thiếu trường mà không có
 * gì báo. Đọc từng trường có mặc định thay vì ép kiểu cả cục.
 */
function readPerPhase(raw: unknown): SnapshotRow['perPhase'] {
  if (!Array.isArray(raw)) return [];

  const out: SnapshotRow['perPhase'][number][] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o['phaseCode'] !== 'string') continue;

    out.push({
      phaseCode: o['phaseCode'],
      remainingS: num(o['remainingS']),
      spentS: num(o['spentS']),
      originalS: num(o['originalS']),
      countTodo: num(o['countTodo']),
      countInProgress: num(o['countInProgress']),
      countDone: num(o['countDone']),
      // `null` có nghĩa THẬT ở đây: Phase thiếu ngày kế hoạch thì không vẽ
      // đường Kế hoạch. Đổi thành 0 sẽ vẽ ra một đường chạm đáy giả.
      plannedRemainingS: typeof o['plannedRemainingS'] === 'number' ? o['plannedRemainingS'] : null,
    });
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Tỉ lệ dữ liệu bẩn của một Epic.
 *
 * Đếm bằng SQL chứ không nạp hết Sub-task về rồi duyệt: một Epic có thể có vài
 * trăm Sub-task và ba con số này xuất hiện trong MỌI phản hồi biểu đồ.
 */
export async function loadDataQualityRatios(
  prisma: PrismaClient,
  epicKey: string,
): Promise<{
  missingEstimateRatio: number;
  unclassifiedPhaseRatio: number;
  missingWbsDateRatio: number;
}> {
  const [row] = await prisma.$queryRawUnsafe<
    { total: bigint; no_estimate: bigint; unclassified: bigint; no_wbs: bigint }[]
  >(
    `SELECT COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE original_estimate_s IS NULL OR original_estimate_s = 0)::bigint AS no_estimate,
            COUNT(*) FILTER (WHERE phase_code = 'UNCLASSIFIED')::bigint AS unclassified,
            COUNT(*) FILTER (WHERE wbs_start_date IS NULL OR wbs_end_date IS NULL)::bigint AS no_wbs
       FROM jira_issue
      WHERE epic_key = $1 AND resolved_role = 'LEAF' AND removed_at IS NULL`,
    epicKey,
  );

  const total = Number(row?.total ?? 0n);
  // Epic chưa có Sub-task nào thì mọi tỉ lệ là 0, không phải NaN. `0/0` cho ra
  // `NaN`, và `NaN` lọt qua JSON thành `null` ở tận màn hình.
  const ratio = (n: bigint | undefined): number => (total === 0 ? 0 : Number(n ?? 0n) / total);

  return {
    missingEstimateRatio: ratio(row?.no_estimate),
    unclassifiedPhaseRatio: ratio(row?.unclassified),
    missingWbsDateRatio: ratio(row?.no_wbs),
  };
}
