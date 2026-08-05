import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StatusCategory } from '@app/shared';
import { runBurndown, type BurndownResult } from '../helpers/run-engine.js';
import type { BurndownFixture, FixtureSubtask } from '../helpers/fixture-types.js';

/**
 * Sáu tính chất chung của đường Burndown — PRD §8.3.
 *
 * Khác golden dataset ở chỗ: golden kiểm **một** kịch bản đã tính tay, còn ở đây
 * fast-check dựng hàng trăm kịch bản ngẫu nhiên và kiểm những điều **luôn đúng**.
 * Hai loại bổ sung cho nhau — golden bắt lỗi số học, property bắt lỗi ở những ca
 * mà không ai nghĩ tới lúc viết test.
 */

/**
 * 5 ngày làm việc liên tiếp, không lễ. Cố định để test lặp lại được.
 *
 * VÌ SAO CHỈ 5 NGÀY, TỐI ĐA 4 SUB-TASK VÀ 60 LƯỢT: quy ước C-12 buộc
 * `pnpm test:engine` chạy dưới 10 giây, và ngưỡng đó tồn tại để lập trình viên
 * thật sự chạy test thường xuyên. Bản đầu tiên dùng 10 ngày × 6 Sub-task × 150
 * lượt và một mình nó đã ngốn 21 giây. Đã thu nhỏ kịch bản thay vì nới ngưỡng.
 *
 * Ghi rõ ra đây vì đây là một ĐÁNH ĐỔI có chủ ý: không gian tìm kiếm hẹp hơn thì
 * xác suất bắt được ca hiếm cũng thấp hơn. Cần quét sâu hơn thì nâng `numRuns`
 * và chạy riêng, đừng nới ngưỡng 10 giây của cả bộ.
 */
const DAYS = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'] as const;

const FIRST_DAY = DAYS[0];
const LAST_DAY = DAYS[DAYS.length - 1] as string;
const PHASES = ['ALPHA', 'BETA', 'GAMMA'] as const;
const STATUS_ID: Record<StatusCategory, string> = { new: '1', indeterminate: '3', done: '6' };

const dayArb = fc.constantFrom(...DAYS);

interface SubtaskSpec {
  readonly phaseCode: string;
  readonly hours: number;
  readonly wbsStart: string;
  readonly wbsEnd: string;
  readonly startDay: string | null;
  readonly doneDay: string | null;
  readonly worklogs: readonly { day: string; hours: number }[];
}

/**
 * Sub-task "hiền": tạo từ trước ngày đầu tiên, không bị gỡ, KHÔNG có sự kiện
 * sửa tay ước lượng còn lại, và trạng thái chỉ đi tới chứ không lùi lại.
 *
 * Ba ràng buộc đó không phải để cho dễ — chúng chính là **điều kiện** của tính
 * chất "đơn điệu giảm" bên dưới.
 */
const tameSubtaskArb: fc.Arbitrary<SubtaskSpec> = fc
  .record({
    phaseCode: fc.constantFrom(...PHASES),
    hours: fc.integer({ min: 1, max: 8 }),
    wbsPair: fc.tuple(dayArb, dayArb).map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [string, string]),
    startIdx: fc.option(fc.integer({ min: 0, max: DAYS.length - 1 }), { nil: null }),
    doneOffset: fc.option(fc.integer({ min: 0, max: DAYS.length - 1 }), { nil: null }),
    worklogs: fc.array(fc.record({ day: dayArb, hours: fc.integer({ min: 1, max: 4 }) }), { maxLength: 4 }),
  })
  .map((r) => {
    const startDay = r.startIdx === null ? null : (DAYS[r.startIdx] as string);
    // Xong thì phải xong SAU khi bắt đầu, và chỉ khi đã bắt đầu.
    const doneIdx =
      r.startIdx === null || r.doneOffset === null
        ? null
        : Math.min(DAYS.length - 1, r.startIdx + r.doneOffset);
    return {
      phaseCode: r.phaseCode,
      hours: r.hours,
      wbsStart: r.wbsPair[0],
      wbsEnd: r.wbsPair[1],
      startDay,
      doneDay: doneIdx === null ? null : (DAYS[doneIdx] as string),
      worklogs: r.worklogs,
    };
  });

function toFixtureSubtask(spec: SubtaskSpec, index: number): FixtureSubtask {
  const changelog: { field: string; from: string | null; to: string | null; at: string }[] = [];
  if (spec.startDay !== null) {
    changelog.push({
      field: 'status',
      from: STATUS_ID.new,
      to: STATUS_ID.indeterminate,
      at: `${spec.startDay}T09:00:00+07:00`,
    });
  }
  if (spec.doneDay !== null) {
    changelog.push({
      field: 'status',
      from: STATUS_ID.indeterminate,
      to: STATUS_ID.done,
      at: `${spec.doneDay}T18:00:00+07:00`,
    });
  }

  return {
    key: `X-${index}`,
    phaseCode: spec.phaseCode,
    originalEstimateSeconds: spec.hours * 3600,
    // Tạo TRƯỚC ngày đầu tiên nên phạm vi không đổi trong suốt kỳ.
    createdAt: '2026-02-27T01:00:00+07:00',
    wbsStartDate: spec.wbsStart,
    wbsEndDate: spec.wbsEnd,
    changelog,
    worklogs: spec.worklogs.map((w, i) => ({
      id: `X-${index}-w${i}`,
      seconds: w.hours * 3600,
      started: `${w.day}T10:00:00+07:00`,
    })),
  };
}

function buildFixture(specs: readonly SubtaskSpec[]): BurndownFixture {
  return {
    id: 'PROP',
    kind: 'burndown',
    title: 'Sinh tự động cho test theo tính chất',
    asOfDate: LAST_DAY,
    epicKey: 'PROP-1',
    calendar: { timezone: 'Asia/Ho_Chi_Minh', holidays: [] },
    statusIds: { '1': 'new', '3': 'indeterminate', '6': 'done' },
    sourceReadAt: `${LAST_DAY}T19:00:00+07:00`,
    snapshotRange: { from: FIRST_DAY, to: LAST_DAY },
    subtasks: specs.map(toFixtureSubtask),
  };
}

const scenarioArb = fc.array(tameSubtaskArb, { minLength: 1, maxLength: 4 }).map(buildFixture);

function run(fixture: BurndownFixture): BurndownResult {
  return runBurndown(fixture);
}

// ---------------------------------------------------------------------------

describe('sáu tính chất chung của đường Burndown', () => {
  it('1 — không con số nào âm', () => {
    fc.assert(
      fc.property(scenarioArb, (fixture) => {
        for (const s of run(fixture).snapshots) {
          expect(s.plannedRemainingS).toBeGreaterThanOrEqual(0);
          expect(s.actualRemainingS).toBeGreaterThanOrEqual(0);
          expect(s.totalScopeS).toBeGreaterThanOrEqual(0);
          expect(s.totalSpentS).toBeGreaterThanOrEqual(0);
          expect(s.scopeAddedS).toBeGreaterThanOrEqual(0);
          expect(s.scopeRemovedS).toBeGreaterThanOrEqual(0);
          for (const p of s.perPhase) {
            expect(p.remainingS).toBeGreaterThanOrEqual(0);
            expect(p.spentS).toBeGreaterThanOrEqual(0);
            expect(p.plannedRemainingS === null || p.plannedRemainingS >= 0).toBe(true);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it('2 — đường Thực tế đơn điệu giảm khi không phát sinh, không sửa tay và không mở lại', () => {
    // Card ghi hai điều kiện: không phát sinh Sub-task và không sửa `timeestimate`.
    // Còn THIẾU điều kiện thứ ba: **không mở lại**. Một Sub-task Done rồi bị mở
    // lại sẽ đẩy khối lượng còn lại vọt lên (chính là ca GD-06), và đó là hành vi
    // ĐÚNG. Bộ sinh ở đây cố ý chỉ tạo trạng thái đi tới, không đi lui.
    fc.assert(
      fc.property(scenarioArb, (fixture) => {
        const snaps = run(fixture).snapshots;
        for (let i = 1; i < snaps.length; i++) {
          expect(snaps[i]!.actualRemainingS).toBeLessThanOrEqual(snaps[i - 1]!.actualRemainingS);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('3 — mọi Sub-task đều Done thì khối lượng còn lại về đúng 0', () => {
    // Ép bắt đầu ở ngày đầu và xong ở áp chót. Phải ép CẢ HAI: giữ lại
    // `startDay` ngẫu nhiên có thể cho ra mốc bắt đầu MUỘN HƠN mốc xong, và khi
    // đó sự kiện cuối cùng lại là "đang làm" — Sub-task hoá ra chưa xong.
    const allDoneArb = fc
      .array(tameSubtaskArb, { minLength: 1, maxLength: 4 })
      .map((specs) =>
        buildFixture(
          specs.map((s) => ({
            ...s,
            startDay: DAYS[0] as string,
            doneDay: DAYS[DAYS.length - 2] as string,
          })),
        ),
      );

    fc.assert(
      fc.property(allDoneArb, (fixture) => {
        const snaps = run(fixture).snapshots;
        expect(snaps[snaps.length - 1]!.actualRemainingS).toBe(0);
      }),
      { numRuns: 50 },
    );
  });

  it('4 — tổng các Phase bằng đúng giá trị của Epic, sai số 0', () => {
    fc.assert(
      fc.property(scenarioArb, (fixture) => {
        for (const s of run(fixture).snapshots) {
          const sum = (pick: (p: (typeof s.perPhase)[number]) => number) =>
            s.perPhase.reduce((acc, p) => acc + pick(p), 0);

          expect(sum((p) => p.remainingS)).toBe(s.actualRemainingS);
          expect(sum((p) => p.spentS)).toBe(s.totalSpentS);
          expect(sum((p) => p.originalS)).toBe(s.totalScopeS);
          expect(sum((p) => p.countTodo)).toBe(s.countTodo);
          expect(sum((p) => p.countInProgress)).toBe(s.countInProgress);
          expect(sum((p) => p.countDone)).toBe(s.countDone);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('5 — chạy lại cho kết quả giống hệt nhau', () => {
    fc.assert(
      fc.property(scenarioArb, (fixture) => {
        expect(run(fixture)).toEqual(run(fixture));
      }),
      { numRuns: 50 },
    );
  });

  it('6 — khối lượng còn lại không vượt quá phạm vi cộng phần vừa phát sinh', () => {
    // Trần trên này chỉ đúng khi KHÔNG có ai sửa tay ước lượng còn lại: quy tắc 2
    // cho phép người dùng khai "còn 100 giờ" trên một Sub-task ước lượng 8 giờ,
    // và khi đó khối lượng còn lại vượt phạm vi một cách hoàn toàn hợp lệ.
    fc.assert(
      fc.property(scenarioArb, (fixture) => {
        for (const s of run(fixture).snapshots) {
          expect(s.actualRemainingS).toBeLessThanOrEqual(s.totalScopeS + s.scopeAddedS);
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('tính chất phụ — những điều dễ tưởng là đúng', () => {
  it('số Sub-task đếm theo trạng thái luôn cộng lại bằng số đang hoạt động', () => {
    fc.assert(
      fc.property(scenarioArb, (fixture) => {
        const total = fixture.subtasks.length;
        for (const s of run(fixture).snapshots) {
          expect(s.countTodo + s.countInProgress + s.countDone).toBe(total);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('mọi số đều hữu hạn — không có NaN lọt qua phép cộng dồn', () => {
    // `undefined + 5` cho `NaN`, và `NaN` lan ra toàn bộ tổng mà không có lỗi nào.
    fc.assert(
      fc.property(scenarioArb, (fixture) => {
        for (const s of run(fixture).snapshots) {
          for (const [key, value] of Object.entries(s)) {
            if (typeof value === 'number') expect(Number.isFinite(value), key).toBe(true);
          }
          for (const p of s.perPhase) {
            for (const [key, value] of Object.entries(p)) {
              if (typeof value === 'number') expect(Number.isFinite(value), key).toBe(true);
            }
          }
        }
      }),
      { numRuns: 50 },
    );
  });

  it('số ngày snapshot luôn bằng số ngày làm việc trong khoảng', () => {
    fc.assert(
      fc.property(scenarioArb, (fixture) => {
        const r = run(fixture);
        expect(r.snapshots.length).toBe(r.workdays.length);
        expect(r.snapshots.map((s) => s.snapshotDate)).toEqual([...r.workdays]);
      }),
      { numRuns: 60 },
    );
  });

  it('ngày đầu tiên không bao giờ có chênh lệch phạm vi', () => {
    // Coi toàn bộ phạm vi ban đầu là "vừa phát sinh" sẽ tạo một cột mốc giả to
    // đùng ở ngày đầu biểu đồ.
    fc.assert(
      fc.property(scenarioArb, (fixture) => {
        const first = run(fixture).snapshots[0]!;
        expect(first.scopeAddedS).toBe(0);
        expect(first.scopeRemovedS).toBe(0);
      }),
      { numRuns: 60 },
    );
  });
});
