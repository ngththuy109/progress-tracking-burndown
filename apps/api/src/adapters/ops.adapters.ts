import type { PrismaClient } from '@app/db';
import type { DataQualityIssue, DqProblem, OpsHealthResponse, SyncRunDetail } from '@app/shared';
import {
  buildOpsHealth,
  type RawEpicDataQuality,
  type RawErroredEpic,
  type RawPlanDrift,
  type RawRun,
} from '../services/ops-health.service.js';

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
  /** Chi tiết MỘT lần chạy job — bước lỗi, nguyên nhân, stack. `null` = không có. */
  runDetail(runId: string): Promise<SyncRunDetail | null>;
  /** Từng ticket đang lỗi dữ liệu (kể cả ticket đã đánh dấu bỏ qua, kèm cờ). */
  dataQualityIssues(): Promise<readonly DataQualityIssue[]>;
  /**
   * Đặt/gỡ cờ "không cần sửa dữ liệu" cho một Sub-task.
   * Trả về `projectKey` của Epic chứa ticket để tầng route kiểm quyền,
   * hoặc `null` nếu ticket không tồn tại / không phải Sub-task.
   */
  issueProject(issueKey: string): Promise<{ projectKey: string } | null>;
  setDataQualityExempt(args: {
    issueKey: string;
    exempt: boolean;
    by: string;
    at: Date;
  }): Promise<void>;
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
      const [nightlyRows, rateRows, snapRows, dataRows, dataByEpicRows, runRows, erroredRows, driftRows] = await Promise.all([
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
        // Ticket đã đánh dấu "không cần sửa dữ liệu" bị loại khỏi cả tử số lẫn
        // mẫu số — đó chính là ý nghĩa của cờ dq_exempt.
        prisma.$queryRawUnsafe<
          {
            total: bigint;
            no_estimate: bigint;
            unclassified: bigint;
            no_wbs: bigint;
            unparsed: bigint;
            closed_no_worklog: bigint;
          }[]
        >(
          // `closed_no_worklog`: task đã đóng, CÓ ước lượng (>0) mà không còn
          // worklog nào — xem chú thích ở `loadHealthRatios`. `> 0` loại cả 0 lẫn
          // NULL, nên không chồng lấn với `no_estimate`.
          `SELECT COUNT(*)::bigint AS total,
                  COUNT(*) FILTER (WHERE original_estimate_s IS NULL OR original_estimate_s = 0)::bigint AS no_estimate,
                  COUNT(*) FILTER (WHERE phase_code = 'UNCLASSIFIED')::bigint AS unclassified,
                  COUNT(*) FILTER (WHERE wbs_start_date IS NULL OR wbs_end_date IS NULL)::bigint AS no_wbs,
                  COUNT(*) FILTER (WHERE sb_parse_status = 'UNPARSED')::bigint AS unparsed,
                  COUNT(*) FILTER (
                    WHERE status_category = 'done' AND original_estimate_s > 0
                      AND NOT EXISTS (
                        SELECT 1 FROM worklog_entry w
                         WHERE w.issue_key = jira_issue.issue_key AND w.is_deleted = FALSE
                      )
                  )::bigint AS closed_no_worklog
             FROM jira_issue
            WHERE issue_type = 'SUBTASK' AND removed_at IS NULL AND dq_exempt = FALSE`,
        ),
        // Cùng số đo, tách theo TỪNG Epic đang theo dõi — số toàn cục không nói
        // được đội nào phải sửa dữ liệu.
        prisma.$queryRawUnsafe<
          {
            epic_key: string;
            display_name: string;
            total: bigint;
            no_estimate: bigint;
            unclassified: bigint;
            no_wbs: bigint;
            unparsed: bigint;
            closed_no_worklog: bigint;
          }[]
        >(
          `SELECT te.epic_key,
                  te.display_name,
                  COUNT(ji.*)::bigint AS total,
                  COUNT(ji.*) FILTER (WHERE ji.original_estimate_s IS NULL OR ji.original_estimate_s = 0)::bigint AS no_estimate,
                  COUNT(ji.*) FILTER (WHERE ji.phase_code = 'UNCLASSIFIED')::bigint AS unclassified,
                  COUNT(ji.*) FILTER (WHERE ji.wbs_start_date IS NULL OR ji.wbs_end_date IS NULL)::bigint AS no_wbs,
                  COUNT(ji.*) FILTER (WHERE ji.sb_parse_status = 'UNPARSED')::bigint AS unparsed,
                  COUNT(ji.*) FILTER (
                    WHERE ji.status_category = 'done' AND ji.original_estimate_s > 0
                      AND NOT EXISTS (
                        SELECT 1 FROM worklog_entry w
                         WHERE w.issue_key = ji.issue_key AND w.is_deleted = FALSE
                      )
                  )::bigint AS closed_no_worklog
             FROM tracked_epic te
             LEFT JOIN jira_issue ji
               ON ji.epic_key = te.epic_key
              AND ji.issue_type = 'SUBTASK'
              AND ji.removed_at IS NULL
              AND ji.dq_exempt = FALSE
            GROUP BY te.epic_key, te.display_name
            ORDER BY te.epic_key`,
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

      const dataByEpic: RawEpicDataQuality[] = dataByEpicRows.map((r) => {
        const epicTotal = toNumber(r.total);
        const epicRatio = (n: bigint | undefined): number =>
          epicTotal === 0 ? 0 : toNumber(n) / epicTotal;
        return {
          epicKey: r.epic_key,
          displayName: r.display_name,
          total: epicTotal,
          missingEstimateRatio: epicRatio(r.no_estimate),
          unclassifiedPhaseRatio: epicRatio(r.unclassified),
          missingWbsDateRatio: epicRatio(r.no_wbs),
          unparsedSubtaskRatio: epicRatio(r.unparsed),
          closedNoWorklogRatio: epicRatio(r.closed_no_worklog),
        };
      });

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
          closedNoWorklogRatio: ratio(dataRow?.closed_no_worklog),
        },
        dataByEpic,
        recentRuns,
        erroredEpics,
        planDrift,
      });
    },

    async runDetail(runId: string): Promise<SyncRunDetail | null> {
      // `id` là BigInt; chuỗi không phải số thì không có gì để tra.
      if (!/^\d+$/.test(runId)) return null;
      const rows = await prisma.$queryRawUnsafe<
        {
          id: bigint;
          epic_key: string;
          run_type: string;
          status: string;
          started_at: Date;
          finished_at: Date | null;
          duration_ms: number | null;
          api_calls_made: number;
          rate_limit_hits: number;
          days_computed: number;
          error_step: string | null;
          error_message: string | null;
          error_detail: string | null;
        }[]
      >(
        `SELECT id, epic_key, run_type, status, started_at, finished_at, duration_ms,
                api_calls_made, rate_limit_hits, days_computed,
                error_step, error_message, error_detail
           FROM sync_run
          WHERE id = $1`,
        BigInt(runId),
      );
      const r = rows[0];
      if (r === undefined) return null;
      return {
        runId: String(r.id),
        epicKey: r.epic_key,
        runType: r.run_type,
        status: r.status,
        startedAt: r.started_at.toISOString(),
        finishedAt: r.finished_at?.toISOString() ?? null,
        durationSeconds: r.duration_ms === null ? null : r.duration_ms / 1000,
        apiCallsMade: r.api_calls_made,
        rateLimitHits: r.rate_limit_hits,
        daysComputed: r.days_computed,
        errorStep: r.error_step,
        errorMessage: r.error_message,
        errorDetail: r.error_detail,
      };
    },

    async dataQualityIssues(): Promise<readonly DataQualityIssue[]> {
      // Ticket exempt VẪN nằm trong danh sách (kèm cờ) — không thì không gỡ
      // đánh dấu được; nhưng chúng đã bị loại khỏi các SỐ ĐO ở opsHealth().
      const rows = await prisma.$queryRawUnsafe<
        {
          issue_key: string;
          epic_key: string;
          display_name: string;
          summary: string;
          no_estimate: boolean;
          no_wbs: boolean;
          unclassified: boolean;
          unparsed: boolean;
          closed_no_worklog: boolean;
          dq_exempt: boolean;
          dq_exempt_by: string | null;
        }[]
      >(
        // Điều kiện `closed_no_worklog` lặp lại y hệt ở SELECT và WHERE — SQL
        // không cho tham chiếu alias của SELECT trong WHERE, và bốn lỗi cũ cũng
        // đang lặp theo đúng cách này nên giữ nhất quán.
        `SELECT ji.issue_key,
                te.epic_key,
                te.display_name,
                ji.summary,
                (ji.original_estimate_s IS NULL OR ji.original_estimate_s = 0) AS no_estimate,
                (ji.wbs_start_date IS NULL OR ji.wbs_end_date IS NULL) AS no_wbs,
                (ji.phase_code = 'UNCLASSIFIED') AS unclassified,
                (ji.sb_parse_status = 'UNPARSED') AS unparsed,
                (ji.status_category = 'done' AND ji.original_estimate_s > 0
                 AND NOT EXISTS (
                   SELECT 1 FROM worklog_entry w
                    WHERE w.issue_key = ji.issue_key AND w.is_deleted = FALSE
                 )) AS closed_no_worklog,
                ji.dq_exempt,
                ji.dq_exempt_by
           FROM jira_issue ji
           JOIN tracked_epic te ON te.epic_key = ji.epic_key
          WHERE ji.issue_type = 'SUBTASK'
            AND ji.removed_at IS NULL
            AND (ji.original_estimate_s IS NULL OR ji.original_estimate_s = 0
                 OR ji.wbs_start_date IS NULL OR ji.wbs_end_date IS NULL
                 OR ji.phase_code = 'UNCLASSIFIED'
                 OR ji.sb_parse_status = 'UNPARSED'
                 OR (ji.status_category = 'done' AND ji.original_estimate_s > 0
                     AND NOT EXISTS (
                       SELECT 1 FROM worklog_entry w
                        WHERE w.issue_key = ji.issue_key AND w.is_deleted = FALSE
                     )))
          ORDER BY te.epic_key, ji.issue_key`,
      );
      return rows.map((r) => {
        const problems: DqProblem[] = [];
        if (r.no_estimate) problems.push('MISSING_ESTIMATE');
        if (r.no_wbs) problems.push('MISSING_WBS_DATE');
        if (r.unclassified) problems.push('UNCLASSIFIED_PHASE');
        if (r.unparsed) problems.push('UNPARSED_TITLE');
        if (r.closed_no_worklog) problems.push('CLOSED_NO_WORKLOG');
        return {
          issueKey: r.issue_key,
          epicKey: r.epic_key,
          epicDisplayName: r.display_name,
          summary: r.summary,
          problems,
          exempt: r.dq_exempt,
          exemptBy: r.dq_exempt_by,
        };
      });
    },

    async issueProject(issueKey: string): Promise<{ projectKey: string } | null> {
      const rows = await prisma.$queryRawUnsafe<{ project_key: string }[]>(
        `SELECT te.project_key
           FROM jira_issue ji
           JOIN tracked_epic te ON te.epic_key = ji.epic_key
          WHERE ji.issue_key = $1 AND ji.issue_type = 'SUBTASK'`,
        issueKey,
      );
      const r = rows[0];
      return r === undefined ? null : { projectKey: r.project_key };
    },

    async setDataQualityExempt(args): Promise<void> {
      await prisma.jiraIssue.update({
        where: { issueKey: args.issueKey },
        data: {
          dqExempt: args.exempt,
          // Gỡ cờ thì xoá luôn dấu vết ai/lúc nào — thông tin đó thuộc về lần
          // đánh dấu, không phải về ticket.
          dqExemptBy: args.exempt ? args.by : null,
          dqExemptAt: args.exempt ? args.at : null,
        },
      });
    },
  };
}
