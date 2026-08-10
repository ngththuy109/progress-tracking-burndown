import type { PrismaClient } from '@app/db';
import type { OpsHealthResponse } from '@app/shared';
import { buildOpsHealth, type RawErroredEpic, type RawPlanDrift, type RawRun } from '../services/ops-health.service.js';

/**
 * Nối cổng `opsHealth()` của dashboard giám sát vào PostgreSQL (T-33).
 *
 * File DUY NHẤT của nhóm này biết tới Prisma. Tầng route chỉ nhìn thấy cổng, và
 * toàn bộ logic (ngưỡng, sắp xếp, trạng thái rỗng) nằm ở `ops-health.service.ts`
 * dạng hàm thuần — nhờ vậy kiểm được mà không cần dựng cơ sở dữ liệu.
 *
 * Số đo đọc từ CHÍNH các bảng vận hành (`sync_run`, `tracked_epic`,
 * `daily_snapshot`, `jira_issue`, `plan_shift_history`, `phase_rollup`), không
 * đọc lại từ Jira: T-33 chỉ HIỆN số đo của T-27, không tự đo lại.
 */

export interface OpsHealthPort {
  opsHealth(): Promise<OpsHealthResponse>;
}

export interface OpsHealthPortOptions {
  /** Đồng hồ đi qua cổng để test đóng băng được "bây giờ là lúc nào". */
  readonly now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toNumber(v: bigint | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

export function createOpsHealthPort(prisma: PrismaClient, options: OpsHealthPortOptions = {}): OpsHealthPort {
  const now = options.now ?? (() => new Date());

  return {
    async opsHealth(): Promise<OpsHealthResponse> {
      const collectedAt = now();
      const since24h = new Date(collectedAt.getTime() - DAY_MS);

      // Chạy song song: các truy vấn độc lập, không phụ thuộc kết quả của nhau.
      const [nightlyRows, rateRows, snapRows, dataRows, runRows, erroredRows, driftRows] = await Promise.all([
        // Thời lượng lần chạy job đêm (DAILY) gần nhất đã kết thúc.
        prisma.$queryRawUnsafe<{ duration_ms: number | null }[]>(
          `SELECT duration_ms
             FROM sync_run
            WHERE run_type = 'DAILY' AND duration_ms IS NOT NULL
            ORDER BY started_at DESC
            LIMIT 1`,
        ),
        // Tổng số lần bị Jira chặn (429) trong 24 giờ qua.
        prisma.$queryRawUnsafe<{ hits: bigint }[]>(
          `SELECT COALESCE(SUM(rate_limit_hits), 0)::bigint AS hits
             FROM sync_run
            WHERE started_at >= $1`,
          since24h,
        ),
        // Epic ACTIVE đã lỡ ít nhất một snapshot đêm (snapshot mới nhất cũ hơn hôm qua).
        prisma.$queryRawUnsafe<{ behind: bigint }[]>(
          `SELECT COUNT(*)::bigint AS behind
             FROM tracked_epic te
            WHERE te.status = 'ACTIVE'
              AND COALESCE(
                    (SELECT MAX(snapshot_date) FROM daily_snapshot ds WHERE ds.epic_key = te.epic_key),
                    DATE '1900-01-01'
                  ) < CURRENT_DATE - 1`,
        ),
        // Chất lượng dữ liệu trên toàn bộ Sub-task đang hoạt động (không đọc token).
        prisma.$queryRawUnsafe<
          { total: bigint; no_estimate: bigint; unclassified: bigint; no_wbs: bigint; unparsed: bigint }[]
        >(
          `SELECT COUNT(*)::bigint AS total,
                  COUNT(*) FILTER (WHERE original_estimate_s IS NULL OR original_estimate_s = 0)::bigint AS no_estimate,
                  COUNT(*) FILTER (WHERE phase_code = 'UNCLASSIFIED')::bigint AS unclassified,
                  COUNT(*) FILTER (WHERE wbs_start_date IS NULL OR wbs_end_date IS NULL)::bigint AS no_wbs,
                  COUNT(*) FILTER (WHERE sb_parse_status = 'UNPARSED')::bigint AS unparsed
             FROM jira_issue
            WHERE resolved_role = 'LEAF' AND removed_at IS NULL`,
        ),
        // 20 lần chạy job gần nhất — mới nhất trước.
        prisma.$queryRawUnsafe<
          {
            id: bigint;
            epic_key: string;
            run_type: string;
            status: string;
            started_at: Date;
            duration_ms: number | null;
            error_message: string | null;
          }[]
        >(
          `SELECT id, epic_key, run_type, status, started_at, duration_ms, error_message
             FROM sync_run
            ORDER BY started_at DESC
            LIMIT 20`,
        ),
        // Epic đang ở trạng thái lỗi, kèm NGUYÊN VĂN thông báo lỗi.
        prisma.$queryRawUnsafe<
          { epic_key: string; last_error: string | null; last_synced_at: Date | null; added_at: Date }[]
        >(
          `SELECT epic_key, last_error, last_synced_at, added_at
             FROM tracked_epic
            WHERE status = 'ERROR'`,
        ),
        // Tổng mức trôi kế hoạch theo (Epic, Phase) — chỉ cộng chiều lùi ra xa.
        prisma.$queryRawUnsafe<
          { epic_key: string; phase_code: string; shifted: bigint; plan_workdays: number | null }[]
        >(
          `SELECT ps.epic_key,
                  ps.phase_code,
                  SUM(GREATEST(ps.shifted_workdays, 0))::bigint AS shifted,
                  MAX(pr.plan_workdays) AS plan_workdays
             FROM plan_shift_history ps
             LEFT JOIN phase_rollup pr
               ON pr.epic_key = ps.epic_key AND pr.phase_code = ps.phase_code
            WHERE ps.shift_type = 'END_MOVED'
            GROUP BY ps.epic_key, ps.phase_code`,
        ),
      ]);

      const durationMs = nightlyRows[0]?.duration_ms ?? null;
      const dataRow = dataRows[0];
      const total = toNumber(dataRow?.total);
      const ratio = (n: bigint | undefined): number => (total === 0 ? 0 : toNumber(n) / total);

      const recentRuns: RawRun[] = runRows.map((r) => ({
        runId: String(r.id),
        epicKey: r.epic_key,
        runType: r.run_type,
        status: r.status,
        startedAt: r.started_at,
        durationMs: r.duration_ms ?? null,
        errorMessage: r.error_message,
      }));

      const erroredEpics: RawErroredEpic[] = erroredRows.map((r) => ({
        epicKey: r.epic_key,
        // Status = ERROR mà thiếu `last_error` là bất thường; vẫn phải nói được
        // gì đó thay vì để trống, và chỉ đường tới nơi có nguyên văn lỗi.
        lastError: r.last_error ?? 'Không rõ lỗi — xem log worker',
        // "Lỗi bao lâu rồi" = từ lần đồng bộ thành công gần nhất; chưa từng đồng
        // bộ thì tính từ lúc thêm Epic.
        since: r.last_synced_at ?? r.added_at,
      }));

      const planDrift: RawPlanDrift[] = driftRows.map((r) => ({
        epicKey: r.epic_key,
        phaseCode: r.phase_code,
        shiftedWorkdays: toNumber(r.shifted),
        planWorkdays: toNumber(r.plan_workdays),
      }));

      return buildOpsHealth({
        collectedAt,
        nightlyDurationMinutes: durationMs === null ? null : Math.round(durationMs / 60_000),
        rateLimitHits24h: toNumber(rateRows[0]?.hits),
        erroredEpicCount: erroredEpics.length,
        snapshotBehindCount: toNumber(snapRows[0]?.behind),
        data: {
          total,
          missingEstimateRatio: ratio(dataRow?.no_estimate),
          unclassifiedPhaseRatio: ratio(dataRow?.unclassified),
          missingWbsDateRatio: ratio(dataRow?.no_wbs),
          unparsedSubtaskRatio: ratio(dataRow?.unparsed),
        },
        recentRuns,
        erroredEpics,
        planDrift,
      });
    },
  };
}
