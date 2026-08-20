import { describe, it, expect } from 'vitest';
import { DEFAULT_WORKDAYS_MASK, type PhaseRollup, type WorkCalendar } from '@app/shared';
import { computePlannedRemaining } from './compute-planned-remaining.js';

const H = 3600;

const cal = (over: Partial<WorkCalendar> = {}): WorkCalendar => ({
  calendarId: 'VN_STANDARD',
  timezone: 'Asia/Ho_Chi_Minh',
  workdaysMask: DEFAULT_WORKDAYS_MASK,
  hoursPerDay: 8,
  holidays: new Set<string>(),
  warnings: [],
  ...over,
});

const phase = (
  phaseCode: string,
  hours: number,
  planStart: string | null,
  planEnd: string | null,
  planWorkdays: number | null,
): PhaseRollup => ({
  phaseCode,
  planStart,
  planEnd,
  planWorkdays,
  actualStart: null,
  actualEnd: null,
  actualEndIsProvisional: false,
  totalOriginalS: hours * H,
  subtaskCount: 1,
  missingDateCount: 0,
  // Một item phủ TRỌN Phase ⇒ ramp per-Sub-task trùng khít ramp per-Phase cũ, nên
  // các con số kinh điển của ví dụ PRD giữ nguyên. Thiếu ngày → [] (Phase bị skip).
  plannedItems:
    planStart !== null && planEnd !== null && planWorkdays !== null
      ? [{ wbsStartDate: planStart, wbsEndDate: planEnd, originalS: hours * H, planWorkdays }]
      : [],
  warnings: [],
});

/** Ví dụ PRD §4.3.1 — Epic 200 giờ, 3 Phase. */
const EPIC_200H = [
  phase('DESIGN', 40, '2026-03-02', '2026-03-06', 5),
  phase('DEVELOPMENT', 120, '2026-03-09', '2026-03-27', 15),
  phase('TESTING', 40, '2026-03-23', '2026-03-27', 5),
];
const TOTAL = 200 * H;

const at = (d: string, phases = EPIC_200H, calendar = cal()) =>
  computePlannedRemaining(phases, TOTAL, d, calendar).seconds;

describe('ví dụ PRD §4.3.1', () => {
  it('ngày 10/03 ra đúng 144 giờ', () => {
    // Design: min(8×5, 40) = 40h — đã xong
    // Development: min(8×2, 120) = 16h — mới qua 2 ngày (09, 10)
    // Testing: 0h — chưa bắt đầu
    // 200 − 56 = 144
    expect(at('2026-03-10')).toBe(144 * H);
  });

  it('chi tiết phần đã cháy của từng Phase khớp bảng PRD', () => {
    const r = computePlannedRemaining(EPIC_200H, TOTAL, '2026-03-10', cal());
    expect(r.burnedByPhase.get('DESIGN')).toBe(40 * H);
    expect(r.burnedByPhase.get('DEVELOPMENT')).toBe(16 * H);
    expect(r.burnedByPhase.has('TESTING')).toBe(false); // chưa bắt đầu
  });

  it('ngày đầu tiên của Epic gần bằng TotalScope, chỉ trừ đúng 1 ngày của Design', () => {
    // 02/03 là ngày đầu của Design: đã qua 1 ngày làm việc → cháy 8h
    expect(at('2026-03-02')).toBe(192 * H);
  });

  it('ngày trước khi Epic bắt đầu bằng đúng TotalScope', () => {
    expect(at('2026-02-27')).toBe(TOTAL);
  });

  it('ngày cuối cùng của mọi Phase bằng 0', () => {
    expect(at('2026-03-27')).toBe(0);
  });

  it('sau ngày cuối cùng vẫn bằng 0, không âm', () => {
    expect(at('2026-04-30')).toBe(0);
  });
});

describe('hàm min chặn cháy quá', () => {
  it('Phase đã kết thúc không cháy quá khối lượng của chính nó', () => {
    // Design 40h kết thúc 06/03. Hỏi ngày 20/03 vẫn chỉ cháy đúng 40h.
    const r = computePlannedRemaining(EPIC_200H, TOTAL, '2026-03-20', cal());
    expect(r.burnedByPhase.get('DESIGN')).toBe(40 * H);
  });

  it('Phase chưa tới ngày bắt đầu thì cháy 0', () => {
    const r = computePlannedRemaining(EPIC_200H, TOTAL, '2026-03-05', cal());
    expect(r.burnedByPhase.has('DEVELOPMENT')).toBe(false);
    expect(r.burnedByPhase.has('TESTING')).toBe(false);
  });

  it('Phase hỏi đúng ngày kết thúc thì cháy TRỌN VẸN khối lượng', () => {
    // countWorkdays tính cả hai đầu: 02/03 → 06/03 là 5 ngày, không phải 4.
    // Sai một đơn vị ở đây làm đường Kế hoạch không bao giờ chạm 0.
    const only = [phase('DESIGN', 40, '2026-03-02', '2026-03-06', 5)];
    expect(computePlannedRemaining(only, 40 * H, '2026-03-06', cal()).seconds).toBe(0);
  });
});

describe('thiếu dữ liệu kế hoạch', () => {
  it('Phase có planStart null bị bỏ qua, KHÔNG làm hỏng phép tính các Phase khác', () => {
    const mixed = [
      phase('DESIGN', 40, '2026-03-02', '2026-03-06', 5),
      phase('DEVELOPMENT', 120, null, null, null),
    ];
    const r = computePlannedRemaining(mixed, TOTAL, '2026-03-10', cal());
    expect(r.seconds).toBe(160 * H); // 200 − 40
    expect(r.skippedPhases.map((s) => s.phaseCode)).toEqual(['DEVELOPMENT']);
  });

  it('Phase có planWorkdays = 0 bị bỏ qua và ghi lý do, KHÔNG sinh Infinity', () => {
    // Chia cho 0 → Infinity → Math.min(Infinity, OE) = OE. Kết quả TRÔNG hợp lý
    // nên lỗi hoàn toàn im lặng.
    const weekendOnly = [phase('DESIGN', 40, '2026-03-14', '2026-03-15', 0)];
    const r = computePlannedRemaining(weekendOnly, TOTAL, '2026-03-20', cal());
    expect(r.seconds).toBe(TOTAL);
    expect(Number.isFinite(r.seconds)).toBe(true);
    expect(r.skippedPhases[0]!.reason).toContain('falls entirely on days off');
  });

  it('planWorkdays null cũng bị bỏ qua', () => {
    const r = computePlannedRemaining(
      [phase('DESIGN', 40, '2026-03-02', '2026-03-06', null)],
      TOTAL,
      '2026-03-10',
      cal(),
    );
    expect(r.seconds).toBe(TOTAL);
  });

  it('mọi Phase đều thiếu ngày thì kết quả bằng đúng TotalScope cho mọi ngày', () => {
    const noPlan = [phase('A', 40, null, null, null), phase('B', 160, null, null, null)];
    for (const d of ['2026-03-02', '2026-03-15', '2026-04-30']) {
      expect(computePlannedRemaining(noPlan, TOTAL, d, cal()).seconds).toBe(TOTAL);
    }
  });
});

describe('biên', () => {
  it('kết quả không bao giờ âm', () => {
    // Tổng ước lượng các Phase (200h) lớn hơn TotalScope khai báo (100h)
    const r = computePlannedRemaining(EPIC_200H, 100 * H, '2026-03-27', cal());
    expect(r.seconds).toBe(0);
  });

  it('ngày lễ và cuối tuần không làm cháy thêm giờ nào', () => {
    const only = [phase('DESIGN', 40, '2026-03-02', '2026-03-06', 5)];
    const plain = cal();
    // 07/03 và 08/03 là T7, CN — cháy phải bằng ngày 06/03
    expect(computePlannedRemaining(only, 40 * H, '2026-03-06', plain).seconds).toBe(
      computePlannedRemaining(only, 40 * H, '2026-03-08', plain).seconds,
    );
  });

  it('ngày lễ giữa Phase làm đường Kế hoạch phẳng ra một ngày', () => {
    const withHoliday = cal({ holidays: new Set(['2026-03-04']) });
    const only = [phase('DESIGN', 40, '2026-03-02', '2026-03-06', 4)];
    // 03/03 và 04/03: 04/03 là lễ nên không cháy thêm
    const d3 = computePlannedRemaining(only, 40 * H, '2026-03-03', withHoliday).seconds;
    const d4 = computePlannedRemaining(only, 40 * H, '2026-03-04', withHoliday).seconds;
    expect(d4).toBe(d3);
  });

  it('Epic không có Phase nào thì kết quả bằng TotalScope', () => {
    expect(computePlannedRemaining([], TOTAL, '2026-03-10', cal()).seconds).toBe(TOTAL);
  });

  it('KHÔNG làm tròn trong engine — giá trị lẻ được giữ nguyên', () => {
    // 100h qua 7 ngày = 51428.571… giây mỗi ngày. Làm tròn sớm rồi cộng dồn
    // nhiều Phase sẽ tích lũy sai số và golden dataset lệch vài giây (C-2).
    // 02/03 (T2) → 10/03 (T3) là 7 ngày làm việc.
    const odd = [phase('X', 100, '2026-03-02', '2026-03-10', 7)];
    const r = computePlannedRemaining(odd, 100 * H, '2026-03-03', cal()).seconds;

    expect(Number.isInteger(r)).toBe(false);
    expect(r).toBeCloseTo(100 * H - ((100 * H) / 7) * 2, 6);
  });
});

describe('đường Kế hoạch TRÔI — hành vi mong muốn, không phải bug', () => {
  it('thêm Sub-task làm plan_end muộn hơn thì đường Kế hoạch của các ngày CŨ cũng đổi', () => {
    // Đây là quyết định đã chốt (PRD §1.4: "Không làm: Baseline").
    // Test này tồn tại để chặn người sau "sửa" thành đóng băng.
    const before = [phase('DEVELOPMENT', 120, '2026-03-09', '2026-03-27', 15)];
    const after = [phase('DEVELOPMENT', 150, '2026-03-09', '2026-04-03', 20)];

    const oldDay = '2026-03-10';
    const b = computePlannedRemaining(before, TOTAL, oldDay, cal()).seconds;
    const a = computePlannedRemaining(after, TOTAL, oldDay, cal()).seconds;

    expect(a).not.toBe(b);
  });

  it('hàm cho cùng kết quả khi gọi lại với cùng đầu vào', () => {
    const runs = Array.from({ length: 5 }, () => at('2026-03-10'));
    expect(new Set(runs).size).toBe(1);
  });
});

describe('ramp theo TỪNG Sub-task', () => {
  // Rollup với danh sách plannedItems tùy ý. Các trường mức Phase (planStart…)
  // KHÔNG còn ảnh hưởng phép tính — chỉ plannedItems và totalScope quyết định.
  const withItems = (
    items: { start: string; end: string; hours: number; workdays: number }[],
    phaseCode = 'DESIGN',
  ): PhaseRollup => ({
    phaseCode,
    planStart: null,
    planEnd: null,
    planWorkdays: null,
    actualStart: null,
    actualEnd: null,
    actualEndIsProvisional: false,
    totalOriginalS: items.reduce((s, i) => s + i.hours * H, 0),
    subtaskCount: items.length,
    missingDateCount: 0,
    plannedItems: items.map((i) => ({
      wbsStartDate: i.start,
      wbsEndDate: i.end,
      originalS: i.hours * H,
      planWorkdays: i.workdays,
    })),
    warnings: [],
  });

  it('hai Sub-task chồng lấn cộng dồn ramp của từng cái', () => {
    // A: 40h trên 02→06/03 (5 ngày) = 8h/ngày. B: 60h trên 02→04/03 (3 ngày) = 20h/ngày.
    // 03/03 đã trôi 2 ngày cho cả hai: A cháy 16h, B cháy 40h = 56h → còn 44h.
    const r = computePlannedRemaining(
      [
        withItems([
          { start: '2026-03-02', end: '2026-03-06', hours: 40, workdays: 5 },
          { start: '2026-03-02', end: '2026-03-04', hours: 60, workdays: 3 },
        ]),
      ],
      100 * H,
      '2026-03-03',
      cal(),
    );
    expect(r.seconds).toBe(44 * H);
  });

  it('Sub-task thiếu ngày thành SÀN — đường Kế hoạch không bao giờ chạm 0', () => {
    // Chỉ 40h có lịch (02→06/03); tổng scope 60h → 20h dateless là sàn cố định.
    const dated = [withItems([{ start: '2026-03-02', end: '2026-03-06', hours: 40, workdays: 5 }])];
    expect(computePlannedRemaining(dated, 60 * H, '2026-03-06', cal()).seconds).toBe(20 * H);
    expect(computePlannedRemaining(dated, 60 * H, '2026-04-30', cal()).seconds).toBe(20 * H);
  });

  it('item planWorkdays = 0 (cửa sổ rơi trọn vào ngày nghỉ) thành sàn, Phase bị bỏ qua', () => {
    const weekendItem = [
      withItems([{ start: '2026-03-14', end: '2026-03-15', hours: 40, workdays: 0 }]),
    ];
    const r = computePlannedRemaining(weekendItem, 40 * H, '2026-03-20', cal());
    expect(r.seconds).toBe(40 * H); // không cháy giờ nào
    expect(r.skippedPhases.map((s) => s.phaseCode)).toEqual(['DESIGN']);
  });

  it('Σ đốt của cả Epic bằng tổng từng Phase (bất biến còn giữ khi ramp per-Sub-task)', () => {
    const phases = [
      withItems([{ start: '2026-03-02', end: '2026-03-06', hours: 40, workdays: 5 }], 'DESIGN'),
      withItems([{ start: '2026-03-02', end: '2026-03-04', hours: 60, workdays: 3 }], 'DEV'),
    ];
    const epic = computePlannedRemaining(phases, 100 * H, '2026-03-03', cal()).seconds;
    const design = computePlannedRemaining([phases[0]!], 40 * H, '2026-03-03', cal()).seconds;
    const dev = computePlannedRemaining([phases[1]!], 60 * H, '2026-03-03', cal()).seconds;
    expect(epic).toBe(design + dev);
    expect(epic).toBe(44 * H);
  });
});
