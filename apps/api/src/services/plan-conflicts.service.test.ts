import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKDAYS_MASK, type WorkCalendar } from '@app/shared';
import {
  computePlanConflicts,
  type PlanCheckSubtask,
  type SideCalendar,
} from './plan-conflicts.service.js';

/**
 * Test hàm thuần kiểm tra plan-ngày nghỉ — T-37.
 *
 * Lịch dùng trong test: tuần làm việc T2–T6. 2026-03-09 là thứ Hai (mốc đã
 * dùng ở test lịch của engine), nên 2026-03-07 là thứ Bảy, 2026-03-08 là Chủ
 * nhật. Ngày lễ VN: 17/02 (Tết). Ngày lễ JP: 11/08 (山の日) — cố ý KHÁC nhau
 * để thấy rõ task mỗi phía bị soi bằng lịch của phía đó.
 */

function calendar(id: string, holidays: string[]): WorkCalendar {
  return {
    calendarId: id,
    timezone: id === 'JP_STANDARD' ? 'Asia/Tokyo' : 'Asia/Ho_Chi_Minh',
    workdaysMask: DEFAULT_WORKDAYS_MASK,
    hoursPerDay: 8,
    holidays: new Set(holidays),
    warnings: [],
  };
}

const VN: SideCalendar = {
  calendar: calendar('VN_STANDARD', ['2026-02-17']),
  holidayLabels: new Map([['2026-02-17', 'Tết']]),
};
const JP: SideCalendar = {
  calendar: calendar('JP_STANDARD', ['2026-08-11']),
  holidayLabels: new Map([['2026-08-11', '山の日']]),
};

const COLUMN_SIDES = new Map<string, 'VN' | 'JP'>([
  ['Create', 'VN'],
  ['JMReview', 'JP'],
]);

function subtask(over: Partial<PlanCheckSubtask>): PlanCheckSubtask {
  return {
    issueKey: 'PAY-101',
    summary: 'Sub-task',
    parentKey: 'PAY-10',
    phaseCode: 'DESIGN',
    taskType: 'Create',
    wbsStartDate: '2026-03-09',
    wbsEndDate: '2026-03-13',
    ...over,
  };
}

function run(subtasks: PlanCheckSubtask[]) {
  return computePlanConflicts({
    epicKey: 'PAY-1',
    subtasks,
    columnSides: COLUMN_SIDES,
    calendars: { VN, JP },
  });
}

describe('kiểm tra theo phía làm', () => {
  it('task phía VN có ngày bắt đầu rơi thứ Bảy → vi phạm WEEKEND ở mốc START', () => {
    const r = run([subtask({ wbsStartDate: '2026-03-07' })]);
    expect(r.summary.total).toBe(1);
    expect(r.conflicts[0]?.violations).toEqual([
      { field: 'START', date: '2026-03-07', reason: 'WEEKEND', holidayLabel: null },
    ]);
    expect(r.summary.bySide).toEqual({ VN: 1, JP: 0 });
  });

  it('task phía VN kết thúc đúng ngày Tết → HOLIDAY kèm tên ngày lễ', () => {
    const r = run([subtask({ wbsStartDate: '2026-02-16', wbsEndDate: '2026-02-17' })]);
    expect(r.conflicts[0]?.violations).toEqual([
      { field: 'END', date: '2026-02-17', reason: 'HOLIDAY', holidayLabel: 'Tết' },
    ]);
  });

  it('task review của khách (side JP) bị soi bằng lịch JP, không phải lịch VN', () => {
    // 11/08 là ngày lễ JP nhưng là ngày làm việc bình thường ở VN.
    const jpReview = subtask({ issueKey: 'PAY-102', taskType: 'JMReview', wbsStartDate: '2026-08-10', wbsEndDate: '2026-08-11' });
    const vnSameDates = subtask({ issueKey: 'PAY-103', taskType: 'Create', wbsStartDate: '2026-08-10', wbsEndDate: '2026-08-11' });

    const r = run([jpReview, vnSameDates]);
    expect(r.summary.total).toBe(1);
    expect(r.conflicts[0]?.issueKey).toBe('PAY-102');
    expect(r.conflicts[0]?.side).toBe('JP');
    expect(r.conflicts[0]?.violations[0]?.holidayLabel).toBe('山の日');
    expect(r.summary.bySide).toEqual({ VN: 0, JP: 1 });
  });

  it('khoảng plan VẮT QUA cuối tuần và ngày lễ không phải vi phạm', () => {
    // Thứ Hai → thứ Sáu tuần sau: chứa 2 ngày cuối tuần ở giữa nhưng hai mốc
    // đều là ngày làm việc — đường Kế hoạch đã tự loại phần giữa (T-16).
    const r = run([subtask({ wbsStartDate: '2026-02-16', wbsEndDate: '2026-02-20' })]);
    expect(r.summary.total).toBe(0);
  });

  it('cả hai mốc cùng rơi ngày nghỉ thì báo đủ hai vi phạm trên một Sub-task', () => {
    const r = run([subtask({ wbsStartDate: '2026-03-07', wbsEndDate: '2026-03-08' })]);
    expect(r.summary.total).toBe(1);
    expect(r.conflicts[0]?.violations.map((v) => v.field)).toEqual(['START', 'END']);
  });
});

describe('không rõ phía làm — C-10, không bỏ qua trong im lặng', () => {
  it('taskType null → kiểm theo lịch VN và gắn sideResolved=false', () => {
    const r = run([subtask({ taskType: null, wbsStartDate: '2026-03-08' })]);
    expect(r.conflicts[0]?.side).toBe('VN');
    expect(r.conflicts[0]?.sideResolved).toBe(false);
    expect(r.summary.sideUnknownCount).toBe(1);
  });

  it('taskType không khớp cột nào (cột đã bị xoá) cũng như vậy', () => {
    const r = run([subtask({ taskType: 'OldColumn', wbsStartDate: '2026-03-08' })]);
    expect(r.conflicts[0]?.sideResolved).toBe(false);
  });

  it('không rõ phía nhưng plan sạch thì không tính vào sideUnknownCount', () => {
    const r = run([subtask({ taskType: null })]);
    expect(r.summary.total).toBe(0);
    expect(r.summary.sideUnknownCount).toBe(0);
  });
});

describe('biên', () => {
  it('Sub-task không có ngày kế hoạch nào bị bỏ qua — đã thuộc báo cáo R-08', () => {
    const r = run([subtask({ wbsStartDate: null, wbsEndDate: null })]);
    expect(r.summary.total).toBe(0);
  });

  it('chỉ có một trong hai mốc vẫn kiểm được mốc đó', () => {
    const r = run([subtask({ wbsStartDate: null, wbsEndDate: '2026-02-17' })]);
    expect(r.conflicts[0]?.violations[0]?.field).toBe('END');
  });

  it('kết quả sắp theo issueKey để hai lần gọi giống nhau (C-6)', () => {
    const r = run([
      subtask({ issueKey: 'PAY-300', wbsStartDate: '2026-03-07' }),
      subtask({ issueKey: 'PAY-100', wbsStartDate: '2026-03-07' }),
    ]);
    expect(r.conflicts.map((c) => c.issueKey)).toEqual(['PAY-100', 'PAY-300']);
  });
});
