import { describe, it, expect, vi } from 'vitest';
import type { ChangelogEvent, StatusCategory } from '@app/shared';
import {
  resolveStatusCategoryAt,
  currentStatusCategory,
  findFirstInProgressMs,
  findLastDoneMs,
} from './resolve-status-category.js';

/**
 * Bảng tra giả lập một Jira tiếng Nhật thật:
 *   10000 未対応 (To Do) · 10001 対応中 (In Progress) · 10002 完了 (Done)
 */
const STATUS_MAP: ReadonlyMap<string, StatusCategory> = new Map([
  ['10000', 'new'],
  ['10001', 'indeterminate'],
  ['10002', 'done'],
]);

const D = (iso: string) => Date.parse(iso);

function ev(toStatusId: string, iso: string): ChangelogEvent {
  return {
    issueKey: 'PAY-121',
    field: 'status',
    fromValue: null,
    toValue: toStatusId,
    createdAtMs: D(iso),
  };
}

describe('trạng thái tại một mốc quá khứ', () => {
  it('issue mới tạo chưa có changelog thì thuộc nhóm To Do', () => {
    expect(resolveStatusCategoryAt([], STATUS_MAP, D('2026-03-10T00:00:00Z'))).toBe('new');
  });

  it('tua đúng trạng thái tại một mốc nằm giữa hai lần đổi', () => {
    const log = [ev('10001', '2026-03-09T02:00:00Z'), ev('10002', '2026-03-12T02:00:00Z')];
    // Hỏi lúc 10/03: đã qua lần đổi 09/03, chưa tới lần 12/03
    expect(resolveStatusCategoryAt(log, STATUS_MAP, D('2026-03-10T23:59:59Z'))).toBe(
      'indeterminate',
    );
  });

  it('sự kiện xảy ra SAU mốc hỏi thì bị bỏ qua', () => {
    const log = [ev('10002', '2026-03-20T02:00:00Z')];
    expect(resolveStatusCategoryAt(log, STATUS_MAP, D('2026-03-10T23:59:59Z'))).toBe('new');
  });

  it('admin đổi tên hiển thị 完了 thành 対応完了 thì vẫn nhận là Done', () => {
    // Cùng status ID 10002, chỉ khác `name` — bảng tra không đổi nên kết quả không đổi.
    const log = [ev('10002', '2026-03-12T02:00:00Z')];
    expect(resolveStatusCategoryAt(log, STATUS_MAP, D('2026-03-13T00:00:00Z'))).toBe('done');
  });

  it('xử lý đúng ca reopen To Do → Done → In Progress → Done', () => {
    const log = [
      ev('10001', '2026-03-09T02:00:00Z'),
      ev('10002', '2026-03-12T02:00:00Z'),
      ev('10001', '2026-03-13T02:00:00Z'),
      ev('10002', '2026-03-16T02:00:00Z'),
    ];
    expect(resolveStatusCategoryAt(log, STATUS_MAP, D('2026-03-08T23:59:59Z'))).toBe('new');
    expect(resolveStatusCategoryAt(log, STATUS_MAP, D('2026-03-10T23:59:59Z'))).toBe(
      'indeterminate',
    );
    expect(resolveStatusCategoryAt(log, STATUS_MAP, D('2026-03-12T23:59:59Z'))).toBe('done');
    // Sau khi mở lại thì KHÔNG còn là done — nếu cache cứng "đã done thì mãi mãi
    // done" thì khối lượng công việc bị mất trắng
    expect(resolveStatusCategoryAt(log, STATUS_MAP, D('2026-03-14T23:59:59Z'))).toBe(
      'indeterminate',
    );
    expect(resolveStatusCategoryAt(log, STATUS_MAP, D('2026-03-17T23:59:59Z'))).toBe('done');
  });

  it('status ID lạ thì giữ trạng thái trước đó và ghi cảnh báo, KHÔNG ném lỗi', () => {
    const warn = vi.fn();
    const log = [ev('10001', '2026-03-09T02:00:00Z'), ev('99999', '2026-03-10T02:00:00Z')];

    const result = resolveStatusCategoryAt(log, STATUS_MAP, D('2026-03-11T00:00:00Z'), warn);

    expect(result).toBe('indeterminate');
    expect(warn).toHaveBeenCalledWith('UNKNOWN_STATUS_ID', expect.stringContaining('99999'));
  });

  it('bỏ qua các trường changelog khác, chỉ đọc field status', () => {
    const log: ChangelogEvent[] = [
      { ...ev('10002', '2026-03-09T02:00:00Z'), field: 'timeestimate' },
      ev('10001', '2026-03-10T02:00:00Z'),
    ];
    expect(resolveStatusCategoryAt(log, STATUS_MAP, D('2026-03-11T00:00:00Z'))).toBe(
      'indeterminate',
    );
  });
});

describe('mốc bắt đầu và kết thúc thực tế', () => {
  const reopened = [
    ev('10001', '2026-03-09T02:00:00Z'),
    ev('10002', '2026-03-12T02:00:00Z'),
    ev('10001', '2026-03-13T02:00:00Z'),
    ev('10002', '2026-03-16T02:00:00Z'),
  ];

  it('lấy lần ĐẦU TIÊN chuyển sang In Progress', () => {
    expect(findFirstInProgressMs(reopened, STATUS_MAP)).toBe(D('2026-03-09T02:00:00Z'));
  });

  it('lấy lần CUỐI CÙNG chuyển sang Done, không lấy lần đầu', () => {
    // Lấy lần đầu (12/03) sẽ mất trắng 4 ngày làm lại — lỗi im lặng (PRD E-13)
    expect(findLastDoneMs(reopened, STATUS_MAP)).toBe(D('2026-03-16T02:00:00Z'));
    expect(findLastDoneMs(reopened, STATUS_MAP)).not.toBe(D('2026-03-12T02:00:00Z'));
  });

  it('chưa từng In Progress thì trả null', () => {
    expect(findFirstInProgressMs([ev('10002', '2026-03-12T02:00:00Z')], STATUS_MAP)).toBeNull();
  });

  it('chưa từng Done thì trả null', () => {
    expect(findLastDoneMs([ev('10001', '2026-03-09T02:00:00Z')], STATUS_MAP)).toBeNull();
  });

  it('chuyển thẳng To Do sang Done không qua In Progress thì không có mốc bắt đầu', () => {
    const log = [ev('10002', '2026-03-12T02:00:00Z')];
    expect(findFirstInProgressMs(log, STATUS_MAP)).toBeNull();
    expect(findLastDoneMs(log, STATUS_MAP)).toBe(D('2026-03-12T02:00:00Z'));
  });
});

describe('trạng thái HIỆN TẠI', () => {
  it('chưa có changelog thì là nhóm To Do', () => {
    expect(currentStatusCategory([], STATUS_MAP)).toBe('new');
  });

  it('lấy trạng thái SAU sự kiện đổi cuối cùng, không phụ thuộc mốc thời gian', () => {
    const log = [ev('10001', '2026-03-09T02:00:00Z'), ev('10002', '2026-03-12T02:00:00Z')];
    expect(currentStatusCategory(log, STATUS_MAP)).toBe('done');
  });

  it('chuyển nhầm In Progress rồi kéo về To Do thì hiện tại là To Do', () => {
    // Đây là điểm mấu chốt của bug reset actual_start: dấu vết In Progress vẫn
    // còn nhưng trạng thái cuối đã về `new`.
    const log = [ev('10001', '2026-03-09T02:00:00Z'), ev('10000', '2026-03-10T02:00:00Z')];
    expect(currentStatusCategory(log, STATUS_MAP)).toBe('new');
    // ...trong khi dấu vết In Progress trong quá khứ vẫn tìm thấy được:
    expect(findFirstInProgressMs(log, STATUS_MAP)).toBe(D('2026-03-09T02:00:00Z'));
  });
});
