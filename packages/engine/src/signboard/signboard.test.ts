import { describe, it, expect } from 'vitest';
import {
  SIGNBOARD_STATUS,
  SIGNBOARD_STATUS_RANK,
  type CellStatusInput,
  type CellTicket,
  type SignboardStatus,
  type StatusCategory,
} from '@app/shared';
import { resolveCellStatus, InvalidSignboardDateError } from './resolve-cell-status.js';
import { mergeCell, mergeCellStatus, minDate, maxDate } from './merge-cell.js';

/** Hôm nay là 10/03 — dùng cho toàn bộ bảng ví dụ PRD §6.3. */
const TODAY = '2026-03-10';

const cell = (
  statusCategory: StatusCategory,
  planStart: string | null,
  planEnd: string | null,
  actualStart: string | null,
): CellStatusInput => ({ statusCategory, planStart, planEnd, actualStart });

describe('sáu ca ví dụ PRD §6.3 — hôm nay 10/03', () => {
  const CASES: Array<[number, CellStatusInput, SignboardStatus, string]> = [
    [1, cell('done', '2026-03-02', '2026-03-06', '2026-03-02'), 'COMPLETED', 'dù kết thúc trễ 3 ngày'],
    [2, cell('indeterminate', null, null, '2026-03-05'), 'NO_PLAN', 'thiếu mốc kế hoạch'],
    [3, cell('new', '2026-03-12', '2026-03-15', null), 'NYS', 'chưa tới ngày bắt đầu'],
    [4, cell('new', '2026-03-05', '2026-03-08', null), 'DELAY_START', 'quá ngày bắt đầu mà chưa động'],
    [5, cell('indeterminate', '2026-03-05', '2026-03-08', '2026-03-06'), 'DELAY_END', 'Delay End thắng'],
    [6, cell('indeterminate', '2026-03-09', '2026-03-15', '2026-03-10'), 'DELAY_START', 'bắt đầu trễ, còn hạn'],
  ];

  it.each(CASES)('ca %i cho ra %s — %s', (_n, input, expected) => {
    expect(resolveCellStatus(input, TODAY)).toBe(expected);
  });
});

describe('thứ tự ưu tiên ở bước 4', () => {
  it('task vừa trễ bắt đầu vừa quá hạn kết thúc thì ra Delay End, KHÔNG ra Delay Start', () => {
    // Đảo thứ tự sẽ giấu mất việc task đang quá hạn: PM thấy vàng thay vì đỏ
    const r = resolveCellStatus(
      cell('indeterminate', '2026-03-01', '2026-03-05', '2026-03-03'),
      TODAY,
    );
    expect(r).toBe('DELAY_END');
  });

  it('task bắt đầu trễ nhưng còn trong hạn vẫn ra Delay Start, KHÔNG được tha thành OnSchedule', () => {
    const r = resolveCellStatus(
      cell('indeterminate', '2026-03-05', '2026-03-20', '2026-03-08'),
      TODAY,
    );
    expect(r).toBe('DELAY_START');
  });

  it('bắt đầu đúng hạn và còn trong hạn thì ra OnSchedule', () => {
    const r = resolveCellStatus(
      cell('indeterminate', '2026-03-05', '2026-03-20', '2026-03-05'),
      TODAY,
    );
    expect(r).toBe('ON_SCHEDULE');
  });

  it('bắt đầu SỚM hơn kế hoạch vẫn là OnSchedule', () => {
    const r = resolveCellStatus(
      cell('indeterminate', '2026-03-05', '2026-03-20', '2026-03-02'),
      TODAY,
    );
    expect(r).toBe('ON_SCHEDULE');
  });

  it('hôm nay ĐÚNG BẰNG plan_end thì chưa quá hạn', () => {
    const r = resolveCellStatus(
      cell('indeterminate', '2026-03-05', TODAY, '2026-03-05'),
      TODAY,
    );
    expect(r).toBe('ON_SCHEDULE');
  });

  it('hôm nay ĐÚNG BẰNG plan_start mà chưa bắt đầu thì vẫn là NYS', () => {
    expect(resolveCellStatus(cell('new', TODAY, '2026-03-15', null), TODAY)).toBe('NYS');
  });
});

describe('Done thắng tất cả', () => {
  it('task Done kết thúc trễ 3 ngày vẫn ra Completed', () => {
    expect(
      resolveCellStatus(cell('done', '2026-03-02', '2026-03-06', '2026-03-02'), TODAY),
    ).toBe('COMPLETED');
  });

  it('task Done mà thiếu ngày kế hoạch vẫn ra Completed', () => {
    // Bước 1 xét TRƯỚC bước 2
    expect(resolveCellStatus(cell('done', null, null, '2026-03-02'), TODAY)).toBe('COMPLETED');
  });

  it('task Done mà chưa từng có actual_start vẫn ra Completed', () => {
    expect(resolveCellStatus(cell('done', '2026-03-02', '2026-03-06', null), TODAY)).toBe(
      'COMPLETED',
    );
  });
});

describe('NoPlan — trạng thái thứ 6', () => {
  it('thiếu plan_start thì ra NoPlan, KHÔNG ra NYS', () => {
    expect(resolveCellStatus(cell('new', null, '2026-03-15', null), TODAY)).toBe('NO_PLAN');
  });

  it('thiếu plan_end thì ra NoPlan, KHÔNG ra OnSchedule', () => {
    expect(
      resolveCellStatus(cell('indeterminate', '2026-03-05', null, '2026-03-05'), TODAY),
    ).toBe('NO_PLAN');
  });

  it('NoPlan áp dụng cả khi task đang làm dở', () => {
    expect(resolveCellStatus(cell('indeterminate', null, null, '2026-03-05'), TODAY)).toBe(
      'NO_PLAN',
    );
  });

  it('NoPlan áp dụng cả khi task chưa động vào', () => {
    expect(resolveCellStatus(cell('new', null, null, null), TODAY)).toBe('NO_PLAN');
  });
});

describe('không đọc đồng hồ', () => {
  it('cùng dữ liệu, hai asOfDate khác nhau cho hai kết quả khác nhau', () => {
    const input = cell('new', '2026-03-10', '2026-03-15', null);
    expect(resolveCellStatus(input, '2026-03-09')).toBe('NYS');
    expect(resolveCellStatus(input, '2026-03-11')).toBe('DELAY_START');
  });

  it('gọi lại nhiều lần với cùng asOfDate luôn cho cùng kết quả', () => {
    const input = cell('indeterminate', '2026-03-05', '2026-03-08', '2026-03-06');
    const runs = Array.from({ length: 5 }, () => resolveCellStatus(input, TODAY));
    expect(new Set(runs).size).toBe(1);
  });
});

describe('kiểm tra định dạng ngày', () => {
  it('ngày sai định dạng bị từ chối thay vì so sánh chuỗi sai lặng lẽ', () => {
    // '2026-3-9' < '2026-03-10' cho ra false vì so từng ký tự
    expect(() => resolveCellStatus(cell('new', '2026-3-9', '2026-03-15', null), TODAY)).toThrow(
      InvalidSignboardDateError,
    );
  });

  it('asOfDate sai định dạng cũng bị từ chối', () => {
    expect(() => resolveCellStatus(cell('new', '2026-03-09', '2026-03-15', null), '10/03/2026')).toThrow(
      InvalidSignboardDateError,
    );
  });
});

// ---------------------------------------------------------------------------

const ticket = (
  issueKey: string,
  status: SignboardStatus,
  over: Partial<CellTicket> = {},
): CellTicket => ({
  issueKey,
  planStart: null,
  planEnd: null,
  actualStart: null,
  actualEnd: null,
  status,
  ...over,
});

describe('gộp ô', () => {
  it('ô có Completed và NYS thì ra NYS, KHÔNG ra Completed', () => {
    // Ô đó CHƯA XONG — hiện màu xanh là nói dối
    const c = mergeCell([ticket('A', 'COMPLETED'), ticket('B', 'NYS')]);
    expect(c.present && c.status).toBe('NYS');
  });

  it('ô có Completed và Delay End thì ra Delay End', () => {
    const c = mergeCell([ticket('A', 'COMPLETED'), ticket('B', 'DELAY_END')]);
    expect(c.present && c.status).toBe('DELAY_END');
  });

  it('ô toàn Completed thì ra Completed', () => {
    const c = mergeCell([ticket('A', 'COMPLETED'), ticket('B', 'COMPLETED')]);
    expect(c.present && c.status).toBe('COMPLETED');
  });

  it('Delay End thắng Delay Start khi gộp', () => {
    expect(mergeCellStatus(['DELAY_START', 'DELAY_END'])).toBe('DELAY_END');
  });

  it('NoPlan xấu hơn OnSchedule nhưng tốt hơn Delay Start', () => {
    expect(mergeCellStatus(['ON_SCHEDULE', 'NO_PLAN'])).toBe('NO_PLAN');
    expect(mergeCellStatus(['NO_PLAN', 'DELAY_START'])).toBe('DELAY_START');
  });

  it('thứ hạng phủ đủ 6 trạng thái và không có hai trạng thái cùng hạng', () => {
    const ranks = SIGNBOARD_STATUS.map((s) => SIGNBOARD_STATUS_RANK[s]);
    expect(ranks).toHaveLength(6);
    expect(new Set(ranks).size).toBe(6);
  });

  it('ô gộp lấy MIN của plan_start và MAX của plan_end', () => {
    const c = mergeCell([
      ticket('A', 'ON_SCHEDULE', { planStart: '2026-03-05', planEnd: '2026-03-08' }),
      ticket('B', 'ON_SCHEDULE', { planStart: '2026-03-02', planEnd: '2026-03-12' }),
      ticket('C', 'ON_SCHEDULE', { planStart: '2026-03-09', planEnd: '2026-03-10' }),
    ]);
    expect(c.present && c.planStart).toBe('2026-03-02');
    expect(c.present && c.planEnd).toBe('2026-03-12');
  });

  it('ô gộp bỏ qua ticket thiếu ngày khi tính MIN và MAX', () => {
    const c = mergeCell([
      ticket('A', 'NO_PLAN'),
      ticket('B', 'ON_SCHEDULE', { planStart: '2026-03-05', planEnd: '2026-03-08' }),
    ]);
    expect(c.present && c.planStart).toBe('2026-03-05');
    expect(c.present && c.planEnd).toBe('2026-03-08');
  });

  it('mọi ticket đều thiếu ngày thì plan_start và plan_end là null, KHÔNG phải Infinity', () => {
    const c = mergeCell([ticket('A', 'NO_PLAN'), ticket('B', 'NO_PLAN')]);
    expect(c.present && c.planStart).toBeNull();
    expect(c.present && c.planEnd).toBeNull();
  });

  it('ô gộp giữ đủ danh sách từng ticket kèm trạng thái riêng', () => {
    const c = mergeCell([ticket('PAY-121', 'COMPLETED'), ticket('PAY-122', 'DELAY_END')]);
    expect(c.present && c.ticketCount).toBe(2);
    expect(c.present && c.tickets.map((t) => [t.issueKey, t.status])).toEqual([
      ['PAY-121', 'COMPLETED'],
      ['PAY-122', 'DELAY_END'],
    ]);
  });

  it('ô có đúng 1 ticket thì trạng thái ô bằng trạng thái ticket đó', () => {
    const c = mergeCell([ticket('PAY-121', 'DELAY_START')]);
    expect(c.present && c.status).toBe('DELAY_START');
    expect(c.present && c.ticketCount).toBe(1);
  });
});

describe('ô trống khác NoPlan', () => {
  it('ô không có Sub-task nào thì present = false và KHÔNG có trường status', () => {
    const c = mergeCell([]);
    expect(c.present).toBe(false);
    expect('status' in c).toBe(false);
  });

  it('ô có ticket thiếu ngày là NoPlan, KHÁC hẳn ô trống', () => {
    const empty = mergeCell([]);
    const noPlan = mergeCell([ticket('A', 'NO_PLAN')]);
    expect(empty.present).toBe(false);
    expect(noPlan.present).toBe(true);
    expect(noPlan.present && noPlan.status).toBe('NO_PLAN');
  });
});

describe('so sánh ngày', () => {
  it('minDate và maxDate trên mảng toàn null trả null', () => {
    expect(minDate([null, null])).toBeNull();
    expect(maxDate([null, null])).toBeNull();
  });

  it('minDate và maxDate trên mảng rỗng trả null', () => {
    expect(minDate([])).toBeNull();
    expect(maxDate([])).toBeNull();
  });
});
