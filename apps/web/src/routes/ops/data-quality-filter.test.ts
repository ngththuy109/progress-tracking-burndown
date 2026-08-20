import { describe, expect, it } from 'vitest';
import { DQ_PROBLEMS, type DataQualityIssue } from '@app/shared';
import {
  filterIssues,
  keepAvailable,
  NO_PIC,
  picOptions,
  problemOptions,
} from './data-quality-filter.js';

const pic = (accountId: string, displayName: string | null) => ({ accountId, displayName });

const issue = (over: Partial<DataQualityIssue> = {}): DataQualityIssue => ({
  issueKey: 'PAY-101',
  epicKey: 'PAY-1',
  epicDisplayName: 'Thanh toán',
  summary: '[PAY][BE][DEV][Login]_Create',
  problems: ['MISSING_ESTIMATE'],
  pics: [],
  exempt: false,
  exemptBy: null,
  ...over,
});

describe('picOptions', () => {
  it('mỗi PIC một mục, kèm số ticket của người đó', () => {
    const options = picOptions([
      issue({ issueKey: 'PAY-101', pics: [pic('a1', 'Nguyễn An')] }),
      issue({ issueKey: 'PAY-102', pics: [pic('a1', 'Nguyễn An')] }),
      issue({ issueKey: 'PAY-103', pics: [pic('b2', 'Trần Bình')] }),
    ]);

    expect(options).toEqual([
      { value: 'a1', label: 'Nguyễn An', count: 2 },
      { value: 'b2', label: 'Trần Bình', count: 1 },
    ]);
  });

  it('ticket có NHIỀU người thì nằm trong danh sách của TỪNG người', () => {
    // Lọc theo người thứ hai mà không thấy ticket là người đó không bao giờ
    // biết mình phải sửa nó.
    const options = picOptions([issue({ pics: [pic('a1', 'An'), pic('b2', 'Bình')] })]);

    expect(options.map((o) => o.count)).toEqual([1, 1]);
  });

  it('ticket chưa có PIC gom thành một nhóm riêng, luôn đứng CUỐI', () => {
    // Nhóm này không thuộc về ai — chỉ lọc theo từng người thì nó không bao giờ
    // lọt vào danh sách của ai cả.
    const options = picOptions([
      issue({ issueKey: 'PAY-101', pics: [] }),
      issue({ issueKey: 'PAY-102', pics: [pic('z9', 'Zoe')] }),
    ]);

    expect(options).toEqual([
      { value: 'z9', label: 'Zoe', count: 1 },
      { value: NO_PIC, label: 'No PIC yet', count: 1 },
    ]);
  });

  it('không có ticket nào thiếu PIC thì KHÔNG dựng nhóm "chưa có PIC"', () => {
    const options = picOptions([issue({ pics: [pic('a1', 'An')] })]);

    expect(options.some((o) => o.value === NO_PIC)).toBe(false);
  });

  it('Jira chưa tra được tên thì hiện accountId, không để mục trống', () => {
    const options = picOptions([issue({ pics: [pic('acc-123', null)] })]);

    expect(options[0]?.label).toBe('acc-123');
  });

  it('sắp theo TÊN có dấu tiếng Việt — người dùng đi tìm tên mình', () => {
    const options = picOptions([
      issue({ issueKey: 'PAY-1', pics: [pic('d', 'Đức')] }),
      issue({ issueKey: 'PAY-2', pics: [pic('c', 'Dũng')] }),
      issue({ issueKey: 'PAY-3', pics: [pic('a', 'An')] }),
    ]);

    expect(options.map((o) => o.label)).toEqual(['An', 'Dũng', 'Đức']);
  });
});

describe('filterIssues', () => {
  const rows = [
    issue({ issueKey: 'PAY-101', epicKey: 'PAY-1', pics: [pic('a1', 'An')], problems: ['MISSING_ESTIMATE'] }),
    issue({ issueKey: 'PAY-102', epicKey: 'PAY-1', pics: [pic('b2', 'Bình')], problems: ['PLANNED_ON_DAY_OFF'] }),
    issue({
      issueKey: 'SHOP-9',
      epicKey: 'SHOP-1',
      pics: [pic('a1', 'An')],
      problems: ['MISSING_ESTIMATE', 'PLANNED_ON_DAY_OFF'],
    }),
    issue({ issueKey: 'PAY-103', epicKey: 'PAY-1', pics: [], problems: ['UNCLASSIFIED_PHASE'] }),
  ];

  it('mảng rỗng ở cả ba chiều thì giữ nguyên cả danh sách', () => {
    expect(filterIssues(rows, { epicKeys: [], pics: [], problems: [] })).toHaveLength(4);
  });

  it('lọc theo PIC lấy đúng ticket của người đó, xuyên nhiều Epic', () => {
    const kept = filterIssues(rows, { epicKeys: [], pics: ['a1'], problems: [] });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-101', 'SHOP-9']);
  });

  it('chọn NHIỀU PIC lấy ticket của BẤT KỲ người nào trong nhóm (HOẶC)', () => {
    // Một quản lý gom nhóm mình phụ trách: An hoặc Bình.
    const kept = filterIssues(rows, { epicKeys: [], pics: ['a1', 'b2'], problems: [] });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-101', 'PAY-102', 'SHOP-9']);
  });

  it('chọn NHIỀU Epic lấy ticket của bất kỳ Epic nào trong nhóm', () => {
    const kept = filterIssues(rows, { epicKeys: ['PAY-1', 'SHOP-1'], pics: [], problems: [] });

    expect(kept).toHaveLength(4);
  });

  it('hai bộ lọc chồng nhau: PIC đó, trong Epic đó', () => {
    const kept = filterIssues(rows, { epicKeys: ['PAY-1'], pics: ['a1'], problems: [] });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-101']);
  });

  it('chọn "chưa có PIC" ra đúng ticket không gán ai', () => {
    const kept = filterIssues(rows, { epicKeys: [], pics: [NO_PIC], problems: [] });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-103']);
  });

  it('"chưa có PIC" chọn CÙNG một người: cả hai nhóm cùng lọt (HOẶC)', () => {
    const kept = filterIssues(rows, { epicKeys: [], pics: [NO_PIC, 'b2'], problems: [] });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-102', 'PAY-103']);
  });

  it('lọc theo loại lỗi lấy MỌI ticket CÓ chứa lỗi đó (kể cả ticket nhiều lỗi)', () => {
    const kept = filterIssues(rows, { epicKeys: [], pics: [], problems: ['PLANNED_ON_DAY_OFF'] });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-102', 'SHOP-9']);
  });

  it('chọn NHIỀU loại lỗi lấy ticket có ÍT NHẤT MỘT loại (HOẶC), không nhân đôi', () => {
    const kept = filterIssues(rows, {
      epicKeys: [],
      pics: [],
      problems: ['UNCLASSIFIED_PHASE', 'PLANNED_ON_DAY_OFF'],
    });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-102', 'SHOP-9', 'PAY-103']);
  });

  it('ba bộ lọc chồng nhau: loại lỗi, PIC, trong Epic', () => {
    const kept = filterIssues(rows, {
      epicKeys: ['SHOP-1'],
      pics: ['a1'],
      problems: ['PLANNED_ON_DAY_OFF'],
    });

    expect(kept.map((i) => i.issueKey)).toEqual(['SHOP-9']);
  });
});

describe('problemOptions', () => {
  it('hiện ĐỦ cả sáu loại lỗi theo thứ tự DQ_PROBLEMS, kèm số ticket mỗi loại', () => {
    // Ô lọc phải liệt kê đủ sáu loại (kể cả loại 0 ticket) — trước đây chỉ hiện
    // loại đang có ticket nên chỉ ra 4/6 khiến người trực tưởng thiếu.
    const options = problemOptions([
      issue({ issueKey: 'PAY-1', problems: ['MISSING_ESTIMATE', 'PLANNED_ON_DAY_OFF'] }),
      issue({ issueKey: 'PAY-2', problems: ['MISSING_ESTIMATE'] }),
    ]);

    expect(options.map((o) => o.value)).toEqual([...DQ_PROBLEMS]);
    expect(options).toEqual([
      { value: 'MISSING_ESTIMATE', count: 2 },
      { value: 'MISSING_WBS_DATE', count: 0 },
      { value: 'UNCLASSIFIED_PHASE', count: 0 },
      { value: 'UNPARSED_TITLE', count: 0 },
      { value: 'CLOSED_NO_WORKLOG', count: 0 },
      { value: 'PLANNED_ON_DAY_OFF', count: 1 },
    ]);
  });

  it('danh sách rỗng vẫn trả về đủ sáu loại, tất cả count 0', () => {
    const options = problemOptions([]);

    expect(options).toHaveLength(6);
    expect(options.every((o) => o.count === 0)).toBe(true);
  });
});

describe('keepAvailable', () => {
  it('bỏ lựa chọn không còn trong danh sách hiện có, giữ nguyên thứ tự phần còn lại', () => {
    expect(keepAvailable(['a1', 'b2', 'c3'], ['b2', 'a1'])).toEqual(['a1', 'b2']);
  });

  it('danh sách hiện có rỗng thì không giữ lại gì', () => {
    expect(keepAvailable(['a1', 'b2'], [])).toEqual([]);
  });

  it('mọi lựa chọn đều còn thì trả về đúng như cũ', () => {
    expect(keepAvailable(['a1', NO_PIC], ['a1', 'b2', NO_PIC])).toEqual(['a1', NO_PIC]);
  });
});
