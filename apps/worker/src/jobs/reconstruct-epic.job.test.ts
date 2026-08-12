import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  type ChangelogEvent,
  type DailySnapshotData,
  type GroupRollup,
  type PhaseRollup,
  type PlanShiftRecord,
  type StatusIdMap,
  type SubtaskRecord,
  type WorkCalendar,
} from '@app/shared';
import {
  reconstructEpic,
  type ReconstructPorts,
  type SubtaskActualRecord,
} from './reconstruct-epic.job.js';
import { FakeLockRedis } from '../lock/fake-redis.js';
import { lockKeyFor } from '../lock/redis-lock.js';

const H = 3600;
const EPIC = 'PAY-100';
const STATUS: StatusIdMap = new Map([
  ['1', 'new'],
  ['3', 'indeterminate'],
  ['10001', 'done'],
]);

const CAL: WorkCalendar = {
  calendarId: 'VN_STANDARD',
  timezone: 'Asia/Ho_Chi_Minh',
  workdaysMask: DEFAULT_WORKDAYS_MASK,
  hoursPerDay: 8,
  holidays: new Set<string>(),
  warnings: [],
};

const status = (to: string, iso: string): ChangelogEvent => ({
  issueKey: 'x',
  field: 'status',
  fromValue: null,
  toValue: to,
  createdAtMs: Date.parse(iso),
});

const sub = (key: string, over: Partial<SubtaskRecord> = {}): SubtaskRecord => ({
  key,
  phaseCode: 'DESIGN',
  originalEstimateSeconds: 8 * H,
  createdAtMs: Date.parse('2026-03-01T00:00:00Z'),
  removedAtMs: null,
  wbsStartDate: '2026-03-02',
  wbsEndDate: '2026-03-06',
  changelog: [],
  worklogs: [],
  ...over,
});

/** Kho giả ghi lại mọi lời gọi, kèm thứ tự — để kiểm chứng thứ tự giai đoạn. */
class FakePorts implements ReconstructPorts {
  readonly callOrder: string[] = [];
  readonly savedSnapshots: DailySnapshotData[] = [];
  readonly savedShifts: PlanShiftRecord[] = [];
  readonly savedActualDates: SubtaskActualRecord[] = [];
  savedRollups: PhaseRollup[] = [];
  savedGroupRollups: GroupRollup[] = [];
  obsoleteGroupRemoved = 0;
  readonly dirty = new Set<string>();
  cacheInvalidations = 0;
  obsoleteRemoved = 0;
  existingDates = new Set<string>();
  previousRollups = new Map<string, PhaseRollup>();
  /** `null` = mô phỏng ghi bị chặn vì dữ liệu cũ (E-19). */
  staleWrites = 0;

  constructor(private readonly subtasks: readonly SubtaskRecord[]) {}

  loadSubtasks(): Promise<readonly SubtaskRecord[]> {
    this.callOrder.push('loadSubtasks');
    return Promise.resolve(this.subtasks);
  }

  loadPreviousRollups(): Promise<ReadonlyMap<string, PhaseRollup>> {
    this.callOrder.push('loadPreviousRollups');
    return Promise.resolve(this.previousRollups);
  }

  savePhaseRollups(_epicKey: string, rollups: readonly PhaseRollup[]): Promise<void> {
    this.callOrder.push('savePhaseRollups');
    this.savedRollups = [...rollups];
    return Promise.resolve();
  }

  deleteObsoleteRollups(): Promise<number> {
    this.callOrder.push('deleteObsoleteRollups');
    return Promise.resolve(this.obsoleteRemoved);
  }

  saveGroupRollups(_epicKey: string, rollups: readonly GroupRollup[]): Promise<void> {
    this.callOrder.push('saveGroupRollups');
    this.savedGroupRollups = [...rollups];
    return Promise.resolve();
  }

  deleteObsoleteGroupRollups(): Promise<number> {
    this.callOrder.push('deleteObsoleteGroupRollups');
    return Promise.resolve(this.obsoleteGroupRemoved);
  }

  saveSubtaskActualDates(rows: readonly SubtaskActualRecord[]): Promise<void> {
    this.callOrder.push('saveSubtaskActualDates');
    this.savedActualDates.push(...rows);
    return Promise.resolve();
  }

  savePlanShifts(
    _epicKey: string,
    shifts: readonly PlanShiftRecord[],
  ): Promise<{ skippedNullBoundary: number }> {
    this.callOrder.push('savePlanShifts');
    this.savedShifts.push(...shifts);
    return Promise.resolve({ skippedNullBoundary: 0 });
  }

  existingSnapshotDates(): Promise<ReadonlySet<string>> {
    return Promise.resolve(this.existingDates);
  }

  previousTotalScope(): Promise<number | undefined> {
    return Promise.resolve(undefined);
  }

  saveSnapshots(
    rows: readonly DailySnapshotData[],
  ): Promise<{ written: number; skippedStale: number }> {
    this.callOrder.push('saveSnapshots');
    this.savedSnapshots.push(...rows);
    return Promise.resolve({
      written: rows.length - this.staleWrites,
      skippedStale: this.staleWrites,
    });
  }

  invalidateChartCache(): Promise<void> {
    this.callOrder.push('invalidateChartCache');
    this.cacheInvalidations += 1;
    return Promise.resolve();
  }

  markDirty(epicKey: string): Promise<void> {
    this.dirty.add(epicKey);
    return Promise.resolve();
  }
}

let redis: FakeLockRedis;
const NOW = new Date('2026-03-11T00:01:00Z');

const run = (ports: FakePorts, from = '2026-03-09', to = '2026-03-13', token = 'job-1') =>
  reconstructEpic(
    {
      ports,
      redis,
      calendar: CAL,
      statusIdMap: STATUS,
      sourceReadAtMs: NOW.getTime(),
      now: () => NOW,
      lockToken: token,
    },
    { epicKey: EPIC, from, to },
  );

beforeEach(() => {
  redis = new FakeLockRedis();
});

describe('khoá', () => {
  it('job thứ hai không lấy được khoá thì đẩy Epic vào dirty rồi thoát', async () => {
    // KHÔNG bỏ qua im lặng: mất một yêu cầu tính lại là mất vĩnh viễn
    await redis.set(lockKeyFor(EPIC), 'job-khac', 'PX', 60_000, 'NX');
    const ports = new FakePorts([sub('A')]);

    const r = await run(ports);

    expect(r.status).toBe('SKIPPED_LOCKED');
    expect(ports.dirty.has(EPIC)).toBe(true);
    expect(ports.savedSnapshots).toHaveLength(0);
  });

  it('job xong thì nhả khoá, job sau lấy được', async () => {
    await run(new FakePorts([sub('A')]));
    expect(redis.has(lockKeyFor(EPIC))).toBe(false);
  });

  it('job lỗi giữa chừng VẪN nhả khoá', async () => {
    const ports = new FakePorts([sub('A')]);
    ports.saveSnapshots = () => Promise.reject(new Error('DB sập'));

    await expect(run(ports)).rejects.toThrow('DB sập');
    // Không nhả thì Epic bị bỏ qua tới hết TTL 15 phút
    expect(redis.has(lockKeyFor(EPIC))).toBe(false);
  });

  it('không nhả nhầm khoá của job khác khi job lỗi', async () => {
    const ports = new FakePorts([sub('A')]);
    const r = await run(ports, '2026-03-09', '2026-03-13', 'job-1');
    expect(r.status).toBe('DONE');
    // job-2 chạy sau, lấy được khoá mới
    const r2 = await run(new FakePorts([sub('A')]), '2026-03-09', '2026-03-13', 'job-2');
    expect(r2.status).toBe('DONE');
  });
});

describe('thứ tự giai đoạn', () => {
  it('phase_rollup được tính và ghi TRƯỚC khi dựng snapshot', async () => {
    // Làm ngược lại thì snapshot dùng ngày Phase cũ và đường Kế hoạch lệch đúng
    // một lượt đồng bộ — lỗi im lặng
    const ports = new FakePorts([sub('A')]);
    await run(ports);

    const iRollup = ports.callOrder.indexOf('savePhaseRollups');
    const iSnap = ports.callOrder.indexOf('saveSnapshots');
    expect(iRollup).toBeGreaterThanOrEqual(0);
    expect(iRollup).toBeLessThan(iSnap);
  });

  it('bản rollup CŨ được đọc TRƯỚC khi ghi bản mới', async () => {
    // Đọc sau thì so bản mới với chính nó và không bao giờ phát hiện dịch chuyển
    const ports = new FakePorts([sub('A')]);
    await run(ports);
    expect(ports.callOrder.indexOf('loadPreviousRollups')).toBeLessThan(
      ports.callOrder.indexOf('savePhaseRollups'),
    );
  });

  it('cache bị xoá SAU KHI ghi snapshot xong', async () => {
    // Xoá trước thì request xen vào giữa sẽ nạp lại dữ liệu cũ và cache thêm 15 phút
    const ports = new FakePorts([sub('A')]);
    await run(ports);
    expect(ports.callOrder.indexOf('saveSnapshots')).toBeLessThan(
      ports.callOrder.indexOf('invalidateChartCache'),
    );
  });
});

describe('dựng snapshot', () => {
  it('dựng đúng một snapshot cho mỗi ngày làm việc', async () => {
    const ports = new FakePorts([sub('A')]);
    const r = await run(ports, '2026-03-09', '2026-03-13');
    expect(r.status === 'DONE' && r.daysComputed).toBe(5);
    expect(ports.savedSnapshots.map((s) => s.snapshotDate)).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
  });

  it('cuối tuần CŨNG có snapshot — giờ log Thứ 7/CN hiện đúng ngày (2026-08)', async () => {
    // Trước đây cuối tuần bị bỏ qua và mọi tiến độ cuối tuần dồn vào snapshot
    // sáng Thứ 2 — người xem không thấy team đã làm hôm nào. Nay chốt sổ MỌI
    // ngày lịch: cuối tuần không ai làm thì snapshot phẳng, biểu đồ bôi xám.
    const ports = new FakePorts([sub('A')]);
    await run(ports, '2026-03-13', '2026-03-16');
    expect(ports.savedSnapshots.map((s) => s.snapshotDate)).toEqual([
      '2026-03-13',
      '2026-03-14',
      '2026-03-15',
      '2026-03-16',
    ]);
  });

  it('ngày lễ cũng có snapshot, cùng lý do với cuối tuần', async () => {
    const ports = new FakePorts([sub('A')]);
    await reconstructEpic(
      {
        ports,
        redis,
        calendar: { ...CAL, holidays: new Set(['2026-03-10']) },
        statusIdMap: STATUS,
        sourceReadAtMs: NOW.getTime(),
        now: () => NOW,
        lockToken: 'job-1',
      },
      { epicKey: EPIC, from: '2026-03-09', to: '2026-03-11' },
    );
    expect(ports.savedSnapshots.map((s) => s.snapshotDate)).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
    ]);
  });

  it('mọi snapshot mang cùng source_read_at của lượt chạy', async () => {
    const ports = new FakePorts([sub('A')]);
    await run(ports);
    for (const s of ports.savedSnapshots) {
      expect(s.sourceReadAtMs).toBe(NOW.getTime());
    }
  });

  it('scope_added tính nối tiếp giữa các ngày trong cùng lượt chạy', async () => {
    const ports = new FakePorts([
      sub('A', { originalEstimateSeconds: 10 * H }),
      sub('B', {
        originalEstimateSeconds: 30 * H,
        createdAtMs: Date.parse('2026-03-11T02:00:00Z'),
      }),
    ]);
    await run(ports, '2026-03-09', '2026-03-13');

    const d10 = ports.savedSnapshots.find((s) => s.snapshotDate === '2026-03-10')!;
    const d11 = ports.savedSnapshots.find((s) => s.snapshotDate === '2026-03-11')!;
    expect(d10.scopeAddedS).toBe(0);
    expect(d11.scopeAddedS).toBe(30 * H);
  });
});

describe('bù ngày thiếu — E-12', () => {
  it('đếm đúng số ngày chưa có snapshot', async () => {
    const ports = new FakePorts([sub('A')]);
    ports.existingDates = new Set(['2026-03-09', '2026-03-10']);
    const r = await run(ports, '2026-03-09', '2026-03-13');
    expect(r.status === 'DONE' && r.daysBackfilled).toBe(3);
  });

  it('đã đủ snapshot thì daysBackfilled bằng 0 nhưng vẫn tính lại', async () => {
    const ports = new FakePorts([sub('A')]);
    ports.existingDates = new Set([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
    const r = await run(ports, '2026-03-09', '2026-03-13');
    expect(r.status === 'DONE' && r.daysBackfilled).toBe(0);
    expect(ports.savedSnapshots).toHaveLength(5);
  });
});

describe('chống ghi đè bằng dữ liệu cũ — E-19', () => {
  it('snapshot bị chặn vì dữ liệu cũ được BÁO CÁO, không bỏ qua im lặng', async () => {
    const ports = new FakePorts([sub('A')]);
    ports.staleWrites = 2;
    const r = await run(ports, '2026-03-09', '2026-03-13');
    expect(r.status === 'DONE' && r.snapshotsSkippedStale).toBe(2);
    expect(r.status === 'DONE' && r.snapshotsWritten).toBe(3);
  });
});

describe('dịch chuyển kế hoạch — E-24, R-11', () => {
  it('lần chạy đầu không sinh bản ghi dịch chuyển nào', async () => {
    const ports = new FakePorts([sub('A')]);
    const r = await run(ports);
    expect(r.status === 'DONE' && r.planShifts).toBe(0);
    expect(ports.savedShifts).toHaveLength(0);
  });

  it('plan_end bị đẩy lùi thì sinh bản ghi END_MOVED', async () => {
    const ports = new FakePorts([sub('A', { wbsEndDate: '2026-03-13' })]);
    ports.previousRollups = new Map([
      [
        'DESIGN',
        {
          phaseCode: 'DESIGN',
          planStart: '2026-03-02',
          planEnd: '2026-03-06',
          planWorkdays: 5,
          actualStart: null,
          actualEnd: null,
          actualEndIsProvisional: false,
          totalOriginalS: 8 * H,
          subtaskCount: 1,
          missingDateCount: 0,
          warnings: [],
        },
      ],
    ]);

    const r = await run(ports);
    expect(r.status === 'DONE' && r.planShifts).toBe(1);
    expect(ports.savedShifts[0]!.shiftType).toBe('END_MOVED');
    expect(ports.savedShifts[0]!.toDate).toBe('2026-03-13');
  });

  it('Phase không còn Sub-task nào thì bản rollup cũ bị xoá', async () => {
    const ports = new FakePorts([sub('A', { phaseCode: 'DEVELOPMENT' })]);
    ports.obsoleteRemoved = 1;
    const r = await run(ports);
    expect(r.status === 'DONE' && r.obsoleteRollupsRemoved).toBe(1);
    expect(ports.savedRollups.map((x) => x.phaseCode)).toEqual(['DEVELOPMENT']);
  });
});

describe('idempotency', () => {
  it('chạy hai lần liên tiếp cho ra dữ liệu giống hệt nhau', async () => {
    const subs = [
      sub('A', { changelog: [status('3', '2026-03-09T02:00:00Z')] }),
      sub('B', { originalEstimateSeconds: 16 * H }),
    ];

    const first = new FakePorts(subs);
    await run(first);

    redis = new FakeLockRedis();
    const second = new FakePorts(subs);
    await run(second);

    expect(JSON.stringify(second.savedSnapshots)).toBe(JSON.stringify(first.savedSnapshots));
  });
});

describe('tổng hợp N tầng (DYNAMIC-TIERS-DESIGN §4.3)', () => {
  it('Epic 1 tầng (không groupPath) ⇒ KHÔNG ghi group_rollup, snapshot không có perTier', async () => {
    const ports = new FakePorts([sub('A'), sub('B', { phaseCode: 'DEV' })]);
    await run(ports);

    expect(ports.savedGroupRollups).toHaveLength(0);
    // Vẫn xoá sạch (dọn tàn dư nếu từng đa tầng) — cổng vẫn được gọi.
    expect(ports.callOrder).toContain('saveGroupRollups');
    expect(ports.callOrder).toContain('deleteObsoleteGroupRollups');
    expect(ports.savedSnapshots.every((s) => s.perTier === undefined)).toBe(true);
  });

  it('Epic đa tầng ⇒ ghi group_rollup theo prefix + snapshot có perTier cộng dồn', async () => {
    const ports = new FakePorts([
      sub('L1', { phaseCode: 'DESIGN', groupPath: ['SA', 'DESIGN'] }),
      sub('L2', { phaseCode: 'DESIGN', groupPath: ['SA', 'DESIGN'] }),
      sub('L3', { phaseCode: 'DEV', groupPath: ['SB', 'DEV'] }),
    ]);
    await run(ports);

    // Nút prefix: [SA],[SB] (tầng 1) + [SA,DESIGN],[SB,DEV] (tầng 2) = 4 nút.
    expect(ports.savedGroupRollups).toHaveLength(4);
    const byPath = (p: string[]) =>
      ports.savedGroupRollups.find((r) => JSON.stringify(r.groupPath) === JSON.stringify(p));
    expect(byPath(['SA'])?.subtaskCount).toBe(2);
    expect(byPath(['SA', 'DESIGN'])?.subtaskCount).toBe(2);
    expect(byPath(['SB'])?.subtaskCount).toBe(1);

    // Mọi snapshot mang cây perTier; tổng nút cha = Σ nút con.
    expect(ports.savedSnapshots.every((s) => s.perTier !== undefined)).toBe(true);
    const someDay = ports.savedSnapshots.find((s) => (s.perTier?.length ?? 0) > 0)!;
    const node = (p: string[]) =>
      someDay.perTier!.find((t) => JSON.stringify(t.groupPath) === JSON.stringify(p))!;
    expect(node(['SA']).originalS).toBe(node(['SA', 'DESIGN']).originalS);
  });
});
