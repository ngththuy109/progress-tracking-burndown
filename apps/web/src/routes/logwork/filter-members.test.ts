import { describe, expect, it } from 'vitest';
import type { LogworkMember, LogworkTicket } from '@app/shared';
import { EMPTY_FILTER, filterMembers, isFilterActive } from './filter-members.js';

/**
 * Lọc phía trình duyệt cho báo cáo Log work.
 *
 * Điểm mấu chốt: từ khoá khớp cả TÊN member lẫn MÃ/TIÊU ĐỀ ticket; khớp ở ticket
 * thì THU HẸP bảng còn đúng ticket đó; "Only not logged" bỏ ai đã log đủ mà không
 * làm sai các con số huy hiệu.
 */

function ticket(over: Partial<LogworkTicket> = {}): LogworkTicket {
  return {
    issueKey: 'PAY-11',
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    summary: 'Payout retry worker',
    parentKey: null,
    phaseCode: 'DEV',
    statusCategory: 'indeterminate',
    originalEstimateHours: 8,
    memberLoggedHours: 0,
    totalLoggedHours: 0,
    notLogged: true,
    exempted: false,
    exemptedBy: null,
    exemptedAt: null,
    ...over,
  };
}

function member(over: Partial<LogworkMember> = {}): LogworkMember {
  return {
    accountId: 'u1',
    displayName: 'Nguyễn An',
    totalLoggedHours: 12.5,
    hasOpenAssignments: true,
    tickets: [ticket()],
    notLoggedCount: 1,
    exemptedCount: 0,
    primaryEpicKey: 'PAY-1',
    expectedHours: 40,
    deficitHours: 27.5,
    behind: true,
    ...over,
  };
}

describe('isFilterActive', () => {
  it('rỗng khi không có từ khoá lẫn cờ', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ term: '   ', notLoggedOnly: false })).toBe(false);
  });

  it('bật khi có từ khoá hoặc cờ not-logged', () => {
    expect(isFilterActive({ term: 'pay', notLoggedOnly: false })).toBe(true);
    expect(isFilterActive({ term: '', notLoggedOnly: true })).toBe(true);
  });
});

describe('filterMembers', () => {
  it('không điều kiện thì trả nguyên danh sách (cùng tham chiếu)', () => {
    const m = member();
    const out = filterMembers([m], EMPTY_FILTER);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(m);
  });

  it('khớp tên member — giữ NGUYÊN mọi ticket của họ', () => {
    const m = member({
      displayName: 'Trần Bình',
      tickets: [ticket({ issueKey: 'PAY-11' }), ticket({ issueKey: 'PAY-22', summary: 'Ledger sync' })],
    });
    const out = filterMembers([m], { term: 'bình', notLoggedOnly: false });
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(m);
    expect(out[0]?.tickets).toHaveLength(2);
  });

  it('khớp MÃ ticket — thu hẹp bảng còn đúng ticket đó', () => {
    const m = member({
      displayName: 'Trần Bình',
      tickets: [ticket({ issueKey: 'PAY-11' }), ticket({ issueKey: 'PAY-22', summary: 'Ledger sync' })],
    });
    const out = filterMembers([m], { term: 'pay-22', notLoggedOnly: false });
    expect(out).toHaveLength(1);
    expect(out[0]?.tickets.map((t) => t.issueKey)).toEqual(['PAY-22']);
    // Object mới, không đụng vào member gốc.
    expect(out[0]).not.toBe(m);
    expect(m.tickets).toHaveLength(2);
  });

  it('khớp TIÊU ĐỀ ticket, không phân biệt hoa thường', () => {
    const m = member({
      tickets: [ticket({ issueKey: 'PAY-11', summary: 'Payout retry worker' }), ticket({ issueKey: 'PAY-22', summary: 'Ledger sync' })],
    });
    const out = filterMembers([m], { term: 'LEDGER', notLoggedOnly: false });
    expect(out[0]?.tickets.map((t) => t.issueKey)).toEqual(['PAY-22']);
  });

  it('không khớp tên lẫn ticket nào thì loại member', () => {
    const m = member({ displayName: 'Trần Bình', tickets: [ticket({ issueKey: 'PAY-11', summary: 'Payout' })] });
    expect(filterMembers([m], { term: 'zzz', notLoggedOnly: false })).toEqual([]);
  });

  it('rơi về accountId khi không có displayName', () => {
    const m = member({ displayName: null, accountId: 'acc-xyz', tickets: [] });
    expect(filterMembers([m], { term: 'xyz', notLoggedOnly: false })).toHaveLength(1);
  });

  it('"Only not logged" bỏ member đã log đủ', () => {
    const behind = member({ accountId: 'u1', notLoggedCount: 2 });
    const clear = member({ accountId: 'u2', displayName: 'Lê Cường', notLoggedCount: 0 });
    const out = filterMembers([behind, clear], { term: '', notLoggedOnly: true });
    expect(out.map((m) => m.accountId)).toEqual(['u1']);
  });

  it('"Only not logged" giữ NGUYÊN ticket (không làm sai con số huy hiệu)', () => {
    const m = member({
      notLoggedCount: 1,
      tickets: [ticket({ notLogged: true }), ticket({ issueKey: 'PAY-22', notLogged: false, memberLoggedHours: 3 })],
    });
    const out = filterMembers([m], { term: '', notLoggedOnly: true });
    expect(out[0]).toBe(m);
    expect(out[0]?.tickets).toHaveLength(2);
  });

  it('kết hợp từ khoá và cờ not-logged', () => {
    const a = member({ accountId: 'u1', displayName: 'An', notLoggedCount: 1 });
    const b = member({ accountId: 'u2', displayName: 'An Nhiên', notLoggedCount: 0 });
    const out = filterMembers([a, b], { term: 'an', notLoggedOnly: true });
    expect(out.map((m) => m.accountId)).toEqual(['u1']);
  });
});
