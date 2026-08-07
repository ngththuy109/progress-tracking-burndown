import type { EffectiveConfig } from '@app/shared';
import { UNCLASSIFIED_PHASE } from '@app/shared';
import { SubtaskTitleParser, TaskTitleParser } from '@app/engine';
import { toDateOnly, type JiraChangelogEntry, type JiraIssue, type JiraWorklog, type ResolvedFieldMapping } from '@app/jira';
import type { EpicTree } from './fetch-epic-tree.js';

/**
 * GIAI ĐOẠN 3 — đổi dữ liệu thô của Jira thành bản ghi sẵn sàng ghi xuống DB,
 * kèm kết quả phân tách tiêu đề (PRD §4.2).
 *
 * Toàn bộ file này là HÀM THUẦN. Không gọi mạng, không chạm database, không đọc
 * đồng hồ — nên test được ngay, và đó là chỗ chứa mọi quy tắc dễ sai nhất.
 */

export const ISSUE_TYPE = { EPIC: 'EPIC', TASK: 'TASK', SUBTASK: 'SUBTASK' } as const;

export interface IssueRecord {
  issueKey: string;
  issueId: bigint;
  issueType: string;
  parentKey: string | null;
  epicKey: string | null;
  summary: string;
  phaseCode: string | null;
  rawPhaseLabel: string | null;
  statusId: string;
  statusCategory: string;
  originalEstimateS: bigint;
  remainingEstimateS: bigint;
  timeSpentS: bigint;
  jiraCreatedAt: Date;
  jiraUpdatedAt: Date;
  wbsStartDate: Date | null;
  wbsEndDate: Date | null;
  sbProject: string | null;
  sbTeam: string | null;
  sbPhaseRaw: string | null;
  functionName: string | null;
  functionKey: string | null;
  taskType: string | null;
  sbTaskRaw: string | null;
  sbParseStatus: string;
}

export interface WorklogRecord {
  worklogId: bigint;
  issueKey: string;
  epicKey: string;
  authorAccountId: string | null;
  timeSpentS: bigint;
  startedAt: Date;
  jiraCreatedAt: Date;
  jiraUpdatedAt: Date;
  isDeleted: boolean;
}

export interface ChangelogRecord {
  issueKey: string;
  jiraHistoryId: bigint;
  fieldName: string;
  fromValue: string | null;
  toValue: string | null;
  changedAt: Date;
}

export interface BuiltRecords {
  readonly issues: readonly IssueRecord[];
  readonly worklogs: readonly WorklogRecord[];
  readonly changelog: readonly ChangelogRecord[];
  readonly warnings: readonly { code: string; message: string }[];
}

/** Trường changelog mà hệ thống quan tâm. Những trường khác bỏ qua cho nhẹ DB. */
const TRACKED_CHANGELOG_FIELDS = new Set(['status', 'timeestimate', 'timeoriginalestimate', 'Sprint', 'parent']);

/**
 * Log giờ được coi là LÙI NGÀY khi `started` sớm hơn `created` quá ngần này.
 *
 * Ngưỡng 1 ngày chứ không phải 0: log lúc 9 giờ sáng cho công việc tối qua là
 * chuyện bình thường và không cần tính lại gì.
 */
export const RETRO_LOG_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function buildRecords(args: {
  epicKey: string;
  tree: EpicTree;
  worklogsByIssue: ReadonlyMap<string, readonly JiraWorklog[]>;
  changelogByIssue: ReadonlyMap<string, readonly JiraChangelogEntry[]>;
  config: EffectiveConfig;
  fields: ResolvedFieldMapping;
}): BuiltRecords {
  const { epicKey, tree, config, fields } = args;
  const warnings: { code: string; message: string }[] = [];

  const taskParser = new TaskTitleParser(config);
  const subtaskParser = new SubtaskTitleParser(config);

  const issues: IssueRecord[] = [];
  const phaseOfTask = new Map<string, string>();

  if (tree.epic) {
    issues.push(baseRecord(tree.epic, ISSUE_TYPE.EPIC, epicKey, fields));
  }

  for (const t of tree.tasks) {
    const parsed = taskParser.parse(stringField(t.fields['summary']));
    phaseOfTask.set(t.key, parsed.phaseCode);
    warnings.push(...parsed.warnings);

    issues.push({
      ...baseRecord(t, ISSUE_TYPE.TASK, epicKey, fields),
      phaseCode: parsed.phaseCode,
      rawPhaseLabel: parsed.rawPhaseLabel,
    });
  }

  for (const s of tree.subtasks) {
    // Sub-task LUÔN lấy Phase từ Task cha, không lấy từ `[Phase]` trong tiêu đề
    // của chính nó (PRD §2.9.2). Cây Jira là cấu trúc thật, tiêu đề chỉ là chữ.
    const parentKey = parentKeyOf(s.fields);
    const parentPhase = (parentKey ? phaseOfTask.get(parentKey) : undefined) ?? UNCLASSIFIED_PHASE;

    const parsed = subtaskParser.parse(stringField(s.fields['summary']), parentPhase);
    warnings.push(...parsed.warnings);

    issues.push({
      ...baseRecord(s, ISSUE_TYPE.SUBTASK, epicKey, fields),
      // `UNPARSED` KHÔNG có nghĩa là bỏ qua Sub-task này. Nó vẫn được ghi đầy đủ
      // và vẫn cộng dồn vào Burndown (C-11, PRD E-27) — chỉ là không lên được
      // bảng Signboard.
      phaseCode: parsed.phaseCode,
      rawPhaseLabel: null,
      sbProject: parsed.sbProject,
      sbTeam: parsed.sbTeam,
      sbPhaseRaw: parsed.sbPhaseRaw,
      functionName: parsed.functionName,
      functionKey: parsed.functionKey,
      taskType: parsed.taskType,
      sbTaskRaw: parsed.sbTaskRaw,
      sbParseStatus: parsed.sbParseStatus,
    });
  }

  const keyOf = new Map(issues.map((i) => [i.issueKey, i]));

  const worklogs: WorklogRecord[] = [];
  for (const [issueKey, list] of args.worklogsByIssue) {
    if (!keyOf.has(issueKey)) continue;
    for (const w of list) {
      worklogs.push({
        worklogId: BigInt(w.id),
        issueKey,
        epicKey,
        authorAccountId: w.author?.accountId ?? null,
        timeSpentS: BigInt(w.timeSpentSeconds),
        // NGÀY CỦA WORKLOG THEO `started`, KHÔNG theo `created` (C-1, PRD E-03).
        // Dùng nhầm `created` sẽ đẩy mọi giờ log bù sang sai ngày.
        startedAt: new Date(w.started),
        jiraCreatedAt: new Date(w.created),
        jiraUpdatedAt: new Date(w.updated),
        isDeleted: false,
      });
    }
  }

  const changelog: ChangelogRecord[] = [];
  for (const [issueKey, entries] of args.changelogByIssue) {
    if (!keyOf.has(issueKey)) continue;
    for (const e of entries) {
      for (const item of e.items) {
        if (!TRACKED_CHANGELOG_FIELDS.has(item.field)) continue;
        changelog.push({
          issueKey,
          jiraHistoryId: BigInt(e.id),
          fieldName: item.field,
          fromValue: item.from ?? null,
          toValue: item.to ?? null,
          changedAt: new Date(e.created),
        });
      }
    }
  }

  return { issues, worklogs, changelog, warnings };
}

/** Worklog log lùi ngày — đẩy Epic vào hàng đợi tính lại (PRD E-03). */
export function hasRetroLog(worklogs: readonly WorklogRecord[]): boolean {
  return worklogs.some(
    (w) => w.jiraCreatedAt.getTime() - w.startedAt.getTime() > RETRO_LOG_THRESHOLD_MS,
  );
}

function baseRecord(
  issue: JiraIssue,
  issueType: string,
  epicKey: string,
  fields: ResolvedFieldMapping,
): IssueRecord {
  const f = issue.fields;
  const status = f['status'] as { id?: string; statusCategory?: { key?: string } } | undefined;

  return {
    issueKey: issue.key,
    issueId: BigInt(issue.id),
    issueType,
    parentKey: parentKeyOf(f),
    // Bản thân Epic có `epicKey` trỏ về chính nó — nhờ vậy mọi truy vấn theo
    // Epic chỉ cần một điều kiện, không phải `OR issue_key = ...`.
    epicKey,
    summary: stringField(f['summary']),
    phaseCode: null,
    rawPhaseLabel: null,
    statusId: status?.id ?? '',
    // CHỈ đọc `statusCategory.key` (C-4). `status.name` là tiếng Nhật và admin
    // đổi được bất cứ lúc nào.
    statusCategory: status?.statusCategory?.key ?? 'new',
    originalEstimateS: BigInt(numberField(f['timeoriginalestimate'])),
    remainingEstimateS: BigInt(numberField(f['timeestimate'])),
    timeSpentS: BigInt(numberField(f['timespent'])),
    jiraCreatedAt: new Date(stringField(f['created'])),
    jiraUpdatedAt: new Date(stringField(f['updated'])),
    wbsStartDate: parseDateOnly(f[fields.wbsStartDate]),
    wbsEndDate: parseDateOnly(f[fields.wbsEndDate]),
    sbProject: null,
    sbTeam: null,
    sbPhaseRaw: null,
    functionName: null,
    functionKey: null,
    taskType: null,
    sbTaskRaw: null,
    sbParseStatus: 'UNPARSED',
  };
}

function parseDateOnly(v: unknown): Date | null {
  const s = toDateOnly(v);
  return s === null ? null : new Date(`${s}T00:00:00.000Z`);
}

function parentKeyOf(fields: Record<string, unknown>): string | null {
  const parent = fields['parent'];
  if (parent && typeof parent === 'object' && 'key' in parent) {
    const k = (parent as { key: unknown }).key;
    return typeof k === 'string' ? k : null;
  }
  return null;
}

function stringField(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Jira để `null` khi trường thời gian trống — coi như 0, không phải NaN. */
function numberField(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}
