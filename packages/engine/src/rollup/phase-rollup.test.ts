import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  type ChangelogEvent,
  type StatusIdMap,
  type SubtaskRecord,
  type WorkCalendar,
  type WorklogRecord,
} from '@app/shared';
import { computePhaseRollups } from './compute-phase-rollups.js';
import { detectPlanShift, planShiftLevel } from './detect-plan-shift.js';

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

const wl = (iso: string): WorklogRecord => ({
  worklogId: `w-${iso}`,
  issueKey: 'x',
  timeSpentSeconds: 8 * H,
  startedAtMs: Date.parse(iso),
  isDeleted: false,
});

const sub = (key: string, over: Partial<SubtaskRecord> = {}): SubtaskRecord => ({
  key,
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

const run = (subtasks: SubtaskRecord[], calendar = cal()) =>
  computePhaseRollups({ subtasks, calendar, statusIdMap: STATUS });

describe('công thức tổng hợp — ví dụ PRD §2.7.1', () => {
  /**
   * | Sub-task | wbs_start | wbs_end | actual_start | actual_end   |
   * | PAY-111  | 02/03     | 04/03   | 03/03        | 05/03        |
   * | PAY-112  | 03/03     | 06/03   | 03/03        | 09/03        |
   * | PAY-113  | 02/03     | 05/03   | 04/03        | (chưa xong)  |
   *
   * Ngày actual lấy từ worklog: start = worklog sớm nhất, end = worklog muộn
   * nhất (chỉ khi đã Done). PAY-113 chưa Done nên end chưa tính.
   */
  const THREE = [
    sub('PAY-111', {
      wbsStartDate: '2026-03-02',
      wbsEndDate: '2026-03-04',
      changelog: [status('3', '2026-03-02T20:00:00Z'), status('10001', '2026-03-05T20:00:00Z')],
      worklogs: [wl('2026-03-02T20:00:00Z'), wl('2026-03-05T02:00:00Z')],
    }),
    sub('PAY-112', {
      wbsStartDate: '2026-03-03',
      wbsEndDate: '2026-03-06',
      changelog: [status('3', '2026-03-02T20:00:00Z'), status('10001', '2026-03-09T20:00:00Z')],
      worklogs: [wl('2026-03-02T20:00:00Z'), wl('2026-03-09T02:00:00Z')],
    }),
    sub('PAY-113', {
      wbsStartDate: '2026-03-02',
      wbsEndDate: '2026-03-05',
      changelog: [status('3', '2026-03-03T20:00:00Z')],
      worklogs: [wl('2026-03-03T20:00:00Z')],
    }),
  ];

  it('tái hiện đúng ví dụ 3 Sub-task: plan 02/03→06/03, actual 03/03→09/03', () => {
    const [r] = run(THREE);
    expect(r!.planStart).toBe('2026-03-02');
    expect(r!.planEnd).toBe('2026-03-06');
    expect(r!.actualStart).toBe('2026-03-03');
    expect(r!.actualEnd).toBe('2026-03-09');
  });

  it('actualEndIsProvisional = true khi còn ít nhất một Sub-task chưa Done', () => {
    expect(run(THREE)[0]!.actualEndIsProvisional).toBe(true);
  });

  it('actualEndIsProvisional = false khi mọi Sub-task đã Done', () => {
    const allDone = THREE.map((s) => ({
      ...s,
      changelog: [...s.changelog, status('10001', '2026-03-09T20:00:00Z')],
    }));
    expect(run(allDone)[0]!.actualEndIsProvisional).toBe(false);
  });

  it('Sub-task xong sớm nhưng còn cái khác dở vẫn là provisional', () => {
    // "BẤT KỲ Sub-task nào chưa Done", không phải "cái kết thúc muộn nhất chưa Done"
    const mixed = [
      sub('A', { changelog: [status('10001', '2026-03-02T20:00:00Z')] }),
      sub('B', { changelog: [status('3', '2026-03-01T20:00:00Z')] }),
    ];
    expect(run(mixed)[0]!.actualEndIsProvisional).toBe(true);
  });

  it('Sub-task đã bị gỡ khỏi Epic không tham gia tính MIN/MAX', () => {
    const withRemoved = [
      ...THREE,
      sub('PAY-199', {
        wbsStartDate: '2026-01-01',
        wbsEndDate: '2026-12-31',
        removedAtMs: Date.parse('2026-03-05T00:00:00Z'),
      }),
    ];
    const [r] = run(withRemoved);
    expect(r!.planStart).toBe('2026-03-02');
    expect(r!.planEnd).toBe('2026-03-06');
    expect(r!.subtaskCount).toBe(3);
  });

  it('nhóm theo phase_code của Task cha, mỗi Phase một bản ghi', () => {
    const two = [
      sub('A', { phaseCode: 'DESIGN', wbsStartDate: '2026-03-02', wbsEndDate: '2026-03-04' }),
      sub('B', { phaseCode: 'DEVELOPMENT', wbsStartDate: '2026-03-05', wbsEndDate: '2026-03-10' }),
    ];
    const rollups = run(two);
    expect(rollups.map((r) => r.phaseCode)).toEqual(['DESIGN', 'DEVELOPMENT']);
    expect(rollups[0]!.planEnd).toBe('2026-03-04');
    expect(rollups[1]!.planEnd).toBe('2026-03-10');
  });
});

describe('thiếu ngày kế hoạch', () => {
  it('Sub-task thiếu wbs_start_date bị bỏ qua khi tính MIN nhưng vẫn đếm vào missing_date_count', () => {
    const list = [
      sub('A', { wbsStartDate: null, wbsEndDate: '2026-03-10' }),
      sub('B', { wbsStartDate: '2026-03-05', wbsEndDate: '2026-03-08' }),
    ];
    const [r] = run(list);
    expect(r!.planStart).toBe('2026-03-05');
    expect(r!.planEnd).toBe('2026-03-10');
    expect(r!.missingDateCount).toBe(1);
  });

  it('thiếu MỘT trong hai ngày đã tính là thiếu', () => {
    const list = [
      sub('A', { wbsStartDate: '2026-03-05', wbsEndDate: null }),
      sub('B', { wbsStartDate: null, wbsEndDate: '2026-03-08' }),
      sub('C', { wbsStartDate: null, wbsEndDate: null }),
    ];
    expect(run(list)[0]!.missingDateCount).toBe(3);
  });

  it('toàn bộ Sub-task thiếu ngày thì plan_start, plan_end và plan_workdays đều null', () => {
    const [r] = run([sub('A'), sub('B')]);
    expect(r!.planStart).toBeNull();
    expect(r!.planEnd).toBeNull();
    // KHÔNG được là Infinity — Math.min() trên mảng rỗng cho Infinity
    expect(r!.planWorkdays).toBeNull();
  });

  it('Sub-task UNPARSED vẫn được cộng vào total_original_s và subtask_count', () => {
    // C-11: công việc là thật, chỉ có tiêu đề là đặt sai
    const list = [
      sub('A', { originalEstimateSeconds: 10 * H }),
      sub('B', { originalEstimateSeconds: 6 * H }),
    ];
    const [r] = run(list);
    expect(r!.totalOriginalS).toBe(16 * H);
    expect(r!.subtaskCount).toBe(2);
  });
});

describe('dữ liệu Jira sai', () => {
  it('plan_start muộn hơn plan_end thì cảnh báo INVALID_PHASE_PERIOD và Phase thành 1 ngày', () => {
    const list = [sub('A', { wbsStartDate: '2026-03-10', wbsEndDate: '2026-03-05' })];
    const [r] = run(list);
    expect(r!.warnings.some((w) => w.code === 'INVALID_PHASE_PERIOD')).toBe(true);
    expect(r!.planStart).toBe('2026-03-10');
    expect(r!.planEnd).toBe('2026-03-10');
    expect(r!.planWorkdays).toBe(1);
  });

  it('KHÔNG đảo ngầm hai mốc cho nhau', () => {
    // Đảo thành 05/03 → 10/03 sẽ cho ra một Phase 5 ngày trông rất hợp lý, và
    // không ai đi sửa dữ liệu sai trên Jira nữa
    const [r] = run([sub('A', { wbsStartDate: '2026-03-10', wbsEndDate: '2026-03-05' })]);
    expect(r!.planStart).not.toBe('2026-03-05');
    expect(r!.planWorkdays).not.toBe(4);
  });
});

describe('số ngày làm việc của Phase', () => {
  it('plan_workdays loại đúng cuối tuần', () => {
    // T2 09/03 → T2 16/03 = 6 ngày làm việc
    const [r] = run([sub('A', { wbsStartDate: '2026-03-09', wbsEndDate: '2026-03-16' })]);
    expect(r!.planWorkdays).toBe(6);
  });

  it('plan_workdays loại đúng ngày lễ', () => {
    const tet = cal({ holidays: new Set(['2026-03-10', '2026-03-11']) });
    const [r] = run([sub('A', { wbsStartDate: '2026-03-09', wbsEndDate: '2026-03-13' })], tet);
    expect(r!.planWorkdays).toBe(3);
  });
});

describe('plannedItems — lịch ramp per-Sub-task', () => {
  it('chỉ gồm Sub-task đủ HAI ngày, kèm planWorkdays tính sẵn', () => {
    const [r] = run([
      sub('A', { wbsStartDate: '2026-03-02', wbsEndDate: '2026-03-06' }), // đủ ngày → có mặt
      sub('B', { wbsStartDate: '2026-03-02', wbsEndDate: null }), // thiếu ngày kết thúc → loại
      sub('C', { wbsStartDate: null, wbsEndDate: '2026-03-06' }), // thiếu ngày bắt đầu → loại
    ]);
    expect(r!.plannedItems).toHaveLength(1);
    expect(r!.plannedItems[0]).toEqual({
      wbsStartDate: '2026-03-02',
      wbsEndDate: '2026-03-06',
      originalS: 8 * H,
      planWorkdays: 5, // 02→06/03 = 5 ngày làm việc, tính sẵn lúc dựng rollup
    });
    // Cả B và C đều thiếu một mốc → missingDateCount = 2, nhưng vẫn cộng khối lượng.
    expect(r!.missingDateCount).toBe(2);
  });

  it('KHÔNG gồm Sub-task đã bị gỡ khỏi Epic', () => {
    const [r] = run([
      sub('A', { wbsStartDate: '2026-03-02', wbsEndDate: '2026-03-06' }),
      sub('B', {
        wbsStartDate: '2026-03-02',
        wbsEndDate: '2026-03-06',
        removedAtMs: Date.parse('2026-03-05T00:00:00Z'),
      }),
    ]);
    expect(r!.plannedItems).toHaveLength(1);
    expect(r!.plannedItems.map((i) => i.originalS)).toEqual([8 * H]);
  });

  it('planWorkdays của item cũng loại ngày lễ/cuối tuần', () => {
    const tet = cal({ holidays: new Set(['2026-03-10', '2026-03-11']) });
    const [r] = run([sub('A', { wbsStartDate: '2026-03-09', wbsEndDate: '2026-03-13' })], tet);
    expect(r!.plannedItems[0]!.planWorkdays).toBe(3);
  });
});

// ---------------------------------------------------------------------------

const rollup = (over: Partial<Parameters<typeof detectPlanShift>[1]>) =>
  ({
    phaseCode: 'DESIGN',
    planStart: null,
    planEnd: null,
    planWorkdays: null,
    actualStart: null,
    actualEnd: null,
    actualEndIsProvisional: false,
    totalOriginalS: 0,
    subtaskCount: 0,
    missingDateCount: 0,
    plannedItems: [],
    warnings: [],
    ...over,
  }) as Parameters<typeof detectPlanShift>[1];

describe('lịch sử dịch chuyển kế hoạch — R-11', () => {
  it('thêm Sub-task có wbs_end_date muộn hơn thì sinh 1 bản ghi END_MOVED', () => {
    const before = rollup({ planStart: '2026-03-02', planEnd: '2026-03-06' });
    const after = rollup({ planStart: '2026-03-02', planEnd: '2026-03-13' });
    const subs = [sub('PAY-125', { wbsStartDate: '2026-03-09', wbsEndDate: '2026-03-13' })];

    const shifts = detectPlanShift(before, after, subs, cal());
    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.shiftType).toBe('END_MOVED');
    expect(shifts[0]!.fromDate).toBe('2026-03-06');
    expect(shifts[0]!.toDate).toBe('2026-03-13');
  });

  it('shifted_workdays đếm theo ngày LÀM VIỆC, không phải ngày lịch', () => {
    // 06/03 (T6) → 09/03 (T2) là 3 ngày lịch nhưng chỉ 1 ngày làm việc
    const shifts = detectPlanShift(
      rollup({ planEnd: '2026-03-06' }),
      rollup({ planEnd: '2026-03-09' }),
      [],
      cal(),
    );
    expect(shifts[0]!.shiftedWorkdays).toBe(1);
  });

  it('bản ghi END_MOVED ghi đúng caused_by_keys là Sub-task gây ra thay đổi', () => {
    const subs = [
      sub('PAY-121', { wbsEndDate: '2026-03-06' }),
      sub('PAY-125', { wbsEndDate: '2026-03-13' }),
      sub('PAY-126', { wbsEndDate: '2026-03-13' }),
    ];
    const shifts = detectPlanShift(
      rollup({ planEnd: '2026-03-06' }),
      rollup({ planEnd: '2026-03-13' }),
      subs,
      cal(),
    );
    expect(shifts[0]!.causedByKeys).toEqual(['PAY-125', 'PAY-126']);
  });

  it('plan_end kéo sớm lên thì shifted_workdays là số ÂM', () => {
    const shifts = detectPlanShift(
      rollup({ planEnd: '2026-03-13' }),
      rollup({ planEnd: '2026-03-09' }),
      [],
      cal(),
    );
    expect(shifts[0]!.shiftedWorkdays).toBeLessThan(0);
    expect(shifts[0]!.shiftedWorkdays).toBe(-4);
  });

  it('plan_start đổi thì sinh bản ghi START_MOVED', () => {
    const shifts = detectPlanShift(
      rollup({ planStart: '2026-03-09' }),
      rollup({ planStart: '2026-03-02' }),
      [],
      cal(),
    );
    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.shiftType).toBe('START_MOVED');
  });

  it('cả hai mốc cùng đổi thì sinh hai bản ghi', () => {
    const shifts = detectPlanShift(
      rollup({ planStart: '2026-03-02', planEnd: '2026-03-06' }),
      rollup({ planStart: '2026-03-03', planEnd: '2026-03-13' }),
      [],
      cal(),
    );
    expect(shifts.map((s) => s.shiftType)).toEqual(['START_MOVED', 'END_MOVED']);
  });

  it('lần tính đầu tiên (chưa có bản cũ) KHÔNG sinh bản ghi nào', () => {
    // Sinh bản ghi giả ngay lần chạy đầu sẽ làm cảnh báo mất tin cậy
    expect(detectPlanShift(null, rollup({ planEnd: '2026-03-13' }), [], cal())).toEqual([]);
  });

  it('plan_end không đổi thì không sinh bản ghi nào', () => {
    const same = rollup({ planStart: '2026-03-02', planEnd: '2026-03-06' });
    expect(detectPlanShift(same, same, [], cal())).toEqual([]);
  });

  it('từ null thành có mốc vẫn ghi lại, shifted_workdays = 0', () => {
    const shifts = detectPlanShift(
      rollup({ planEnd: null }),
      rollup({ planEnd: '2026-03-13' }),
      [],
      cal(),
    );
    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.shiftedWorkdays).toBe(0);
    expect(shifts[0]!.fromDate).toBeNull();
  });

  it('Sub-task đã gỡ khỏi Epic không bị tính là thủ phạm', () => {
    const subs = [
      sub('PAY-125', { wbsEndDate: '2026-03-13', removedAtMs: Date.parse('2026-03-01T00:00:00Z') }),
      sub('PAY-126', { wbsEndDate: '2026-03-13' }),
    ];
    const shifts = detectPlanShift(
      rollup({ planEnd: '2026-03-06' }),
      rollup({ planEnd: '2026-03-13' }),
      subs,
      cal(),
    );
    expect(shifts[0]!.causedByKeys).toEqual(['PAY-126']);
  });
});

describe('ngưỡng cảnh báo R-11', () => {
  it('lùi quá 20% độ dài Phase thì WARN', () => {
    expect(planShiftLevel(3, 10)).toBe('WARN');
  });

  it('lùi quá 40% thì CRITICAL', () => {
    expect(planShiftLevel(5, 10)).toBe('CRITICAL');
  });

  it('đúng 20% chưa vượt ngưỡng', () => {
    expect(planShiftLevel(2, 10)).toBe('OK');
  });

  it('không có độ dài kế hoạch thì không kết luận', () => {
    expect(planShiftLevel(5, null)).toBe('OK');
    expect(planShiftLevel(5, 0)).toBe('OK');
  });
});
