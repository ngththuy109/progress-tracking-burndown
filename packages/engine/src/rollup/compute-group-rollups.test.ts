import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  type StatusIdMap,
  type SubtaskRecord,
  type WorkCalendar,
} from '@app/shared';
import { computePhaseRollups } from './compute-phase-rollups.js';
import { computeGroupRollups } from './compute-group-rollups.js';

/**
 * `computeGroupRollups` tổng quát `computePhaseRollups` sang N tầng theo prefix của
 * `group_path` (DYNAMIC-TIERS-DESIGN.md §5). Hai điều phải đúng:
 *
 *   • n=1: lá chỉ có `phaseCode` (như 20 golden dataset) ⇒ nút tầng-1 BẰNG từng trường
 *     với `PhaseRollup` — bằng chứng "không đổi hành vi".
 *   • n=3: số liệu lá cộng dồn lên MỌI nút tiền tố (tổ tiên); tổng cha = Σ tổng con.
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

/** Phần CHUNG của một rollup (bỏ khoá nhóm) — để so `GroupRollup` với `PhaseRollup`. */
const common = (r: {
  readonly planStart: string | null;
  readonly planEnd: string | null;
  readonly planWorkdays: number | null;
  readonly actualStart: string | null;
  readonly actualEnd: string | null;
  readonly actualEndIsProvisional: boolean;
  readonly totalOriginalS: number;
  readonly subtaskCount: number;
  readonly missingDateCount: number;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}) => ({
  planStart: r.planStart,
  planEnd: r.planEnd,
  planWorkdays: r.planWorkdays,
  actualStart: r.actualStart,
  actualEnd: r.actualEnd,
  actualEndIsProvisional: r.actualEndIsProvisional,
  totalOriginalS: r.totalOriginalS,
  subtaskCount: r.subtaskCount,
  missingDateCount: r.missingDateCount,
  warnings: r.warnings,
});

/** Lấy nút theo path chính xác. */
const node = (rollups: ReturnType<typeof computeGroupRollups>, path: string[]) => {
  const found = rollups.find((r) => JSON.stringify(r.groupPath) === JSON.stringify(path));
  if (!found) throw new Error(`không tìm thấy nút ${JSON.stringify(path)}`);
  return found;
};

describe('computeGroupRollups — n=1 bằng computePhaseRollups (không đổi hành vi)', () => {
  it('lá chỉ có phaseCode (fallback [phaseCode]) ⇒ nút tầng-1 khớp từng trường Phase', () => {
    const subtasks = [
      sub({ key: 'A-1', phaseCode: 'DESIGN', wbsStartDate: '2026-03-02', wbsEndDate: '2026-03-04', originalEstimateSeconds: 16 * H }),
      sub({ key: 'A-2', phaseCode: 'DESIGN', wbsStartDate: '2026-03-03', wbsEndDate: '2026-03-06', originalEstimateSeconds: 24 * H }),
      sub({ key: 'A-3', phaseCode: 'DEV', wbsStartDate: '2026-03-05', wbsEndDate: '2026-03-09', originalEstimateSeconds: 40 * H }),
    ];
    const phase = computePhaseRollups({ subtasks, calendar: cal(), statusIdMap: STATUS });
    const group = computeGroupRollups({ subtasks, calendar: cal(), statusIdMap: STATUS });

    // Mọi lá không có groupPath ⇒ chỉ một nút độ sâu 1, path = [phaseCode].
    expect(group.every((g) => g.tierOrder === 1)).toBe(true);
    expect(group.map((g) => g.groupPath)).toEqual([['DESIGN'], ['DEV']]);

    // Từng nút group khớp từng trường với Phase cùng mã.
    for (const p of phase) {
      expect(common(node(group, [p.phaseCode]))).toEqual(common(p));
    }
  });

  it('lá khai sẵn groupPath=[phaseCode] cho kết quả y hệt fallback', () => {
    const only = sub({ key: 'A-1', phaseCode: 'DESIGN', wbsStartDate: '2026-03-02', wbsEndDate: '2026-03-04' });
    const withPath: SubtaskRecord = { ...only, groupPath: ['DESIGN'] };
    const a = computeGroupRollups({ subtasks: [only], calendar: cal(), statusIdMap: STATUS });
    const b = computeGroupRollups({ subtasks: [withPath], calendar: cal(), statusIdMap: STATUS });
    expect(b).toEqual(a);
  });
});

describe('computeGroupRollups — n=3 cộng dồn theo mọi tiền tố', () => {
  // STREAM (t1) / PHASE (t2) / SCREEN (t3). Bốn lá:
  //   SA·DESIGN·SCR 10h [03-02..03-04]   SA·DESIGN·DB 20h [03-03..03-06]
  //   SA·DEV·API    40h [03-05..03-09]   SB·DESIGN·SCR 8h [03-01..03-02]
  const subtasks: SubtaskRecord[] = [
    sub({ key: 'L1', phaseCode: 'DESIGN', groupPath: ['SA', 'DESIGN', 'SCR'], originalEstimateSeconds: 10 * H, wbsStartDate: '2026-03-02', wbsEndDate: '2026-03-04' }),
    sub({ key: 'L2', phaseCode: 'DESIGN', groupPath: ['SA', 'DESIGN', 'DB'], originalEstimateSeconds: 20 * H, wbsStartDate: '2026-03-03', wbsEndDate: '2026-03-06' }),
    sub({ key: 'L3', phaseCode: 'DEV', groupPath: ['SA', 'DEV', 'API'], originalEstimateSeconds: 40 * H, wbsStartDate: '2026-03-05', wbsEndDate: '2026-03-09' }),
    sub({ key: 'L4', phaseCode: 'DESIGN', groupPath: ['SB', 'DESIGN', 'SCR'], originalEstimateSeconds: 8 * H, wbsStartDate: '2026-03-01', wbsEndDate: '2026-03-02' }),
  ];
  const g = computeGroupRollups({ subtasks, calendar: cal(), statusIdMap: STATUS });

  it('sinh đủ 9 nút: 2 tầng-1 + 3 tầng-2 + 4 tầng-3', () => {
    expect(g.map((r) => r.groupPath)).toEqual([
      ['SA'],
      ['SB'],
      ['SA', 'DESIGN'],
      ['SA', 'DEV'],
      ['SB', 'DESIGN'],
      ['SA', 'DESIGN', 'DB'],
      ['SA', 'DESIGN', 'SCR'],
      ['SA', 'DEV', 'API'],
      ['SB', 'DESIGN', 'SCR'],
    ]);
    expect(g.map((r) => r.tierOrder)).toEqual([1, 1, 2, 2, 2, 3, 3, 3, 3]);
  });

  it('tổng ước lượng cộng dồn đúng theo tiền tố', () => {
    expect(node(g, ['SA']).totalOriginalS).toBe(70 * H); // 10+20+40
    expect(node(g, ['SB']).totalOriginalS).toBe(8 * H);
    expect(node(g, ['SA', 'DESIGN']).totalOriginalS).toBe(30 * H); // 10+20
    expect(node(g, ['SA', 'DEV']).totalOriginalS).toBe(40 * H);
    expect(node(g, ['SA', 'DESIGN', 'SCR']).totalOriginalS).toBe(10 * H);
  });

  it('bất biến cây: tổng nút cha = Σ tổng nút con trực tiếp', () => {
    // Tầng 1 = Σ con tầng 2.
    expect(node(g, ['SA']).totalOriginalS).toBe(
      node(g, ['SA', 'DESIGN']).totalOriginalS + node(g, ['SA', 'DEV']).totalOriginalS,
    );
    // Tầng 2 = Σ con tầng 3.
    expect(node(g, ['SA', 'DESIGN']).totalOriginalS).toBe(
      node(g, ['SA', 'DESIGN', 'SCR']).totalOriginalS + node(g, ['SA', 'DESIGN', 'DB']).totalOriginalS,
    );
    expect(node(g, ['SA']).subtaskCount).toBe(3);
    expect(node(g, ['SB']).subtaskCount).toBe(1);
  });

  it('ngày MIN/MAX lăn đúng lên tổ tiên', () => {
    expect(node(g, ['SA']).planStart).toBe('2026-03-02'); // MIN(03-02,03-03,03-05)
    expect(node(g, ['SA']).planEnd).toBe('2026-03-09'); // MAX(03-04,03-06,03-09)
    expect(node(g, ['SA', 'DESIGN']).planStart).toBe('2026-03-02');
    expect(node(g, ['SA', 'DESIGN']).planEnd).toBe('2026-03-06');
    expect(node(g, ['SB']).planStart).toBe('2026-03-01');
    expect(node(g, ['SB']).planEnd).toBe('2026-03-02');
  });

  it('chạy hai lần cho kết quả giống hệt nhau (thuần)', () => {
    expect(computeGroupRollups({ subtasks, calendar: cal(), statusIdMap: STATUS })).toEqual(g);
  });
});
