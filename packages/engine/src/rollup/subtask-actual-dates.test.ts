import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  type ChangelogEvent,
  type StatusIdMap,
  type SubtaskRecord,
  type WorkCalendar,
  type WorklogRecord,
} from '@app/shared';
import { resolveSubtaskActualDates, resolveCloseLagWorkdays } from './subtask-actual-dates.js';

const VN = 'Asia/Ho_Chi_Minh';
const JP = 'Asia/Tokyo';
const H = 3600;

const cal = (over: Partial<WorkCalendar> = {}): WorkCalendar => ({
  calendarId: 'VN_STANDARD',
  timezone: VN,
  workdaysMask: DEFAULT_WORKDAYS_MASK,
  hoursPerDay: 8,
  holidays: new Set<string>(),
  warnings: [],
  ...over,
});

/** '1' = 未対応 (To Do), '3' = 対応中 (In Progress), '10001' = 完了 (Done). */
const STATUS: StatusIdMap = new Map([
  ['1', 'new'],
  ['3', 'indeterminate'],
  ['10001', 'done'],
]);

const status = (to: string, iso: string): ChangelogEvent => ({
  issueKey: 'PAY-121',
  field: 'status',
  fromValue: null,
  toValue: to,
  createdAtMs: Date.parse(iso),
});

const wl = (iso: string, isDeleted = false): WorklogRecord => ({
  worklogId: `w-${iso}`,
  issueKey: 'PAY-121',
  timeSpentSeconds: 8 * H,
  startedAtMs: Date.parse(iso),
  isDeleted,
});

const sub = (over: Partial<SubtaskRecord> = {}): SubtaskRecord => ({
  key: 'PAY-121',
  phaseCode: 'DESIGN',
  originalEstimateSeconds: 40 * H,
  createdAtMs: Date.parse('2026-03-01T00:00:00Z'),
  removedAtMs: null,
  wbsStartDate: null,
  wbsEndDate: null,
  changelog: [],
  worklogs: [],
  ...over,
});

describe('ca mở lại — PRD §2.7.2, E-13', () => {
  /** 未対応 → 対応中 → 完了 → 対応中 → 完了, không log giờ. */
  const REOPENED = sub({
    changelog: [
      status('3', '2026-03-09T02:00:00Z'),
      status('10001', '2026-03-12T02:00:00Z'),
      status('3', '2026-03-13T02:00:00Z'),
      status('10001', '2026-03-16T02:00:00Z'),
    ],
  });

  it('không có worklog thì start = lần đầu In Progress, end = lần Done cuối', () => {
    const r = resolveSubtaskActualDates(REOPENED, STATUS, VN);
    expect(r.actualStart).toBe('2026-03-09');
    expect(r.actualEnd).toBe('2026-03-16');
    expect(r.actualEndIsProvisional).toBe(false);
  });

  it('actual_end lấy lần Done CUỐI CÙNG, không lấy lần Done đầu tiên', () => {
    // Lấy lần đầu (12/03) sẽ mất trắng 4 ngày làm lại — lỗi hoàn toàn im lặng
    expect(resolveSubtaskActualDates(REOPENED, STATUS, VN).actualEnd).not.toBe('2026-03-12');
  });
});

describe('actual_start — worklog là nguồn ưu tiên', () => {
  it('đã có worklog thì actual_start = ngày worklog SỚM NHẤT, kể cả khi chuyển In Progress sớm hơn', () => {
    const s = sub({
      changelog: [status('3', '2026-03-09T02:00:00Z')],
      worklogs: [wl('2026-03-10T02:00:00Z'), wl('2026-03-12T02:00:00Z')],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-10');
  });

  it('log giờ 08/03 nhưng chuyển In Progress 09/03 thì actual_start = 08/03', () => {
    const s = sub({
      changelog: [status('3', '2026-03-09T02:00:00Z')],
      worklogs: [wl('2026-03-08T02:00:00Z')],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-08');
  });

  it('chỉ có worklog, chưa từng chuyển In Progress thì vẫn có actual_start', () => {
    const s = sub({ worklogs: [wl('2026-03-10T02:00:00Z')] });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-10');
  });

  it('chỉ chuyển In Progress, chưa log giờ nào thì actual_start lấy từ changelog', () => {
    const s = sub({ changelog: [status('3', '2026-03-09T02:00:00Z')] });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-09');
  });

  it('lấy lần chuyển In Progress ĐẦU TIÊN, không phải lần cuối', () => {
    const s = sub({
      changelog: [
        status('3', '2026-03-09T02:00:00Z'),
        status('1', '2026-03-10T02:00:00Z'),
        status('3', '2026-03-11T02:00:00Z'),
      ],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-09');
  });
});

describe('chuyển nhầm In Progress rồi trả về Open — reset actual_start khi resync', () => {
  it('kéo In Progress về To Do, chưa Done, không log giờ thì actual_start = null', () => {
    // Bug gốc: user chuyển nhầm sang In Progress dù chưa bắt đầu, sửa lại về
    // Open rồi bấm resync — actual_start vẫn không về null. Dấu vết In Progress
    // còn trong changelog nhưng trạng thái HIỆN TẠI là To Do nghĩa là CHƯA làm.
    const s = sub({
      changelog: [
        status('3', '2026-03-09T02:00:00Z'), // 未対応 → 対応中 (nhầm)
        status('1', '2026-03-10T02:00:00Z'), // 対応中 → 未対応 (sửa lại về Open)
      ],
    });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualStart).toBeNull();
    expect(r.actualEnd).toBeNull();
    expect(r.actualEndIsProvisional).toBe(true);
  });

  it('kéo về To Do rồi lại chuyển In Progress thì actual_start = lần In Progress ĐẦU', () => {
    // KHÔNG được chặn quá tay: nếu ticket lại đang In Progress thì nó đã bắt đầu
    // thật, giữ nguyên ngày In Progress đầu tiên.
    const s = sub({
      changelog: [
        status('3', '2026-03-09T02:00:00Z'),
        status('1', '2026-03-10T02:00:00Z'),
        status('3', '2026-03-11T02:00:00Z'), // hiện đang In Progress
      ],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-09');
  });

  it('có worklog thì vẫn giữ actual_start dù đã kéo về To Do', () => {
    // Worklog là bằng chứng đã thật sự làm — không bị xoá theo trạng thái.
    const s = sub({
      changelog: [
        status('3', '2026-03-09T02:00:00Z'),
        status('1', '2026-03-11T02:00:00Z'), // về To Do
      ],
      worklogs: [wl('2026-03-09T02:00:00Z')],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-09');
  });

  it('đã Done rồi mới kéo về To Do thì GIỮ ngày bắt đầu — việc đã làm là thật', () => {
    // Chỉ reset khi CHƯA TỪNG Done. Task To Do→In Progress→Done→To Do (kéo về
    // backlog sau khi xong) là việc thật, actual_start vẫn là lần In Progress đầu.
    const s = sub({
      changelog: [
        status('3', '2026-03-09T02:00:00Z'),
        status('10001', '2026-03-12T02:00:00Z'),
        status('1', '2026-03-13T02:00:00Z'), // kéo ngược về To Do
      ],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-09');
  });
});

describe('actual_end — chưa Done thì KHÔNG tạm tính', () => {
  it('Sub-task chưa Done thì actual_end = null dù đã có worklog', () => {
    // Trước đây lấy tạm ngày worklog cuối — PM đọc nhầm thành việc đã xong.
    const s = sub({
      changelog: [status('3', '2026-03-09T02:00:00Z')],
      worklogs: [wl('2026-03-10T02:00:00Z'), wl('2026-03-14T02:00:00Z')],
    });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualEnd).toBeNull();
    expect(r.actualEndIsProvisional).toBe(true);
  });

  it('Sub-task đã Done thì actualEndIsProvisional = false', () => {
    const s = sub({ changelog: [status('10001', '2026-03-16T02:00:00Z')] });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualEndIsProvisional).toBe(false);
  });

  it('Sub-task chưa Done và chưa log giờ thì actual_end = null', () => {
    const s = sub({ changelog: [status('3', '2026-03-09T02:00:00Z')] });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualEnd).toBeNull();
    expect(r.actualEndIsProvisional).toBe(true);
  });

  it('đã Done ngày 16/03 nhưng worklog cuối 14/03 thì actual_end = 14/03 (tin worklog)', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-16T02:00:00Z')],
      worklogs: [wl('2026-03-14T02:00:00Z')],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualEnd).toBe('2026-03-14');
  });
});

describe('Done mà không có worklog', () => {
  it('Sub-task chưa động vào thì actual_start và actual_end đều null', () => {
    const r = resolveSubtaskActualDates(sub(), STATUS, VN);
    expect(r.actualStart).toBeNull();
    expect(r.actualEnd).toBeNull();
  });

  it('chuyển thẳng To Do sang Done, không log giờ thì start = end = ngày Done', () => {
    // Task xong mà không để lại dấu vết nào khác — coi như làm xong trong đúng
    // ngày Done, còn hơn là một task Done không có ngày bắt đầu.
    const s = sub({ changelog: [status('10001', '2026-03-16T02:00:00Z')] });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualStart).toBe('2026-03-16');
    expect(r.actualEnd).toBe('2026-03-16');
  });

  it('Done không worklog nhưng CÓ qua In Progress thì start vẫn lấy từ changelog', () => {
    const s = sub({
      changelog: [status('3', '2026-03-09T02:00:00Z'), status('10001', '2026-03-16T02:00:00Z')],
    });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualStart).toBe('2026-03-09');
    expect(r.actualEnd).toBe('2026-03-16');
  });

  it('chuyển thẳng sang Done nhưng CÓ worklog thì start và end lấy từ worklog', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-16T02:00:00Z')],
      worklogs: [wl('2026-03-12T02:00:00Z')],
    });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualStart).toBe('2026-03-12');
    expect(r.actualEnd).toBe('2026-03-12');
  });
});

describe('múi giờ', () => {
  it('mốc UTC 2026-03-09T17:30:00Z ra ngày 2026-03-10 theo giờ Việt Nam', () => {
    // Cắt chuỗi ISO sẽ cho 2026-03-09 — sai một ngày, và chỉ sai với worklog
    // buổi tối nên cực khó phát hiện
    const s = sub({ worklogs: [wl('2026-03-09T17:30:00Z')] });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-10');
  });

  it('cùng mốc UTC cho ra ngày khác nhau giữa giờ Việt Nam và giờ Nhật', () => {
    // 2026-03-09T16:00Z = 23:00 ngày 09/03 ở VN, nhưng 01:00 ngày 10/03 ở Nhật
    const s = sub({ worklogs: [wl('2026-03-09T16:00:00Z')] });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-09');
    expect(resolveSubtaskActualDates(s, STATUS, JP).actualStart).toBe('2026-03-10');
  });
});

describe('worklog bị xoá', () => {
  it('worklog đã bị xoá không được tính vào actual_start', () => {
    const s = sub({ worklogs: [wl('2026-03-08T02:00:00Z', true), wl('2026-03-10T02:00:00Z')] });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-10');
  });

  it('worklog đã bị xoá không được tính vào actual_end', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-16T02:00:00Z')],
      worklogs: [wl('2026-03-10T02:00:00Z'), wl('2026-03-14T02:00:00Z', true)],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualEnd).toBe('2026-03-10');
  });

  it('mọi worklog đều bị xoá thì coi như không có worklog nào', () => {
    const s = sub({ worklogs: [wl('2026-03-10T02:00:00Z', true)] });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualStart).toBeNull();
    expect(r.actualEnd).toBeNull();
  });
});

describe('close-lag — số ngày làm việc đóng trễ so với worklog cuối (B1)', () => {
  // 09/03 = Thứ 2, 13/03 = Thứ 6, 16/03 = Thứ 2 kế tiếp (Mon–Fri).
  it('log cuối Thứ 2, đóng Thứ 4 cùng tuần → 2 ngày làm việc', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-11T10:00:00Z')], // 17:00 VN 11/03 (Thứ 4)
      worklogs: [wl('2026-03-09T02:00:00Z')], // 09:00 VN 09/03 (Thứ 2)
    });
    expect(resolveCloseLagWorkdays(s, STATUS, cal())).toBe(2);
  });

  it('cuối tuần KHÔNG tính: log Thứ 6, đóng Thứ 2 → chỉ 1 ngày làm việc', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-16T10:00:00Z')], // Thứ 2 16/03
      worklogs: [wl('2026-03-13T02:00:00Z')], // Thứ 6 13/03
    });
    expect(resolveCloseLagWorkdays(s, STATUS, cal())).toBe(1);
  });

  it('đóng trong ngày làm thật cuối → 0', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-09T10:00:00Z')], // 17:00 VN 09/03
      worklogs: [wl('2026-03-09T02:00:00Z')], // 09:00 VN 09/03
    });
    expect(resolveCloseLagWorkdays(s, STATUS, cal())).toBe(0);
  });

  it('ngày lễ giữa chừng KHÔNG tính: log Thứ 2, đóng Thứ 5, nghỉ Thứ 4 → 2', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-12T10:00:00Z')], // Thứ 5 12/03
      worklogs: [wl('2026-03-09T02:00:00Z')], // Thứ 2 09/03
    });
    expect(resolveCloseLagWorkdays(s, STATUS, cal({ holidays: new Set(['2026-03-11']) }))).toBe(2);
  });

  it('hiện KHÔNG Done (bị mở lại) → null, không phải ca đóng-trễ', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-11T10:00:00Z'), status('3', '2026-03-13T02:00:00Z')],
      worklogs: [wl('2026-03-09T02:00:00Z')],
    });
    expect(resolveCloseLagWorkdays(s, STATUS, cal())).toBeNull();
  });

  it('không có worklog → null (để CLOSED_NO_WORKLOG lo, không phải close-lag)', () => {
    const s = sub({ changelog: [status('10001', '2026-03-16T10:00:00Z')] });
    expect(resolveCloseLagWorkdays(s, STATUS, cal())).toBeNull();
  });

  it('worklog đã bị xoá không tính là bằng chứng → null', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-16T10:00:00Z')],
      worklogs: [wl('2026-03-09T02:00:00Z', true)],
    });
    expect(resolveCloseLagWorkdays(s, STATUS, cal())).toBeNull();
  });

  it('mở lại rồi Done lại: lấy worklog cuối và lần Done CUỐI', () => {
    // Done non 11/03, mở lại 13/03, log lại Thứ 6 13/03, Done hẳn Thứ 2 16/03 → 1.
    const s = sub({
      changelog: [
        status('10001', '2026-03-11T10:00:00Z'),
        status('3', '2026-03-13T01:00:00Z'),
        status('10001', '2026-03-16T10:00:00Z'),
      ],
      worklogs: [wl('2026-03-09T02:00:00Z'), wl('2026-03-13T02:00:00Z')],
    });
    expect(resolveCloseLagWorkdays(s, STATUS, cal())).toBe(1);
  });
});
