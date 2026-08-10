import type {
  ConfigPayload,
  DailySnapshotData,
  DateOnly,
  EffectiveConfig,
  PhaseRollup,
  PlanShiftRecord,
  SignboardCell,
  SubtaskRecord,
} from '@app/shared';
import { DEFAULT_HIERARCHY_PROFILE } from '@app/shared';
import {
  buildSnapshotForDay,
  computePhaseRollups,
  detectPlanShift,
  endOfDayUtcMs,
  listWorkdays,
  mergeCell,
  mergeInheritance,
  resolveCellStatus,
  resolveSubtaskActualDates,
  SubtaskTitleParser,
  TaskTitleParser,
} from '../../src/index.js';
import { buildCalendar, buildStatusIdMap, buildSubtask, toMs } from './build-records.js';
import type {
  BurndownFixture,
  InheritFixture,
  ParseFixture,
  SignboardFixture,
} from './fixture-types.js';

/**
 * Chạy engine đúng THỨ TỰ mà job dựng lịch sử (T-18) chạy.
 *
 * Bám sát `reconstruct-epic.job.ts`: tổng hợp ngày Phase TRƯỚC, dựng snapshot
 * SAU. Nếu ở đây tự ghép một thứ tự khác thì golden dataset sẽ kiểm một quy
 * trình không tồn tại, và bug thật vẫn lọt.
 */

// ---------------------------------------------------------------------------
// Kết quả — cố ý dùng chuỗi ngày giờ thay cho số mili-giây
// ---------------------------------------------------------------------------

export interface SnapshotResult {
  readonly snapshotDate: DateOnly;
  /** ISO của mốc chốt sổ. Dạng chuỗi để `GD-12` (DST) kiểm được bằng mắt. */
  readonly snapshotAtUtc: string;
  readonly plannedRemainingS: number;
  readonly actualRemainingS: number;
  readonly totalScopeS: number;
  readonly totalSpentS: number;
  readonly scopeAddedS: number;
  readonly scopeRemovedS: number;
  readonly countTodo: number;
  readonly countInProgress: number;
  readonly countDone: number;
  readonly perPhase: readonly {
    readonly phaseCode: string;
    readonly remainingS: number;
    readonly spentS: number;
    readonly originalS: number;
    readonly countTodo: number;
    readonly countInProgress: number;
    readonly countDone: number;
    readonly plannedRemainingS: number | null;
  }[];
}

export interface BurndownResult {
  readonly workdays: readonly DateOnly[];
  readonly rollups: readonly PhaseRollup[];
  readonly planShifts: readonly PlanShiftRecord[];
  readonly actualDates: readonly {
    readonly key: string;
    readonly actualStart: DateOnly | null;
    readonly actualEnd: DateOnly | null;
  }[];
  readonly snapshots: readonly SnapshotResult[];
}

function toSnapshotResult(snap: DailySnapshotData): SnapshotResult {
  return {
    snapshotDate: snap.snapshotDate,
    snapshotAtUtc: new Date(snap.snapshotAtUtcMs).toISOString(),
    plannedRemainingS: snap.plannedRemainingS,
    actualRemainingS: snap.actualRemainingS,
    totalScopeS: snap.totalScopeS,
    totalSpentS: snap.totalSpentS,
    scopeAddedS: snap.scopeAddedS,
    scopeRemovedS: snap.scopeRemovedS,
    countTodo: snap.countTodo,
    countInProgress: snap.countInProgress,
    countDone: snap.countDone,
    perPhase: snap.perPhase.map((p) => ({ ...p })),
  };
}

/** Rollup rút gọn của lần chạy trước — chỉ cần hai mốc để so dịch chuyển. */
function stubRollup(spec: { phaseCode: string; planStart: DateOnly | null; planEnd: DateOnly | null }): PhaseRollup {
  return {
    phaseCode: spec.phaseCode,
    planStart: spec.planStart,
    planEnd: spec.planEnd,
    planWorkdays: null,
    actualStart: null,
    actualEnd: null,
    actualEndIsProvisional: true,
    totalOriginalS: 0,
    subtaskCount: 0,
    missingDateCount: 0,
    warnings: [],
  };
}

export function runBurndown(fixture: BurndownFixture): BurndownResult {
  const calendar = buildCalendar(fixture.calendar);
  const statusIdMap = buildStatusIdMap(fixture.statusIds);
  const subtasks: SubtaskRecord[] = fixture.subtasks.map(buildSubtask);
  const asOfMs = endOfDayUtcMs(fixture.asOfDate, calendar.timezone);
  const sourceReadAtMs = toMs(fixture.sourceReadAt);

  // --- Giai đoạn 4: tổng hợp ngày Phase, TRƯỚC khi dựng snapshot ---
  const rollups = computePhaseRollups({ subtasks, calendar, statusIdMap, asOfMs });

  const previous = new Map(
    (fixture.previousRollups ?? []).map((r) => [r.phaseCode, stubRollup(r)] as const),
  );
  const planShifts = rollups.flatMap((r) =>
    detectPlanShift(previous.get(r.phaseCode) ?? null, r, subtasks, calendar),
  );

  // --- Giai đoạn 5: dựng snapshot cho từng NGÀY LÀM VIỆC ---
  const workdays = listWorkdays(fixture.snapshotRange.from, fixture.snapshotRange.to, calendar);

  const snapshots: SnapshotResult[] = [];
  // Ngày đầu tiên không có snapshot trước → chênh lệch phạm vi bằng 0/0.
  let previousScope: number | undefined = undefined;

  for (const dateStr of workdays) {
    const snap = buildSnapshotForDay({
      epicKey: fixture.epicKey,
      subtasks,
      phaseRollups: rollups,
      dateStr,
      calendar,
      statusIdMap,
      sourceReadAtMs,
      previousTotalScopeS: previousScope,
    });
    snapshots.push(toSnapshotResult(snap));
    previousScope = snap.totalScopeS;
  }

  const actualDates = subtasks.map((s) => {
    const d = resolveSubtaskActualDates(s, statusIdMap, calendar.timezone);
    return { key: s.key, actualStart: d.actualStart, actualEnd: d.actualEnd };
  });

  return { workdays, rollups, planShifts, actualDates, snapshots };
}

// ---------------------------------------------------------------------------
// GD-19 — phân tách tiêu đề
// ---------------------------------------------------------------------------

export interface ParseResultRow {
  readonly key: string;
  readonly phaseCode: string;
  readonly matchedPattern: string | null;
  readonly extractedName: string | null;
  readonly winningKeyword: string | null;
}

export interface SubtaskParseResultRow {
  readonly key: string;
  readonly parseStatus: string;
  readonly functionName: string | null;
  readonly functionKey: string | null;
  readonly taskType: string | null;
  readonly phaseCode: string;
  readonly warningCodes: readonly string[];
}

export interface ParseRunResult {
  readonly tasks: readonly ParseResultRow[];
  readonly subtasks: readonly SubtaskParseResultRow[];
}

function toEffectiveConfig(cfg: ParseFixture['config']): EffectiveConfig {
  return {
    fallbackScanFullTitle: cfg.fallbackScanFullTitle,
    titlePatterns: cfg.titlePatterns.map((patternText, i) => ({ patternText, sortOrder: i + 1 })),
    subtaskPatterns: cfg.subtaskPatterns.map((patternText, i) => ({ patternText, sortOrder: i + 1 })),
    phaseDefinitions: cfg.phaseCodes.map((phaseCode, i) => ({
      phaseCode,
      labelVi: phaseCode,
      displayOrder: i + 1,
    })),
    matchRules: cfg.rules.map((r) => ({ ...r })),
    signboardColumns: cfg.taskColumns.map((taskCode, i) => ({
      taskCode,
      labelVi: taskCode,
      displayOrder: i + 1,
    })),
    hierarchyProfile: DEFAULT_HIERARCHY_PROFILE,
    projectKey: null,
    globalVersion: 1,
    projectVersion: null,
    inherited: {
      titlePatterns: false,
      subtaskPatterns: false,
      phaseDefinitions: false,
      matchRules: false,
      signboardColumns: false,
      hierarchyProfile: false,
    },
  };
}

export function runParse(fixture: ParseFixture): ParseRunResult {
  const config = toEffectiveConfig(fixture.config);
  const taskParser = new TaskTitleParser(config);
  const subtaskParser = new SubtaskTitleParser(config);

  return {
    tasks: fixture.tasks.map((t) => {
      const r = taskParser.parse(t.title);
      return {
        key: t.key,
        phaseCode: r.phaseCode,
        matchedPattern: r.matchedPattern,
        extractedName: r.rawPhaseLabel,
        winningKeyword: r.winningRule?.keyword ?? null,
      };
    }),
    subtasks: fixture.subtasks.map((s) => {
      const r = subtaskParser.parse(s.title, s.parentPhaseCode);
      return {
        key: s.key,
        parseStatus: r.sbParseStatus,
        functionName: r.functionName,
        functionKey: r.functionKey,
        taskType: r.taskType,
        phaseCode: r.phaseCode,
        // Sắp xếp để so sánh không phụ thuộc thứ tự sinh cảnh báo.
        warningCodes: [...r.warnings.map((w) => w.code)].sort(),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// GD-20 — cây quyết định Signboard
// ---------------------------------------------------------------------------

export interface SignboardCellResult {
  readonly name: string;
  readonly cell: SignboardCell;
}

/**
 * GD-14 — kế thừa cấu hình theo project (PRD §2.2.6).
 *
 * Trả về đúng thứ màn hình cần: nội dung đã gộp + cờ "phần nào đang kế thừa".
 */
export function runInherit(fixture: InheritFixture): {
  readonly titlePatterns: readonly string[];
  readonly subtaskPatterns: readonly string[];
  readonly phaseCodes: readonly string[];
  readonly ruleKeywords: readonly string[];
  readonly taskColumns: readonly string[];
  readonly fallbackScanFullTitle: boolean;
  readonly inherited: Readonly<Record<string, boolean>>;
} {
  const toPayload = (spec: Partial<InheritFixture['globalConfig']>): ConfigPayload => ({
    fallbackScanFullTitle: spec.fallbackScanFullTitle ?? true,
    titlePatterns: (spec.titlePatterns ?? []).map((patternText, i) => ({ patternText, sortOrder: i + 1 })),
    subtaskPatterns: (spec.subtaskPatterns ?? []).map((patternText, i) => ({ patternText, sortOrder: i + 1 })),
    phaseDefinitions: (spec.phaseCodes ?? []).map((phaseCode, i) => ({
      phaseCode,
      labelVi: phaseCode,
      displayOrder: i + 1,
    })),
    matchRules: (spec.ruleKeywords ?? []).map((r) => ({
      keyword: r.keyword,
      matchMode: 'CONTAINS' as const,
      phaseCode: r.phaseCode,
      matchPriority: 50,
    })),
    signboardColumns: (spec.taskColumns ?? []).map((taskCode, i) => ({
      taskCode,
      labelVi: taskCode,
      displayOrder: i + 1,
    })),
  });

  const merged = mergeInheritance(
    toPayload(fixture.globalConfig),
    fixture.projectConfig === null
      ? null
      : { ...toPayload(fixture.projectConfig), projectKey: fixture.projectConfig.projectKey },
    { globalVersion: fixture.globalVersion, projectVersion: fixture.projectVersion },
  );

  return {
    titlePatterns: merged.titlePatterns.map((p) => p.patternText),
    subtaskPatterns: merged.subtaskPatterns.map((p) => p.patternText),
    phaseCodes: merged.phaseDefinitions.map((p) => p.phaseCode),
    ruleKeywords: merged.matchRules.map((r) => r.keyword),
    taskColumns: merged.signboardColumns.map((c) => c.taskCode),
    fallbackScanFullTitle: merged.fallbackScanFullTitle,
    inherited: { ...merged.inherited },
  };
}

export function runSignboard(fixture: SignboardFixture): { readonly cells: readonly SignboardCellResult[] } {
  const cells = fixture.cells.map((cell) => ({
    name: cell.name,
    cell: mergeCell(
      cell.tickets.map((t) => ({
        issueKey: t.issueKey,
        planStart: t.planStart,
        planEnd: t.planEnd,
        actualStart: t.actualStart,
        actualEnd: t.actualEnd,
        status: resolveCellStatus(
          {
            statusCategory: t.statusCategory,
            planStart: t.planStart,
            planEnd: t.planEnd,
            actualStart: t.actualStart,
          },
          fixture.asOfDate,
        ),
      })),
    ),
  }));

  return { cells };
}
