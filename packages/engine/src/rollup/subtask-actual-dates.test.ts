import { describe, it, expect } from 'vitest';
import type { ChangelogEvent, StatusIdMap, SubtaskRecord, WorklogRecord } from '@app/shared';
import { resolveSubtaskActualDates } from './subtask-actual-dates.js';

const VN = 'Asia/Ho_Chi_Minh';
const JP = 'Asia/Tokyo';
const H = 3600;

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
  /** 未対応 → 対応中 → 完了 → 対応中 → 完了 */
  const REOPENED = sub({
    changelog: [
      status('3', '2026-03-09T02:00:00Z'),
      status('10001', '2026-03-12T02:00:00Z'),
      status('3', '2026-03-13T02:00:00Z'),
      status('10001', '2026-03-16T02:00:00Z'),
    ],
    worklogs: [wl('2026-03-10T02:00:00Z')],
  });

  it('tái hiện đúng bảng ví dụ PRD: start 09/03, end 16/03', () => {
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

describe('kết hợp hai nguồn cho actual_start', () => {
  it('chuyển In Progress 09/03 và log giờ đầu 10/03 thì actual_start = 09/03', () => {
    const s = sub({
      changelog: [status('3', '2026-03-09T02:00:00Z')],
      worklogs: [wl('2026-03-10T02:00:00Z')],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-09');
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

  it('chỉ chuyển In Progress, chưa log giờ nào thì vẫn có actual_start', () => {
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

describe('tạm tính', () => {
  it('Sub-task chưa Done thì actual_end lấy worklog cuối và đánh dấu tạm tính', () => {
    const s = sub({
      changelog: [status('3', '2026-03-09T02:00:00Z')],
      worklogs: [wl('2026-03-10T02:00:00Z'), wl('2026-03-14T02:00:00Z')],
    });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualEnd).toBe('2026-03-14');
    expect(r.actualEndIsProvisional).toBe(true);
  });

  it('Sub-task đã Done thì KHÔNG tạm tính', () => {
    const s = sub({ changelog: [status('10001', '2026-03-16T02:00:00Z')] });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualEndIsProvisional).toBe(false);
  });

  it('Sub-task chưa Done và chưa log giờ thì actual_end = null, vẫn là tạm tính', () => {
    const s = sub({ changelog: [status('3', '2026-03-09T02:00:00Z')] });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualEnd).toBeNull();
    expect(r.actualEndIsProvisional).toBe(true);
  });

  it('đã Done ngày 16/03 nhưng worklog cuối 14/03 thì actual_end vẫn là 16/03', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-16T02:00:00Z')],
      worklogs: [wl('2026-03-14T02:00:00Z')],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualEnd).toBe('2026-03-16');
  });
});

describe('chưa bắt đầu', () => {
  it('Sub-task chưa động vào thì actual_start và actual_end đều null', () => {
    const r = resolveSubtaskActualDates(sub(), STATUS, VN);
    expect(r.actualStart).toBeNull();
    expect(r.actualEnd).toBeNull();
  });

  it('chuyển thẳng To Do sang Done không qua In Progress thì actual_start = null', () => {
    // Chuyện có thật. KHÔNG được lấy tạm ngày Done làm ngày bắt đầu.
    const s = sub({ changelog: [status('10001', '2026-03-16T02:00:00Z')] });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualStart).toBeNull();
    expect(r.actualEnd).toBe('2026-03-16');
  });

  it('chuyển thẳng sang Done nhưng CÓ worklog thì actual_start lấy từ worklog', () => {
    const s = sub({
      changelog: [status('10001', '2026-03-16T02:00:00Z')],
      worklogs: [wl('2026-03-12T02:00:00Z')],
    });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualStart).toBe('2026-03-12');
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
    const s = sub({ worklogs: [wl('2026-03-10T02:00:00Z'), wl('2026-03-14T02:00:00Z', true)] });
    expect(resolveSubtaskActualDates(s, STATUS, VN).actualEnd).toBe('2026-03-10');
  });

  it('mọi worklog đều bị xoá thì coi như không có worklog nào', () => {
    const s = sub({ worklogs: [wl('2026-03-10T02:00:00Z', true)] });
    const r = resolveSubtaskActualDates(s, STATUS, VN);
    expect(r.actualStart).toBeNull();
    expect(r.actualEnd).toBeNull();
  });
});
