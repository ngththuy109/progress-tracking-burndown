import { describe, expect, it } from 'vitest';
import type { DataQualityIssue } from '@app/shared';
import { ALL, filterIssues, NO_PIC, picOptions, problemOptions } from './data-quality-filter.js';

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

  it('không chọn gì thì giữ nguyên cả danh sách', () => {
    expect(filterIssues(rows, { epicKey: ALL, pic: ALL, problem: ALL })).toHaveLength(4);
  });

  it('lọc theo PIC lấy đúng ticket của người đó, xuyên nhiều Epic', () => {
    const kept = filterIssues(rows, { epicKey: ALL, pic: 'a1', problem: ALL });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-101', 'SHOP-9']);
  });

  it('hai bộ lọc chồng nhau: PIC đó, trong Epic đó', () => {
    const kept = filterIssues(rows, { epicKey: 'PAY-1', pic: 'a1', problem: ALL });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-101']);
  });

  it('chọn "chưa có PIC" ra đúng ticket không gán ai', () => {
    const kept = filterIssues(rows, { epicKey: ALL, pic: NO_PIC, problem: ALL });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-103']);
  });

  it('lọc theo loại lỗi lấy MỌI ticket CÓ chứa lỗi đó (kể cả ticket nhiều lỗi)', () => {
    const kept = filterIssues(rows, { epicKey: ALL, pic: ALL, problem: 'PLANNED_ON_DAY_OFF' });

    expect(kept.map((i) => i.issueKey)).toEqual(['PAY-102', 'SHOP-9']);
  });

  it('ba bộ lọc chồng nhau: loại lỗi, PIC, trong Epic', () => {
    const kept = filterIssues(rows, { epicKey: 'SHOP-1', pic: 'a1', problem: 'PLANNED_ON_DAY_OFF' });

    expect(kept.map((i) => i.issueKey)).toEqual(['SHOP-9']);
  });
});

describe('problemOptions', () => {
  it('mỗi loại lỗi một mục kèm số ticket; ticket nhiều lỗi đếm ở TỪNG loại', () => {
    const options = problemOptions([
      issue({ issueKey: 'PAY-1', problems: ['MISSING_ESTIMATE', 'PLANNED_ON_DAY_OFF'] }),
      issue({ issueKey: 'PAY-2', problems: ['MISSING_ESTIMATE'] }),
    ]);

    expect(options).toEqual([
      { value: 'MISSING_ESTIMATE', count: 2 },
      { value: 'PLANNED_ON_DAY_OFF', count: 1 },
    ]);
  });

  it('sắp theo thứ tự DQ_PROBLEMS và chỉ hiện loại đang có ticket', () => {
    const options = problemOptions([
      issue({ issueKey: 'PAY-1', problems: ['PLANNED_ON_DAY_OFF'] }),
      issue({ issueKey: 'PAY-2', problems: ['MISSING_WBS_DATE'] }),
    ]);

    // MISSING_WBS_DATE đứng trước PLANNED_ON_DAY_OFF trong DQ_PROBLEMS.
    expect(options.map((o) => o.value)).toEqual(['MISSING_WBS_DATE', 'PLANNED_ON_DAY_OFF']);
  });
});
