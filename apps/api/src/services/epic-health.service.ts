import {
  HEALTH_THRESHOLD,
  type DateOnly,
  type EpicHealthResponse,
  type HealthLevel,
  type HealthMetric,
  type HealthMetricName,
} from '@app/shared';

/**
 * Tình trạng dữ liệu của một Epic — PRD §10.4.
 *
 * HÀM THUẦN: nhận số đếm đã tính sẵn bằng SQL, trả về mức cảnh báo kèm câu chữ
 * người dùng đọc được. Mỗi chỉ số nói rõ **điều gì sai** và **làm gì tiếp**
 * (C-9) — một con số 0,23 không giúp PM biết phải làm gì.
 *
 * Câu chữ bằng TIẾNG ANH vì nó hiện thẳng lên giao diện, nơi có cả khách nước
 * ngoài lẫn PM người Việt cùng đọc.
 */

export interface HealthRatios {
  readonly missingEstimateRatio: number;
  readonly unclassifiedPhaseRatio: number;
  readonly missingWbsDateRatio: number;
  readonly unparsedSubtaskRatio: number;
  readonly closedNoWorklogRatio: number;
}

export function levelOf(name: HealthMetricName, ratio: number): HealthLevel {
  const t = HEALTH_THRESHOLD[name];
  if (ratio >= t.critical) return 'CRITICAL';
  if (ratio >= t.warn) return 'WARN';
  return 'OK';
}

const PERCENT = (r: number): string => `${(r * 100).toFixed(0)}%`;

const MESSAGE: Record<HealthMetricName, (ratio: number, level: HealthLevel) => string> = {
  missingEstimateRatio: (r, l) =>
    l === 'OK'
      ? `${PERCENT(r)} of sub-tasks have no Original Estimate — within the acceptable range.`
      : `${PERCENT(r)} of sub-tasks have no Original Estimate, so this Epic looks smaller than it is. ` +
        'Ask the team to fill in estimates in Jira, then resync.',
  unclassifiedPhaseRatio: (r, l) =>
    l === 'OK'
      ? `${PERCENT(r)} of Tasks could not be assigned to a Phase — within the acceptable range.`
      : `${PERCENT(r)} of Tasks fall into "Unclassified", so the per-Phase chart is missing data. ` +
        'Open Phase settings, check the "Unrecognised" section, and add a matching rule.',
  missingWbsDateRatio: (r, l) =>
    l === 'OK'
      ? `${PERCENT(r)} of sub-tasks have no planned dates — within the acceptable range.`
      : `${PERCENT(r)} of sub-tasks are missing wbs_start_date or wbs_end_date, so early cannot be told from late. ` +
        'See the list on the Epics screen and ask the team to fill them in on Jira.',
  unparsedSubtaskRatio: (r, l) =>
    l === 'OK'
      ? `${PERCENT(r)} of sub-task titles are in the wrong format — within the acceptable range.`
      : `${PERCENT(r)} of sub-task titles are in the wrong format, so they never reach the Signboard ` +
        '(they DO still count towards Burndown). See "Not on the board" to find which ones to fix.',
  closedNoWorklogRatio: (r, l) =>
    l === 'OK'
      ? `${PERCENT(r)} of sub-tasks were closed with an estimate but no logged work — within the acceptable range.`
      : `${PERCENT(r)} of sub-tasks were closed with an estimate but no logged work, so their remaining effort ` +
        'only drops to zero on the day the ticket is closed — if that is later than the real finish, the Actual line looks late. ' +
        'Ask the team to log work (or close tickets on the day work finished); see "Show ticket details" for the list.',
};

const WORST: Record<HealthLevel, number> = { OK: 0, WARN: 1, CRITICAL: 2 };

export interface BuildHealthArgs {
  readonly epicKey: string;
  readonly status: string;
  readonly lastSyncedAt: Date | null;
  readonly lastError: string | null;
  /** Ngày làm việc trong khoảng đang xét, đã tính sẵn từ lịch. */
  readonly workdays: readonly DateOnly[];
  readonly snapshotDates: ReadonlySet<string>;
  readonly ratios: HealthRatios;
}

export function buildEpicHealth(args: BuildHealthArgs): EpicHealthResponse {
  const metrics: HealthMetric[] = (Object.keys(HEALTH_THRESHOLD) as HealthMetricName[]).map(
    (name) => {
      const ratio = args.ratios[name];
      const level = levelOf(name, ratio);
      return { name, ratio, level, message: MESSAGE[name](ratio, level) };
    },
  );

  return {
    epicKey: args.epicKey,
    status: args.status,
    lastSyncedAt: args.lastSyncedAt?.toISOString() ?? null,
    lastError: args.lastError,
    // NGÀY CỤ THỂ, không phải con số: "thiếu 3 ngày" không giúp tìm ra nguyên
    // nhân, còn "thiếu 12/03" thì mở log đúng đêm đó là ra (E-12).
    missingSnapshotDays: args.workdays.filter((d) => !args.snapshotDates.has(d)),
    metrics,
    overallLevel: metrics.reduce<HealthLevel>(
      (worst, m) => (WORST[m.level] > WORST[worst] ? m.level : worst),
      'OK',
    ),
  };
}
