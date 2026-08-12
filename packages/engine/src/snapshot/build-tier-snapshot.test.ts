import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  type ChangelogEvent,
  type StatusIdMap,
  type SubtaskRecord,
  type WorkCalendar,
  type WorklogRecord,
} from '@app/shared';
import { computePhaseRollups } from '../rollup/compute-phase-rollups.js';
import { computeGroupRollups } from '../rollup/compute-group-rollups.js';
import { buildSnapshotForDay } from './build-snapshot-for-day.js';
import { buildTierSnapshotForDay } from './build-tier-snapshot.js';

/**
 * `buildTierSnapshotForDay` tổng quát phần `perPhase` của `buildSnapshotForDay` sang N
 * tầng (DYNAMIC-TIERS-DESIGN.md §5). Hai điều phải đúng:
 *
 *   • n=1: nút tầng-1 khớp `perPhase` từng trường (remaining/spent/original/counts +
 *     đường Kế hoạch) — bằng chứng "không đổi hành vi".
 *   • n=3: mọi trị cộng dồn lên tổ tiên; trị nút cha = Σ trị nút con trực tiếp.
 */

const H = 3600;
const STATUS: StatusIdMap = new Map([
  ['1', 'new'],
  ['3', 'indeterminate'],
  ['10001', 'done'],
]);

const cal = (): WorkCalendar => ({
  calendarId: 'VN_STANDARD',
  timezone: 'Asia/Ho_Chi_Minh',
  workdaysMask: DEFAULT_WORKDAYS_MASK,
  hoursPerDay: 8,
  holidays: new Set<string>(),
  warnings: [],
});

const st = (to: string, iso: string): ChangelogEvent => ({
  issueKey: 'x',
  field: 'status',
  fromValue: null,
  toValue: to,
  createdAtMs: Date.parse(iso),
});

const wl = (id: string, seconds: number, iso: string): WorklogRecord => ({
  worklogId: id,
  issueKey: 'x',
  timeSpentSeconds: seconds,
  startedAtMs: Date.parse(iso),
  isDeleted: false,
});

const sub = (over: Partial<SubtaskRecord> & { key: string }): SubtaskRecord => ({
  phaseCode: 'DESIGN',
  originalEstimateSeconds: 8 * H,
  createdAtMs: Date.parse('2026-03-01T00:00:00Z'),
  removedAtMs: null,
  wbsStartDate: null,
  wbsEndDate: null,
  changelog: [],
  worklogs: [],
  ...over,
});

const DATE = '2026-03-05'; // thứ Năm, ngày làm việc (Mar 2026: 02=Mon … 06=Fri)
const AS_OF = Date.parse('2026-03-31T23:59:59.999Z');

describe('buildTierSnapshotForDay — n=1 khớp perPhase (không đổi hành vi)', () => {
  const subtasks: SubtaskRecord[] = [
    sub({
      key: 'D-1',
      phaseCode: 'DESIGN',
      originalEstimateSeconds: 16 * H,
      wbsStartDate: '2026-03-02',
      wbsEndDate: '2026-03-05',
      worklogs: [wl('w1', 8 * H, '2026-03-03T02:00:00Z')],
      changelog: [st('10001', '2026-03-04T02:00:00Z')], // done
    }),
    sub({
      key: 'D-2',
      phaseCode: 'DESIGN',
      originalEstimateSeconds: 24 * H,
      wbsStartDate: '2026-03-03',
      wbsEndDate: '2026-03-06',
      worklogs: [wl('w2', 4 * H, '2026-03-04T02:00:00Z')],
      changelog: [st('3', '2026-03-03T02:00:00Z')], // in-progress
    }),
    sub({
      key: 'V-1',
      phaseCode: 'DEV',
      originalEstimateSeconds: 40 * H,
      wbsStartDate: '2026-03-05',
      wbsEndDate: '2026-03-10',
    }),
  ];

  it('nút tầng-1 == perPhase (kể cả đường Kế hoạch)', () => {
    const phaseRollups = computePhaseRollups({ subtasks, calendar: cal(), statusIdMap: STATUS, asOfMs: AS_OF });
    const snap = buildSnapshotForDay({
      epicKey: 'E',
      subtasks,
      phaseRollups,
      dateStr: DATE,
      calendar: cal(),
      statusIdMap: STATUS,
      sourceReadAtMs: 0,
    });

    const groupRollups = computeGroupRollups({ subtasks, calendar: cal(), statusIdMap: STATUS, asOfMs: AS_OF });
    const tier = buildTierSnapshotForDay({
      subtasks,
      groupRollups,
      dateStr: DATE,
      calendar: cal(),
      statusIdMap: STATUS,
    });

    // Đúng số nút tầng-1 = số Phase, path = [phaseCode].
    const tier1 = tier.filter((t) => t.tierOrder === 1);
    expect(tier1.length).toBe(snap.perPhase.length);

    // Ít nhất một đường Kế hoạch KHÁC null — để phép so không chỉ là null==null.
    expect(snap.perPhase.some((p) => p.plannedRemainingS !== null)).toBe(true);

    for (const p of snap.perPhase) {
      const t = tier1.find((x) => x.groupPath[0] === p.phaseCode);
      expect(t, `thiếu nút ${p.phaseCode}`).toBeDefined();
      expect({
        remainingS: t!.remainingS,
        spentS: t!.spentS,
        originalS: t!.originalS,
        countTodo: t!.countTodo,
        countInProgress: t!.countInProgress,
        countDone: t!.countDone,
        plannedRemainingS: t!.plannedRemainingS,
      }).toEqual({
        remainingS: p.remainingS,
        spentS: p.spentS,
        originalS: p.originalS,
        countTodo: p.countTodo,
        countInProgress: p.countInProgress,
        countDone: p.countDone,
        plannedRemainingS: p.plannedRemainingS,
      });
    }
  });
});

describe('buildTierSnapshotForDay — n=3 cộng dồn theo mọi tiền tố', () => {
  const subtasks: SubtaskRecord[] = [
    sub({
      key: 'L1',
      phaseCode: 'DESIGN',
      groupPath: ['SA', 'DESIGN', 'SCR'],
      originalEstimateSeconds: 10 * H,
      wbsStartDate: '2026-03-02',
      wbsEndDate: '2026-03-04',
      worklogs: [wl('w1', 3 * H, '2026-03-03T02:00:00Z')],
      changelog: [st('3', '2026-03-03T02:00:00Z')],
    }),
    sub({
      key: 'L2',
      phaseCode: 'DESIGN',
      groupPath: ['SA', 'DESIGN', 'DB'],
      originalEstimateSeconds: 20 * H,
      wbsStartDate: '2026-03-03',
      wbsEndDate: '2026-03-06',
      worklogs: [wl('w2', 5 * H, '2026-03-04T02:00:00Z')],
      changelog: [st('10001', '2026-03-04T03:00:00Z')],
    }),
    sub({
      key: 'L3',
      phaseCode: 'DEV',
      groupPath: ['SA', 'DEV', 'API'],
      originalEstimateSeconds: 40 * H,
      wbsStartDate: '2026-03-05',
      wbsEndDate: '2026-03-09',
    }),
  ];

  const groupRollups = computeGroupRollups({ subtasks, calendar: cal(), statusIdMap: STATUS, asOfMs: AS_OF });
  const tier = buildTierSnapshotForDay({ subtasks, groupRollups, dateStr: DATE, calendar: cal(), statusIdMap: STATUS });

  const node = (path: string[]) => {
    const found = tier.find((t) => JSON.stringify(t.groupPath) === JSON.stringify(path));
    if (!found) throw new Error(`thiếu nút ${JSON.stringify(path)}`);
    return found;
  };

  it('trị nút cha = Σ trị nút con trực tiếp (remaining/spent/original/counts)', () => {
    for (const field of ['remainingS', 'spentS', 'originalS', 'countTodo', 'countInProgress', 'countDone'] as const) {
      // Tầng 1 SA = Σ hai con tầng 2 (SA·DESIGN + SA·DEV).
      expect(node(['SA'])[field]).toBe(node(['SA', 'DESIGN'])[field] + node(['SA', 'DEV'])[field]);
      // Tầng 2 SA·DESIGN = Σ hai con tầng 3 (SCR + DB).
      expect(node(['SA', 'DESIGN'])[field]).toBe(
        node(['SA', 'DESIGN', 'SCR'])[field] + node(['SA', 'DESIGN', 'DB'])[field],
      );
    }
  });

  it('nút lá tầng-3 mang đúng trị của chính lá', () => {
    expect(node(['SA', 'DESIGN', 'DB']).spentS).toBe(5 * H);
    expect(node(['SA', 'DESIGN', 'DB']).countDone).toBe(1);
    expect(node(['SA', 'DESIGN', 'SCR']).spentS).toBe(3 * H);
    expect(node(['SA', 'DESIGN', 'SCR']).countInProgress).toBe(1);
    expect(node(['SA', 'DEV', 'API']).countTodo).toBe(1);
    expect(node(['SA']).originalS).toBe(70 * H);
  });
});
