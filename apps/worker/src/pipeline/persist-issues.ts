import type { EffectiveConfig, HierarchyRole, SubtaskParseResult, TitleSlot } from '@app/shared';
import { phaseCarrierLevelIndex, UNCLASSIFIED_PHASE } from '@app/shared';
import { SubtaskTitleParser, TaskTitleParser, toFunctionKey } from '@app/engine';
import { readWbsDates, type JiraChangelogEntry, type JiraIssue, type JiraWorklog, type ResolvedFieldMapping } from '@app/jira';
import type { IssueTree } from './fetch-epic-tree.js';

/**
 * GIAI ĐOẠN 3 — đổi dữ liệu thô của Jira thành bản ghi sẵn sàng ghi xuống DB,
 * kèm kết quả phân tách tiêu đề (PRD §4.2).
 *
 * Toàn bộ file này là HÀM THUẦN. Không gọi mạng, không chạm database, không đọc
 * đồng hồ — nên test được ngay, và đó là chỗ chứa mọi quy tắc dễ sai nhất.
 *
 * Vai (ROOT/GROUP/LEAF) và nguồn Phase/hàng/cột Signboard đến từ
 * `config.hierarchyProfile` — xem docs/FLEXIBLE-HIERARCHY-PROPOSAL.md.
 */

export const ISSUE_TYPE = { EPIC: 'EPIC', TASK: 'TASK', SUBTASK: 'SUBTASK' } as const;

export interface IssueRecord {
  issueKey: string;
  issueId: bigint;
  issueType: string;
  resolvedRole: string;
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

/**
 * Giá trị chuỗi của một field Jira, chấp nhận mọi hình dạng thường gặp:
 * chuỗi trần (labels từng cái), mảng chuỗi (labels), mảng object có `name`
 * (components) hoặc `value` (select). Field vắng mặt → mảng rỗng.
 */
function fieldStringValues(fields: Record<string, unknown>, ref: string): string[] {
  const unwrap = (v: unknown): string | null => {
    if (typeof v === 'string') return v.trim() || null;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['name'] === 'string') return o['name'].trim() || null;
      if (typeof o['value'] === 'string') return o['value'].trim() || null;
    }
    return null;
  };

  const raw = fields[ref];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(unwrap).filter((s): s is string => s !== null);
}

/** Giá trị một Ô của kết quả phân tách tiêu đề, theo tên ô. */
function slotValue(parsed: SubtaskParseResult, slot: TitleSlot): string | null {
  switch (slot) {
    case 'project':
      return parsed.sbProject;
    case 'team':
      return parsed.sbTeam;
    case 'phase':
      return parsed.sbPhaseRaw;
    case 'function':
      return parsed.functionName;
    case 'task':
      return parsed.sbTaskRaw;
  }
}

export function buildRecords(args: {
  epicKey: string;
  tree: IssueTree;
  worklogsByIssue: ReadonlyMap<string, readonly JiraWorklog[]>;
  changelogByIssue: ReadonlyMap<string, readonly JiraChangelogEntry[]>;
  config: EffectiveConfig;
  fields: ResolvedFieldMapping;
}): BuiltRecords {
  const { epicKey, tree, config, fields } = args;
  const profile = config.hierarchyProfile;
  const warnings: { code: string; message: string }[] = [];

  const taskParser = new TaskTitleParser(config);
  const subtaskParser = new SubtaskTitleParser(config);

  const issues: IssueRecord[] = [];
  /** Phase của MỌI issue tầng GROUP (kể cả kế thừa từ cha ở cây ≥ 4 tầng). */
  const phaseOfGroup = new Map<string, string>();

  if (tree.root) {
    issues.push(baseRecord(tree.root, 'ROOT', epicKey, fields));
  }

  // Tầng GROUP mang thông tin Phase khi phaseSource = GROUP_TITLE. Ở cây ≥ 4
  // tầng, các tầng GROUP sâu hơn tầng này KẾ THỪA phase của cha.
  const carrierLevel = profile.phaseSource.type === 'GROUP_TITLE'
    ? phaseCarrierLevelIndex(profile)
    : null;

  tree.groupLevels.forEach((rows, i) => {
    const levelIndex = i + 1; // groupLevels[0] là tầng ngay dưới ROOT
    for (const g of rows) {
      let phaseCode: string | null = null;
      let rawPhaseLabel: string | null = null;

      if (carrierLevel !== null && levelIndex === carrierLevel) {
        const parsed = taskParser.parse(stringField(g.fields['summary']));
        phaseCode = parsed.phaseCode;
        rawPhaseLabel = parsed.rawPhaseLabel;
        warnings.push(...parsed.warnings);
      } else if (carrierLevel !== null && levelIndex > carrierLevel) {
        const parentKey = parentKeyOf(g.fields);
        phaseCode = (parentKey ? phaseOfGroup.get(parentKey) : undefined) ?? UNCLASSIFIED_PHASE;
      }

      if (phaseCode !== null) phaseOfGroup.set(g.key, phaseCode);

      issues.push({
        ...baseRecord(g, 'GROUP', epicKey, fields),
        phaseCode,
        rawPhaseLabel,
      });
    }
  });

  // Phase của Task cha là nguồn sự thật CHỈ khi profile nói vậy (GROUP_TITLE —
  // PRD §2.9.2). Các nguồn khác tắt phép so PHASE_MISMATCH: đem nguồn so với
  // chính nó chỉ sinh cảnh báo rác.
  const phaseFromParent = profile.phaseSource.type === 'GROUP_TITLE';

  for (const s of tree.leaves) {
    const parentKey = parentKeyOf(s.fields);
    const parentPhase = (parentKey ? phaseOfGroup.get(parentKey) : undefined) ?? UNCLASSIFIED_PHASE;

    const parsed = subtaskParser.parse(
      stringField(s.fields['summary']),
      phaseFromParent ? parentPhase : UNCLASSIFIED_PHASE,
      { comparePhaseWithParent: phaseFromParent },
    );
    warnings.push(...parsed.warnings);

    // ---- Phase theo chiến lược của profile (mọi đường đều đổ về phase_code,
    //      từ đó trở đi rollup/snapshot/signboard không phân biệt gì nữa) ----
    let phaseCode = parsed.phaseCode;
    let rawPhaseLabel: string | null = null;
    switch (profile.phaseSource.type) {
      case 'GROUP_TITLE':
        break; // parsed.phaseCode đã là phase của Task cha
      case 'SELF_TITLE_SLOT': {
        const raw = slotValue(parsed, (profile.phaseSource.ref ?? 'phase') as TitleSlot);
        phaseCode = raw === null ? UNCLASSIFIED_PHASE : subtaskParser.resolvePhaseText(raw);
        rawPhaseLabel = raw;
        break;
      }
      case 'FIELD': {
        // Field nhiều giá trị (2 component…): lấy giá trị ĐẦU TIÊN khớp được
        // một Phase; không cái nào khớp thì UNCLASSIFIED + giữ nguyên giá trị
        // thô đầu tiên để màn hình "nhãn chưa khớp" gợi ý luật mới.
        const values = fieldStringValues(s.fields, profile.phaseSource.ref ?? '');
        const hit = values
          .map((v) => ({ v, code: subtaskParser.resolvePhaseText(v) }))
          .find((r) => r.code !== UNCLASSIFIED_PHASE);
        phaseCode = hit?.code ?? UNCLASSIFIED_PHASE;
        rawPhaseLabel = hit?.v ?? values[0] ?? null;
        break;
      }
      case 'FIXED':
        phaseCode = profile.phaseSource.ref ?? UNCLASSIFIED_PHASE;
        break;
    }

    // ---- Hàng/cột Signboard theo profile: mặc định từ ô tiêu đề (đã nằm
    //      trong `parsed`), hoặc ghi đè từ field Jira ----
    let functionName = parsed.functionName;
    let functionKey = parsed.functionKey;
    if (profile.signboard.row.source === 'FIELD') {
      const name = fieldStringValues(s.fields, profile.signboard.row.ref)[0] ?? null;
      functionName = name;
      functionKey = name === null ? null : toFunctionKey(name);
    }

    let taskType = parsed.taskType;
    let sbTaskRaw = parsed.sbTaskRaw;
    if (profile.signboard.column.source === 'FIELD') {
      const raw = fieldStringValues(s.fields, profile.signboard.column.ref)[0] ?? null;
      taskType = raw === null ? null : subtaskParser.resolveTaskType(raw);
      sbTaskRaw = raw;
    }

    // Trạng thái phân tách tính lại SAU các ghi đè: hàng/cột lấy từ field thì
    // "tiêu đề đặt sai" không còn là lý do rớt khỏi Signboard nữa.
    const sbParseStatus =
      functionKey === null ? 'UNPARSED' : taskType === null ? 'UNKNOWN_TASK_TYPE' : 'OK';

    issues.push({
      ...baseRecord(s, 'LEAF', epicKey, fields),
      // `UNPARSED` KHÔNG có nghĩa là bỏ qua ticket lá này. Nó vẫn được ghi đầy
      // đủ và vẫn cộng dồn vào Burndown (C-11, PRD E-27) — chỉ là không lên
      // được bảng Signboard.
      phaseCode,
      rawPhaseLabel,
      // Sáu trường bóc từ tiêu đề được siết cho vừa cột VARCHAR NGAY TẠI ĐÂY.
      // Một tiêu đề dài bất thường mà không siết sẽ làm cả lượt đồng bộ Epic đổ
      // vì "value too long" (xem `fitSubtaskColumns`).
      ...fitSubtaskColumns(
        { ...parsed, functionName, functionKey, sbTaskRaw },
        s.key,
        warnings,
      ),
      taskType,
      sbParseStatus,
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

/**
 * `issue_type` giờ là dữ liệu MÔ TẢ (hiển thị, điều tra) — phân loại thật nằm ở
 * `resolved_role`. Chuẩn hoá từ tên type thật trên Jira để với dữ liệu 3 tầng
 * cũ ra đúng EPIC/TASK/SUBTASK như trước (byte-for-byte, C-6), còn dự án 2 tầng
 * thì root ghi đúng là TASK chứ không bịa thành EPIC.
 */
function normalizeIssueTypeName(fields: Record<string, unknown>, role: HierarchyRole): string {
  const t = fields['issuetype'];
  const name =
    t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string'
      ? ((t as { name: string }).name)
      : '';
  const n = name.trim().toLowerCase();
  if (n === '') {
    // Không có tên type (dữ liệu thiếu) — rơi về ánh xạ theo vai như bản cũ.
    return role === 'ROOT' ? ISSUE_TYPE.EPIC : role === 'GROUP' ? ISSUE_TYPE.TASK : ISSUE_TYPE.SUBTASK;
  }
  if (n === 'epic' || n === 'エピック') return ISSUE_TYPE.EPIC;
  if (n === 'sub-task' || n === 'subtask' || n === 'サブタスク') return ISSUE_TYPE.SUBTASK;
  if (n === 'task' || n === 'タスク') return ISSUE_TYPE.TASK;
  // Type tuỳ chế (Story…): giữ tên thật, cắt vừa cột VARCHAR(16).
  return fitColumn(name.trim().toUpperCase(), 16);
}

function baseRecord(
  issue: JiraIssue,
  role: HierarchyRole,
  epicKey: string,
  fields: ResolvedFieldMapping,
): IssueRecord {
  const f = issue.fields;
  const status = f['status'] as { id?: string; statusCategory?: { key?: string } } | undefined;
  const wbs = readWbsDates(issue, fields);

  return {
    issueKey: issue.key,
    issueId: BigInt(issue.id),
    issueType: normalizeIssueTypeName(f, role),
    resolvedRole: role,
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

/** Jira để `null` khi trường thời gian trống — coi như 0, không phải NaN. */
function numberField(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}
