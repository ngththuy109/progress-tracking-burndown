import type { EffectiveConfig, SignboardPic, SubtaskParseResult } from '@app/shared';
import { UNCLASSIFIED_PHASE } from '@app/shared';
import { GroupKeyResolver, SubtaskTitleParser, TaskTitleParser } from '@app/engine';
import {
  readRequestParticipants,
  readWbsDates,
  type JiraChangelogEntry,
  type JiraIssue,
  type JiraWorklog,
  type ResolvedFieldMapping,
} from '@app/jira';
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
  /**
   * Vectơ khoá nhóm theo tầng (DYNAMIC-TIERS-DESIGN.md §4.2) — chỉ LÁ mang, Epic/Task
   * để `null`. Config mặc định 1 tầng ⇒ `[phaseCode]`. `phaseCode` giữ = phần tử tầng
   * Phase để tương thích ngược (Signboard, lọc theo Phase, ~74 file tham chiếu).
   */
  groupPath: string[] | null;
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
  /** "Request participants" đã bỏ trùng; mảng rỗng khi không có / chưa cấu hình. */
  sbRequestParticipants: readonly SignboardPic[];
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

/**
 * Giới hạn độ dài (ĐẾM THEO KÝ TỰ) của sáu cột VARCHAR bóc từ tiêu đề Sub-task.
 * PHẢI khớp `model JiraIssue` trong `packages/db/prisma/schema.prisma`.
 *
 * Vì sao phải siết ở tầng này: ô giữ chỗ `{task}` trong mẫu là `.+?` NUỐT TRỌN
 * phần đuôi tiêu đề, còn `{project|team|phase|function}` nuốt trọn phần giữa hai
 * ngoặc. Một tiêu đề dài bất thường vì thế khiến `prisma.jiraIssue.upsert()` ném
 * "value too long for the column's type" và làm HỎNG CẢ LƯỢT đồng bộ Epic — dù
 * lỗi chỉ nằm ở đúng một Sub-task — rồi đẩy Epic sang trạng thái ERROR (xem
 * issue.repository.ts + khối catch của sync-epic.job.ts).
 *
 * `phase_code`/`task_type` KHÔNG nằm ở đây: chúng do cấu hình sinh ra (mã Phase,
 * mã cột Signboard) nên đã tự bị chặn độ dài từ chính cấu hình.
 *
 * Cắt cho vừa cột đúng theo tinh thần E-27: tiêu đề đặt sai vẫn được GHI và cộng
 * dồn đầy đủ vào Burndown, chỉ là phần hiển thị trên Signboard bị cắt ngắn. Cắt
 * là phép THUẦN và TẤT ĐỊNH nên chạy hai lần vẫn ra kết quả y hệt (C-6).
 */
const SUBTASK_COLUMN_LIMITS = {
  sbProject: 64,
  sbTeam: 64,
  sbPhaseRaw: 64,
  functionName: 128,
  functionKey: 128,
  sbTaskRaw: 64,
} as const;

/**
 * Cắt chuỗi cho vừa `maxChars`, ĐẾM THEO CODE POINT.
 *
 * Duyệt bằng `Array.from` (theo code point) chứ không `slice`: `slice` cắt theo
 * code unit UTF-16 nên có thể xé đôi một cặp surrogate (emoji, CJK ở mặt phẳng bổ
 * sung) thành nửa ký tự rác mà Postgres từ chối mã hoá UTF-8 — tránh được lỗi này
 * lại rơi vào lỗi khác. Postgres cũng đo độ dài VARCHAR theo code point nên đếm
 * cách này mới khớp đúng giới hạn cột.
 */
function fitColumn(value: string, maxChars: number): string {
  const cps = Array.from(value);
  return cps.length <= maxChars ? value : cps.slice(0, maxChars).join('');
}

/**
 * Siết sáu trường bóc từ tiêu đề Sub-task cho vừa cột VARCHAR, và ghi một cảnh
 * báo `FIELD_TRUNCATED` gộp chung nếu có trường bị cắt.
 *
 * Cảnh báo chứ không im lặng: cắt dữ liệu người dùng mà không báo thì Signboard
 * hiển thị thiếu chữ trông y như tiêu đề gõ sai, rất khó lần ra.
 */
function fitSubtaskColumns(
  parsed: SubtaskParseResult,
  issueKey: string,
  warnings: { code: string; message: string }[],
): Pick<
  IssueRecord,
  'sbProject' | 'sbTeam' | 'sbPhaseRaw' | 'functionName' | 'functionKey' | 'sbTaskRaw'
> {
  const truncated: string[] = [];

  const fit = (value: string | null, max: number, column: string): string | null => {
    if (value === null) return null;
    const clamped = fitColumn(value, max);
    if (clamped !== value) truncated.push(`${column} (${Array.from(value).length}→${max})`);
    return clamped;
  };

  const L = SUBTASK_COLUMN_LIMITS;
  const out = {
    sbProject: fit(parsed.sbProject, L.sbProject, 'sb_project'),
    sbTeam: fit(parsed.sbTeam, L.sbTeam, 'sb_team'),
    sbPhaseRaw: fit(parsed.sbPhaseRaw, L.sbPhaseRaw, 'sb_phase_raw'),
    functionName: fit(parsed.functionName, L.functionName, 'function_name'),
    functionKey: fit(parsed.functionKey, L.functionKey, 'function_key'),
    sbTaskRaw: fit(parsed.sbTaskRaw, L.sbTaskRaw, 'sb_task_raw'),
  };

  if (truncated.length > 0) {
    warnings.push({
      code: 'FIELD_TRUNCATED',
      message:
        `Sub-task ${issueKey}: tiêu đề vượt quá giới hạn cột, đã cắt bớt khi lưu: ` +
        `${truncated.join(', ')}. Bản ghi vẫn được lưu và số liệu Burndown không đổi; ` +
        `rút gọn tiêu đề trên Jira nếu cần Signboard hiển thị đủ.`,
    });
  }

  return out;
}

export function buildRecords(args: {
  epicKey: string;
  tree: EpicTree;
  worklogsByIssue: ReadonlyMap<string, readonly JiraWorklog[]>;
  changelogByIssue: ReadonlyMap<string, readonly JiraChangelogEntry[]>;
  config: EffectiveConfig;
  fields: ResolvedFieldMapping;
  /**
   * `accountId` → tên hiển thị, tra sẵn từ Jira (worker gọi trước khi build vì
   * đây là hàm THUẦN, không tự gọi mạng). Dùng để điền tên cho "Request
   * participants" chỉ có accountId. Bỏ trống thì PIC giữ tên field trả về (hoặc
   * `null`).
   */
  participantNames?: ReadonlyMap<string, string>;
}): BuiltRecords {
  const { epicKey, tree, config, fields } = args;
  const warnings: { code: string; message: string }[] = [];

  const taskParser = new TaskTitleParser(config);
  const subtaskParser = new SubtaskTitleParser(config);
  // Suy vectơ khoá nhóm N tầng cho lá. Dựng SẴN một lần (biên dịch mẫu từng tầng).
  const groupResolver = new GroupKeyResolver(config);

  const issues: IssueRecord[] = [];
  const phaseOfTask = new Map<string, string>();
  // Title NGUYÊN VĂN của Task cha — tầng GROUP nguồn PARENT_TASK_TITLE bóc chiều
  // riêng (VD giai đoạn) từ đây, KHÔNG đi qua kết quả parse Phase.
  const titleOfTask = new Map<string, string>();

  if (tree.epic) {
    issues.push(baseRecord(tree.epic, ISSUE_TYPE.EPIC, epicKey, fields));
  }

  for (const t of tree.tasks) {
    const taskTitle = stringField(t.fields['summary']);
    const parsed = taskParser.parse(taskTitle);
    phaseOfTask.set(t.key, parsed.phaseCode);
    titleOfTask.set(t.key, taskTitle);
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
    const summary = stringField(s.fields['summary']);

    const parsed = subtaskParser.parse(summary, parentPhase);
    warnings.push(...parsed.warnings);

    // Vectơ khoá nhóm N tầng (DYNAMIC-TIERS-DESIGN.md §5). Config mặc định (1 tầng
    // PHASE/PARENT_TASK_TITLE) ⇒ groupPath = [parentPhase] và phaseCode = parentPhase —
    // ĐÚNG bằng `parsed.phaseCode` hôm nay (Sub-task luôn kế thừa Phase của Task cha).
    const keys = groupResolver.resolve({
      parentPhase,
      parentTaskTitle: (parentKey ? titleOfTask.get(parentKey) : undefined) ?? null,
      leafTitle: summary,
      leafLabels: labelsOf(s.fields),
    });

    issues.push({
      ...baseRecord(s, ISSUE_TYPE.SUBTASK, epicKey, fields),
      // `UNPARSED` KHÔNG có nghĩa là bỏ qua Sub-task này. Nó vẫn được ghi đầy đủ
      // và vẫn cộng dồn vào Burndown (C-11, PRD E-27) — chỉ là không lên được
      // bảng Signboard.
      phaseCode: keys.phaseCode,
      groupPath: keys.groupPath,
      rawPhaseLabel: null,
      // Sáu trường bóc từ tiêu đề được siết cho vừa cột VARCHAR NGAY TẠI ĐÂY.
      // Một tiêu đề dài bất thường mà không siết sẽ làm cả lượt đồng bộ Epic đổ
      // vì "value too long" (xem `fitSubtaskColumns`).
      ...fitSubtaskColumns(parsed, s.key, warnings),
      taskType: parsed.taskType,
      sbParseStatus: parsed.sbParseStatus,
      // Người phụ trách (PIC) — nguồn cho cột PIC của Signboard.
      sbRequestParticipants: readSubtaskPics(s, fields, args.participantNames),
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

/**
 * Người phụ trách (PIC) của một Sub-task: đọc "Request participants", điền tên
 * hiển thị đã tra được, và SẮP theo `accountId` cho kết quả TẤT ĐỊNH (C-6 — ghi
 * lại nhiều lần ra cùng JSON). `readRequestParticipants` đã bỏ trùng theo accountId.
 */
function readSubtaskPics(
  issue: JiraIssue,
  fields: ResolvedFieldMapping,
  names: ReadonlyMap<string, string> | undefined,
): SignboardPic[] {
  return readRequestParticipants(issue, fields)
    .map((r) => ({
      accountId: r.accountId,
      displayName: r.displayName ?? names?.get(r.accountId) ?? null,
    }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
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
  const wbs = readWbsDates(issue, fields);

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
    // Chỉ LÁ mang vectơ khoá nhóm; Epic/Task để `null` (vòng Sub-task ghi đè).
    groupPath: null,
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
    wbsStartDate: dateFromDateOnly(wbs.start),
    wbsEndDate: dateFromDateOnly(wbs.end),
    sbProject: null,
    sbTeam: null,
    sbPhaseRaw: null,
    functionName: null,
    functionKey: null,
    taskType: null,
    sbTaskRaw: null,
    sbParseStatus: 'UNPARSED',
    // Chỉ Sub-task mới có PIC; Epic/Task luôn rỗng. Sub-task ghi đè ở buildRecords.
    sbRequestParticipants: [],
  };
}

/**
 * Chuỗi `'YYYY-MM-DD'` (từ `readWbsDates`) → `Date` lúc nửa đêm UTC.
 *
 * Ngày kế hoạch neo theo UTC để so sánh nhất quán, không phụ thuộc múi giờ máy
 * chạy worker. `readWbsDates` đã cắt phần giờ theo múi giờ trong chuỗi gốc rồi.
 */
function dateFromDateOnly(s: string | null): Date | null {
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

/** Nhãn Jira (`labels`) của issue — mảng chuỗi; nguồn cho tầng nhóm dựa `LABEL`. */
function labelsOf(fields: Record<string, unknown>): string[] {
  const raw = fields['labels'];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** Jira để `null` khi trường thời gian trống — coi như 0, không phải NaN. */
function numberField(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}
