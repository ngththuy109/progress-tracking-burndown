import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SIGNBOARD_STATUS,
  SIGNBOARD_STATUS_RANK,
  type CellTicket,
  type DateOnly,
  type SignboardCell,
  type SignboardStatus,
  type StatusCategory,
} from '@app/shared';
import { mergeCell, mergeCellStatus, resolveCellStatus } from '../../src/index.js';

/**
 * Bảy tính chất của bảng Signboard — PRD §8.3.
 *
 * Trạng thái ô phụ thuộc **hôm nay là ngày nào**, nên mọi tính chất ở đây đều
 * phải nhận `asOfDate` qua tham số. Không có test nào được đọc đồng hồ.
 */

const DAYS: readonly DateOnly[] = [
  '2026-03-02', '2026-03-04', '2026-03-06', '2026-03-09', '2026-03-11', '2026-03-13',
];

const dateArb = fc.constantFrom(...DAYS);
const maybeDateArb = fc.option(dateArb, { nil: null });
const categoryArb = fc.constantFrom<StatusCategory>('new', 'indeterminate', 'done');

interface TicketSpec {
  readonly statusCategory: StatusCategory;
  readonly planStart: DateOnly | null;
  readonly planEnd: DateOnly | null;
  readonly actualStart: DateOnly | null;
  readonly actualEnd: DateOnly | null;
}

const ticketArb: fc.Arbitrary<TicketSpec> = fc
  .record({
    statusCategory: categoryArb,
    // Cả hai mốc kế hoạch cùng có hoặc cùng không — chỉ có một mốc cũng là
    // "không so sánh được", và ca đó đã nằm trong cây quyết định.
    plan: fc.option(fc.tuple(dateArb, dateArb).map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [DateOnly, DateOnly]), {
      nil: null,
    }),
    actualStart: maybeDateArb,
    actualEnd: maybeDateArb,
  })
  .map((r) => ({
    statusCategory: r.statusCategory,
    planStart: r.plan === null ? null : r.plan[0],
    planEnd: r.plan === null ? null : r.plan[1],
    actualStart: r.actualStart,
    actualEnd: r.actualEnd,
  }));

function toCellTicket(spec: TicketSpec, index: number, asOfDate: DateOnly): CellTicket {
  return {
    issueKey: `K-${index}`,
    planStart: spec.planStart,
    planEnd: spec.planEnd,
    actualStart: spec.actualStart,
    actualEnd: spec.actualEnd,
    status: resolveCellStatus(
      {
        statusCategory: spec.statusCategory,
        planStart: spec.planStart,
        planEnd: spec.planEnd,
        actualStart: spec.actualStart,
      },
      asOfDate,
    ),
  };
}

const cellArb = fc
  .tuple(fc.array(ticketArb, { maxLength: 5 }), dateArb)
  .map(([specs, asOfDate]) => ({
    asOfDate,
    tickets: specs.map((s, i) => toCellTicket(s, i, asOfDate)),
  }));

describe('bảy tính chất của bảng Signboard', () => {
  it('1 — ô gộp mang đúng thứ hạng XẤU NHẤT trong các ticket', () => {
    fc.assert(
      fc.property(cellArb, ({ tickets }) => {
        const cell = mergeCell(tickets);
        if (!cell.present) return;
        const worstRank = Math.max(...tickets.map((t) => SIGNBOARD_STATUS_RANK[t.status]));
        expect(SIGNBOARD_STATUS_RANK[cell.status]).toBe(worstRank);
      }),
      { numRuns: 300 },
    );
  });

  it('2 — ô trống KHÔNG mang trạng thái nào', () => {
    // `present: false` là ô trống (Function vốn không có khâu đó); `NO_PLAN` là
    // CÓ ticket nhưng thiếu ngày. Gộp hai khái niệm sẽ làm thanh tóm tắt đếm sai.
    const cell: SignboardCell = mergeCell([]);
    expect(cell.present).toBe(false);
    expect(Object.hasOwn(cell, 'status')).toBe(false);
  });

  it('3 — gộp cả hàng cho ra trạng thái không tốt hơn bất kỳ ô nào trong hàng', () => {
    // Đây là điều kiện để cột "Tổng" của mỗi Function nói đúng sự thật: nó không
    // được phép trông đẹp hơn ô xấu nhất trong hàng.
    fc.assert(
      fc.property(fc.array(cellArb, { minLength: 1, maxLength: 4 }), (cells) => {
        const present = cells.map((c) => mergeCell(c.tickets)).filter((c) => c.present);
        if (present.length === 0) return;
        const rowStatus = mergeCellStatus(present.map((c) => (c as { status: SignboardStatus }).status));
        expect(rowStatus).not.toBeNull();
        for (const c of present) {
          expect(SIGNBOARD_STATUS_RANK[rowStatus as SignboardStatus]).toBeGreaterThanOrEqual(
            SIGNBOARD_STATUS_RANK[(c as { status: SignboardStatus }).status],
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it('4 — đã Done thì LUÔN là Completed, bất kể ngày tháng thế nào', () => {
    fc.assert(
      fc.property(ticketArb, dateArb, (spec, asOfDate) => {
        const status = resolveCellStatus(
          { ...spec, statusCategory: 'done' },
          asOfDate,
        );
        expect(status).toBe('COMPLETED');
      }),
      { numRuns: 300 },
    );
  });

  it('5 — chưa Done mà thiếu ngày kế hoạch thì LUÔN là NoPlan', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<StatusCategory>('new', 'indeterminate'),
        maybeDateArb,
        maybeDateArb,
        dateArb,
        fc.boolean(),
        (category, actualStart, planOther, asOfDate, missingStart) => {
          const status = resolveCellStatus(
            {
              statusCategory: category,
              // Thiếu MỘT trong hai mốc đã là không so sánh được.
              planStart: missingStart ? null : planOther,
              planEnd: missingStart ? planOther : null,
              actualStart,
            },
            asOfDate,
          );
          expect(status).toBe('NO_PLAN');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('6 — mọi ô đều rơi vào đúng một trong sáu trạng thái, hoặc là ô trống', () => {
    fc.assert(
      fc.property(fc.array(cellArb, { minLength: 1, maxLength: 6 }), (cells) => {
        const merged = cells.map((c) => mergeCell(c.tickets));
        const counted = new Map<SignboardStatus, number>();
        let empty = 0;

        for (const cell of merged) {
          if (!cell.present) {
            empty += 1;
            continue;
          }
          expect(SIGNBOARD_STATUS).toContain(cell.status);
          counted.set(cell.status, (counted.get(cell.status) ?? 0) + 1);
        }

        const totalCounted = [...counted.values()].reduce((a, b) => a + b, 0);
        expect(totalCounted + empty).toBe(merged.length);
      }),
      { numRuns: 200 },
    );
  });

  it('7 — đổi "hôm nay" chỉ đổi trạng thái, KHÔNG đụng tới ngày kế hoạch và ngày thực tế', () => {
    fc.assert(
      fc.property(fc.array(ticketArb, { minLength: 1, maxLength: 4 }), dateArb, dateArb, (specs, d1, d2) => {
        const a = mergeCell(specs.map((s, i) => toCellTicket(s, i, d1)));
        const b = mergeCell(specs.map((s, i) => toCellTicket(s, i, d2)));
        if (!a.present || !b.present) return;

        expect(b.planStart).toBe(a.planStart);
        expect(b.planEnd).toBe(a.planEnd);
        expect(b.actualStart).toBe(a.actualStart);
        expect(b.actualEnd).toBe(a.actualEnd);
        expect(b.ticketCount).toBe(a.ticketCount);
      }),
      { numRuns: 300 },
    );
  });
});

describe('tính chất phụ của cây quyết định', () => {
  it('quá ngày kết thúc mà chưa xong thì LUÔN là DelayEnd, kể cả khi cũng bắt đầu trễ', () => {
    // Đảo thứ tự hai bước xét sẽ cho ra DelayStart — PM thấy màu vàng thay vì
    // màu đỏ và không ưu tiên xử lý. Lỗi này hoàn toàn im lặng.
    fc.assert(
      fc.property(
        fc.constantFrom<StatusCategory>('new', 'indeterminate'),
        fc.constantFrom('2026-03-02' as DateOnly),
        fc.constantFrom('2026-03-04' as DateOnly),
        fc.constantFrom('2026-03-06' as DateOnly, '2026-03-09' as DateOnly),
        (category, planStart, planEnd, asOfDate) => {
          const status = resolveCellStatus(
            { statusCategory: category, planStart, planEnd, actualStart: '2026-03-04' },
            asOfDate,
          );
          expect(status).toBe('DELAY_END');
        },
      ),
      { numRuns: 60 },
    );
  });

  it('gộp một ticket duy nhất trả về đúng trạng thái của chính nó', () => {
    fc.assert(
      fc.property(ticketArb, dateArb, (spec, asOfDate) => {
        const ticket = toCellTicket(spec, 0, asOfDate);
        const cell = mergeCell([ticket]);
        expect(cell.present).toBe(true);
        expect((cell as { status: SignboardStatus }).status).toBe(ticket.status);
      }),
      { numRuns: 200 },
    );
  });

  it('thứ tự ticket không ảnh hưởng tới trạng thái ô', () => {
    fc.assert(
      fc.property(fc.array(ticketArb, { minLength: 2, maxLength: 5 }), dateArb, (specs, asOfDate) => {
        const tickets = specs.map((s, i) => toCellTicket(s, i, asOfDate));
        const forward = mergeCell(tickets);
        const backward = mergeCell([...tickets].reverse());
        if (!forward.present || !backward.present) return;
        expect(backward.status).toBe(forward.status);
        expect(backward.planStart).toBe(forward.planStart);
        expect(backward.planEnd).toBe(forward.planEnd);
      }),
      { numRuns: 200 },
    );
  });
});
