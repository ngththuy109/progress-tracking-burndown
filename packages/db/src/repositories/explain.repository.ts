import type { ChangelogEvent, DateOnly, StatusIdMap, SubtaskRecord, WorklogRecord } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Nạp Sub-task kèm ĐỦ lịch sử để tính lại khối lượng còn lại — phục vụ endpoint
 * giải thích số liệu (T-25).
 *
 * Nạp CÙNG dữ liệu mà job dựng lịch sử (T-18) dùng. Nạp thiếu một nguồn — ví dụ
 * bỏ worklog đã xoá — sẽ làm phần giải thích mâu thuẫn với chính snapshot mà nó
 * đang giải thích, và người điều tra sẽ đi tìm một sai số không tồn tại.
 */

interface IssueRow {
  issue_key: string;
  summary: string | null;
  phase_code: string | null;
  /** JSONB — driver `pg` trả về mảng đã parse (hoặc `null`). Vectơ khoá nhóm N tầng. */
  group_path: unknown;
  original_estimate_seconds: bigint | number | null;
  created_at: Date;
  removed_at: Date | null;
  wbs_start_date: Date | null;
  wbs_end_date: Date | null;
}

interface ChangelogRow {
  issue_key: string;
  field_name: string;
  from_value: string | null;
  to_value: string | null;
  created_at: Date;
  author: string | null;
}

interface WorklogRow {
  worklog_id: bigint;
  issue_key: string;
  time_spent_seconds: bigint | number;
  started_at: Date;
  is_deleted: boolean;
}

const n = (v: bigint | number | null): number => (v === null ? 0 : Number(v));
const dateOnly = (d: Date | null): DateOnly | null => (d === null ? null : d.toISOString().slice(0, 10));

export interface ExplainBundle {
  readonly subtasks: readonly SubtaskRecord[];
  readonly summaries: Record<string, string>;
  readonly statusIdMap: StatusIdMap;
  /** Tra người sửa `timeestimate` theo `${issueKey}:${mốc mili-giây}`. */
  readonly changeAuthors: Record<string, string | null>;
}

export async function loadExplainBundle(
  prisma: PrismaClient,
  epicKey: string,
  statusIdMap: StatusIdMap,
): Promise<ExplainBundle> {
  const [issues, changelog, worklogs] = await Promise.all([
    prisma.$queryRawUnsafe<IssueRow[]>(
      `SELECT issue_key, summary, phase_code, group_path, original_estimate_s AS original_estimate_seconds,
              jira_created_at AS created_at, removed_at, wbs_start_date, wbs_end_date
         FROM jira_issue
        WHERE epic_key = $1 AND issue_type = 'SUBTASK'`,
      epicKey,
    ),
    prisma.$queryRawUnsafe<ChangelogRow[]>(
      `SELECT c.issue_key, c.field_name, c.from_value, c.to_value,
              c.changed_at AS created_at, c.author_id AS author
         FROM issue_changelog_event c
         JOIN jira_issue i ON i.issue_key = c.issue_key
        WHERE i.epic_key = $1 AND i.issue_type = 'SUBTASK'
        ORDER BY c.changed_at ASC`,
      epicKey,
    ),
    prisma.$queryRawUnsafe<WorklogRow[]>(
      `SELECT w.worklog_id, w.issue_key, w.time_spent_s AS time_spent_seconds, w.started_at, w.is_deleted
         FROM worklog_entry w
         JOIN jira_issue i ON i.issue_key = w.issue_key
        WHERE i.epic_key = $1 AND i.issue_type = 'SUBTASK'
        ORDER BY w.started_at ASC`,
      epicKey,
    ),
  ]);

  const changelogByKey = new Map<string, ChangelogEvent[]>();
  const changeAuthors: Record<string, string | null> = {};

  for (const c of changelog) {
    const event: ChangelogEvent = {
      issueKey: c.issue_key,
      field: c.field_name,
      fromValue: c.from_value,
      toValue: c.to_value,
      createdAtMs: c.created_at.getTime(),
    };
    const list = changelogByKey.get(c.issue_key);
    if (list) list.push(event);
    else changelogByKey.set(c.issue_key, [event]);

    if (c.field_name === 'timeestimate') {
      changeAuthors[`${c.issue_key}:${event.createdAtMs}`] = c.author;
    }
  }

  const worklogsByKey = new Map<string, WorklogRecord[]>();
  for (const w of worklogs) {
    const record: WorklogRecord = {
      worklogId: String(w.worklog_id),
      issueKey: w.issue_key,
      timeSpentSeconds: n(w.time_spent_seconds),
      // Lấy `started`, KHÔNG lấy `created` (C-1, E-03).
      startedAtMs: w.started_at.getTime(),
      isDeleted: w.is_deleted,
    };
    const list = worklogsByKey.get(w.issue_key);
    if (list) list.push(record);
    else worklogsByKey.set(w.issue_key, [record]);
  }

  const summaries: Record<string, string> = {};
  const subtasks: SubtaskRecord[] = issues.map((i) => {
    summaries[i.issue_key] = i.summary ?? i.issue_key;
    const gp = i.group_path;
    return {
      key: i.issue_key,
      phaseCode: i.phase_code ?? 'UNCLASSIFIED',
      // Vectơ khoá nhóm N tầng nếu đã backfill; vắng ⇒ engine tự suy `[phaseCode]`.
      // `exactOptionalPropertyTypes`: chỉ đặt trường khi CÓ mảng, không đặt `undefined`.
      ...(Array.isArray(gp) && gp.length > 0 ? { groupPath: gp as string[] } : {}),
      originalEstimateSeconds: n(i.original_estimate_seconds),
      createdAtMs: i.created_at.getTime(),
      removedAtMs: i.removed_at?.getTime() ?? null,
      wbsStartDate: dateOnly(i.wbs_start_date),
      wbsEndDate: dateOnly(i.wbs_end_date),
      changelog: changelogByKey.get(i.issue_key) ?? [],
      worklogs: worklogsByKey.get(i.issue_key) ?? [],
    };
  });

  return { subtasks, summaries, statusIdMap, changeAuthors };
}

/** `actual_remaining_s` của một ngày. `null` = ngày đó chưa có snapshot. */
export async function storedRemainingSeconds(
  prisma: PrismaClient,
  epicKey: string,
  date: DateOnly,
): Promise<number | null> {
  const [row] = await prisma.$queryRawUnsafe<{ actual_remaining_s: bigint | number }[]>(
    `SELECT actual_remaining_s FROM daily_snapshot
      WHERE epic_key = $1 AND snapshot_date = $2::date`,
    epicKey,
    date,
  );
  return row === undefined ? null : n(row.actual_remaining_s);
}

/** Tỉ lệ dữ liệu bẩn, bản đầy đủ cho endpoint sức khoẻ (thêm `unparsedSubtaskRatio`). */
export async function loadHealthRatios(
  prisma: PrismaClient,
  epicKey: string,
): Promise<{
  missingEstimateRatio: number;
  unclassifiedPhaseRatio: number;
  missingWbsDateRatio: number;
  unparsedSubtaskRatio: number;
}> {
  const [row] = await prisma.$queryRawUnsafe<
    { total: bigint; no_estimate: bigint; unclassified: bigint; no_wbs: bigint; unparsed: bigint }[]
  >(
    `SELECT COUNT(*)::bigint AS total,
            COUNT(*) FILTER (WHERE original_estimate_s IS NULL OR original_estimate_s = 0)::bigint AS no_estimate,
            COUNT(*) FILTER (WHERE phase_code = 'UNCLASSIFIED')::bigint AS unclassified,
            COUNT(*) FILTER (WHERE wbs_start_date IS NULL OR wbs_end_date IS NULL)::bigint AS no_wbs,
            COUNT(*) FILTER (WHERE sb_parse_status <> 'OK')::bigint AS unparsed
       FROM jira_issue
      WHERE epic_key = $1 AND issue_type = 'SUBTASK' AND removed_at IS NULL`,
    epicKey,
  );

  const total = Number(row?.total ?? 0n);
  // Epic chưa có Sub-task nào thì mọi tỉ lệ là 0, không phải `NaN`.
  const ratio = (v: bigint | undefined): number => (total === 0 ? 0 : Number(v ?? 0n) / total);

  return {
    missingEstimateRatio: ratio(row?.no_estimate),
    unclassifiedPhaseRatio: ratio(row?.unclassified),
    missingWbsDateRatio: ratio(row?.no_wbs),
    unparsedSubtaskRatio: ratio(row?.unparsed),
  };
}
