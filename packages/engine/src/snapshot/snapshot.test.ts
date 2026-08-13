import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  type ChangelogEvent,
  type PhaseRollup,
  type StatusIdMap,
  type SubtaskRecord,
  type WorkCalendar,
  type WorklogRecord,
} from '@app/shared';
import { buildSnapshotForDay, diffScopeAgainstPreviousDay } from './build-snapshot-for-day.js';

const H = 3600;
const STATUS: StatusIdMap = new Map([
  ['1', 'new'],
  ['3', 'indeterminate'],
  ['10001', 'done'],
]);

const cal = (over: Partial<WorkCalendar> = {}): WorkCalendar => ({
  calendarId: 'VN_STANDARD',
  timezone: 'Asia/Ho_Chi_Minh',
  workdaysMask: DEFAULT_WORKDAYS_MASK,
  hoursPerDay: 8,
  holidays: new Set<string>(),
  warnings: [],
  ...over,
});

const status = (to: string, iso: string): ChangelogEvent => ({
  issueKey: 'x',
  field: 'status',
  fromValue: null,
  toValue: to,
  createdAtMs: Date.parse(iso),
});

const wl = (hours: number, iso: string): WorklogRecord => ({
  worklogId: `w-${iso}-${hours}`,
  issueKey: 'x',
  timeSpentSeconds: hours * H,
  startedAtMs: Date.parse(iso),
  isDeleted: false,
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

const rollup = (phaseCode: string, hours: number, over: Partial<PhaseRollup> = {}): PhaseRollup => ({
  phaseCode,
  planStart: '2026-03-02',
  planEnd: '2026-03-06',
  planWorkdays: 5,
  actualStart: null,
  actualEnd: null,
  actualEndIsProvisional: false,
  totalOriginalS: hours * H,
  subtaskCount: 1,
  missingDateCount: 0,
  plannedItems: [{ wbsStartDate: '2026-03-02', wbsEndDate: '2026-03-06', originalS: hours * H, planWorkdays: 5 }],
  warnings: [],
  ...over,
});

const build = (
  subtasks: SubtaskRecord[],
  rollups: PhaseRollup[] = [rollup('DESIGN', 40)],
  dateStr = '2026-03-10',
  previousTotalScopeS?: number,
) =>
  buildSnapshotForDay({
    epicKey: 'PAY-100',
    subtasks,
    phaseRollups: rollups,
    dateStr,
    calendar: cal(),
    statusIdMap: STATUS,
    sourceReadAtMs: Date.parse('2026-03-11T00:01:00Z'),
    previousTotalScopeS,
  });

describe('cộng dồn ba tầng', () => {
  it('tổng của các Phase bằng đúng giá trị của Epic, sai số 0', () => {
    const subs = [
      sub('A', { phaseCode: 'DESIGN', originalEstimateSeconds: 10 * H, worklogs: [wl(3, '2026-03-05T02:00:00Z')] }),
      sub('B', { phaseCode: 'DESIGN', originalEstimateSeconds: 6 * H }),
      sub('C', { phaseCode: 'DEVELOPMENT', originalEstimateSeconds: 20 * H, worklogs: [wl(5, '2026-03-06T02:00:00Z')] }),
    ];
    const s = build(subs, [rollup('DESIGN', 16), rollup('DEVELOPMENT', 20)]);

    const sumRemaining = s.perPhase.reduce((n, p) => n + p.remainingS, 0);
    const sumSpent = s.perPhase.reduce((n, p) => n + p.spentS, 0);
    const sumOriginal = s.perPhase.reduce((n, p) => n + p.originalS, 0);

    expect(sumRemaining).toBe(s.actualRemainingS);
    expect(sumSpent).toBe(s.totalSpentS);
    expect(sumOriginal).toBe(s.totalScopeS);
  });

  it('Sub-task UNPARSED vẫn được cộng đủ vào tổng', () => {
    // Loại nó ra "cho sạch dữ liệu" sẽ làm tổng khối lượng Epic thiếu hụt (C-11)
    const withUnparsed = build([
      sub('A', { originalEstimateSeconds: 10 * H }),
      sub('B-sai-tieu-de', { originalEstimateSeconds: 6 * H }),
    ]);
    expect(withUnparsed.totalScopeS).toBe(16 * H);
  });

  it('Sub-task thiếu wbs_* vẫn được cộng đủ vào tổng', () => {
    const s = build([
      sub('A', { originalEstimateSeconds: 10 * H }),
      sub('B', { originalEstimateSeconds: 6 * H, wbsStartDate: null, wbsEndDate: null }),
    ]);
    expect(s.totalScopeS).toBe(16 * H);
    expect(s.countTodo).toBe(2);
  });

  it('Sub-task thuộc Phase UNCLASSIFIED vẫn được cộng vào tổng của Epic', () => {
    const s = build(
      [
        sub('A', { phaseCode: 'DESIGN', originalEstimateSeconds: 10 * H }),
        sub('B', { phaseCode: 'UNCLASSIFIED', originalEstimateSeconds: 6 * H }),
      ],
      [rollup('DESIGN', 10)],
    );
    expect(s.totalScopeS).toBe(16 * H);
    expect(s.perPhase.map((p) => p.phaseCode)).toContain('UNCLASSIFIED');
  });

  it('Phase UNCLASSIFIED không có rollup thì plannedRemainingS = null, không làm hỏng tổng', () => {
    const s = build(
      [sub('B', { phaseCode: 'UNCLASSIFIED', originalEstimateSeconds: 6 * H })],
      [rollup('DESIGN', 10)],
    );
    const unc = s.perPhase.find((p) => p.phaseCode === 'UNCLASSIFIED')!;
    expect(unc.plannedRemainingS).toBeNull();
    expect(unc.originalS).toBe(6 * H);
  });

  it('chỉ Sub-task mang số liệu — không có đường nào để Task cha lọt vào tổng', () => {
    // Hàm chỉ nhận `SubtaskRecord[]`, nên Original Estimate nhập trên Task cha
    // không thể bị đếm hai lần
    const s = build([sub('A', { originalEstimateSeconds: 10 * H })]);
    expect(s.totalScopeS).toBe(10 * H);
  });
});

describe('lọc theo thời điểm', () => {
  it('Sub-task tạo sau mốc T không xuất hiện trong snapshot ngày đó', () => {
    const s = build([
      sub('A', { originalEstimateSeconds: 10 * H }),
      sub('B', { originalEstimateSeconds: 30 * H, createdAtMs: Date.parse('2026-03-15T00:00:00Z') }),
    ]);
    expect(s.totalScopeS).toBe(10 * H);
  });

  it('Sub-task bị gỡ vẫn xuất hiện trong snapshot của những ngày TRƯỚC khi gỡ', () => {
    const removed = sub('B', {
      originalEstimateSeconds: 30 * H,
      removedAtMs: Date.parse('2026-03-12T00:00:00Z'),
    });
    const s = build([sub('A', { originalEstimateSeconds: 10 * H }), removed], undefined, '2026-03-10');
    expect(s.totalScopeS).toBe(40 * H);
  });

  it('Sub-task bị gỡ không xuất hiện trong snapshot từ ngày gỡ trở đi', () => {
    // `removedAtMs > T` chứ không phải `>=` — dùng `>=` sẽ lệch một ngày
    const removed = sub('B', {
      originalEstimateSeconds: 30 * H,
      // Gỡ lúc 08:00 ngày 12/03 giờ VN
      removedAtMs: Date.parse('2026-03-12T01:00:00Z'),
    });
    const subs = [sub('A', { originalEstimateSeconds: 10 * H }), removed];
    expect(build(subs, undefined, '2026-03-11').totalScopeS).toBe(40 * H);
    expect(build(subs, undefined, '2026-03-12').totalScopeS).toBe(10 * H);
  });
});

describe('đếm trạng thái', () => {
  it('ba bộ đếm cộng lại bằng số Sub-task đang hoạt động', () => {
    const subs = [
      sub('A'),
      sub('B', { changelog: [status('3', '2026-03-05T02:00:00Z')] }),
      sub('C', { changelog: [status('10001', '2026-03-06T02:00:00Z')] }),
    ];
    const s = build(subs);
    expect(s.countTodo + s.countInProgress + s.countDone).toBe(3);
    expect([s.countTodo, s.countInProgress, s.countDone]).toEqual([1, 1, 1]);
  });

  it('bộ đếm của Phase cộng lại bằng bộ đếm của Epic', () => {
    const subs = [
      sub('A', { phaseCode: 'DESIGN' }),
      sub('B', { phaseCode: 'DEVELOPMENT', changelog: [status('10001', '2026-03-06T02:00:00Z')] }),
    ];
    const s = build(subs, [rollup('DESIGN', 8), rollup('DEVELOPMENT', 8)]);
    expect(s.perPhase.reduce((n, p) => n + p.countDone, 0)).toBe(s.countDone);
    expect(s.perPhase.reduce((n, p) => n + p.countTodo, 0)).toBe(s.countTodo);
  });

  it('đếm theo trạng thái TẠI MỐC T, không phải trạng thái hiện tại', () => {
    const s = build(
      [sub('A', { changelog: [status('10001', '2026-03-20T02:00:00Z')] })],
      undefined,
      '2026-03-10',
    );
    expect(s.countDone).toBe(0);
    expect(s.countTodo).toBe(1);
  });
});

describe('chênh lệch phạm vi', () => {
  it('thêm Sub-task 30 giờ thì scope_added_s bằng 30 giờ quy ra giây', () => {
    const s = build([sub('A', { originalEstimateSeconds: 40 * H })], undefined, '2026-03-10', 10 * H);
    expect(s.scopeAddedS).toBe(30 * H);
    expect(s.scopeRemovedS).toBe(0);
  });

  it('gỡ Sub-task 16 giờ thì scope_removed_s đúng bằng 16 giờ', () => {
    const s = build([sub('A', { originalEstimateSeconds: 24 * H })], undefined, '2026-03-10', 40 * H);
    expect(s.scopeRemovedS).toBe(16 * H);
    expect(s.scopeAddedS).toBe(0);
  });

  it('ngày đầu tiên không có snapshot trước thì cả hai bằng 0', () => {
    // Coi toàn bộ phạm vi ban đầu là "vừa phát sinh" sẽ tạo một dấu mốc giả to
    // đùng ở ngày đầu biểu đồ
    const s = build([sub('A', { originalEstimateSeconds: 40 * H })]);
    expect(s.scopeAddedS).toBe(0);
    expect(s.scopeRemovedS).toBe(0);
  });

  it('phạm vi không đổi thì cả hai bằng 0', () => {
    expect(diffScopeAgainstPreviousDay(40 * H, 40 * H)).toEqual({ addedS: 0, removedS: 0 });
  });
});

describe('ghép với đường Kế hoạch', () => {
  it('snapshot chứa cả plannedRemaining và actualRemaining', () => {
    const s = build([sub('A', { originalEstimateSeconds: 40 * H })], [rollup('DESIGN', 40)]);
    expect(typeof s.plannedRemainingS).toBe('number');
    expect(typeof s.actualRemainingS).toBe('number');
  });

  it('mọi Sub-task đều Done thì actualRemaining bằng 0', () => {
    const subs = [
      sub('A', { changelog: [status('10001', '2026-03-05T02:00:00Z')] }),
      sub('B', { changelog: [status('10001', '2026-03-06T02:00:00Z')] }),
    ];
    expect(build(subs).actualRemainingS).toBe(0);
  });

  it('mốc chốt sổ là 23:59:59.999 giờ địa phương quy về UTC', () => {
    const s = build([sub('A')]);
    expect(new Date(s.snapshotAtUtcMs).toISOString()).toBe('2026-03-10T16:59:59.999Z');
  });

  it('source_read_at là mốc ĐỌC Jira, giữ nguyên như truyền vào', () => {
    // Nhầm với mốc TÍNH XONG sẽ làm cơ chế chống ghi đè dữ liệu cũ mất tác dụng
    const s = build([sub('A')]);
    expect(s.sourceReadAtMs).toBe(Date.parse('2026-03-11T00:01:00Z'));
  });
});

describe('không sinh NaN', () => {
  it('Epic không có Sub-task nào cho ra toàn số 0, không phải NaN', () => {
    const s = build([]);
    expect(s.totalScopeS).toBe(0);
    expect(s.actualRemainingS).toBe(0);
    expect(s.totalSpentS).toBe(0);
    expect(s.perPhase).toEqual([]);
    expect(Number.isNaN(s.plannedRemainingS)).toBe(false);
  });

  it('mọi trường số của mọi Phase đều là số hữu hạn', () => {
    const subs = [
      sub('A', { phaseCode: 'DESIGN' }),
      sub('B', { phaseCode: 'UNCLASSIFIED', wbsStartDate: null, wbsEndDate: null }),
    ];
    const s = build(subs, [rollup('DESIGN', 8)]);
    for (const p of s.perPhase) {
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === 'number') expect(Number.isFinite(v), `${p.phaseCode}.${k}`).toBe(true);
      }
    }
  });
});
