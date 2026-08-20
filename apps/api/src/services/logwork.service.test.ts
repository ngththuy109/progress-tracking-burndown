import { describe, it, expect } from 'vitest';
import {
  buildLogworkByPicReport,
  buildLogworkReport,
  type BuildLogworkByPicInput,
  type BuildLogworkInput,
  type LoadedLogworkSubtask,
  type WorklogDailyRow,
  type WorklogSumRow,
  type LogworkExemptionRow,
} from './logwork.service.js';

const H = 3600;

function sub(
  over: Partial<LoadedLogworkSubtask> & Pick<LoadedLogworkSubtask, 'issueKey'>,
): LoadedLogworkSubtask {
  return {
    epicKey: 'PAY',
    summary: `${over.issueKey} summary`,
    parentKey: null,
    phaseCode: 'DEV',
    statusCategory: 'indeterminate',
    originalEstimateSeconds: 8 * H,
    participants: [],
    ...over,
  };
}

const sum = (issueKey: string, authorId: string | null, hours: number): WorklogSumRow => ({
  issueKey,
  authorId,
  seconds: hours * H,
});

const exemption = (issueKey: string, accountId: string): LogworkExemptionRow => ({
  issueKey,
  accountId,
  exemptedBy: 'pm@example.com',
  exemptedAt: '2026-08-12T00:00:00.000Z',
});

const P = (accountId: string, displayName: string | null = accountId) => ({ accountId, displayName });

function build(over: Partial<BuildLogworkInput> = {}) {
  const base: BuildLogworkInput = {
    from: '2026-08-10',
    to: '2026-08-16',
    perEpic: { PAY: { projectKey: 'PAY', effectiveWorkdays: 5, hoursPerDay: 8 } },
    partialPeriod: false,
    visibleEpicCount: 1,
    warnings: [],
    includeUnassignedAuthors: true,
    subtasks: [],
    worklogSums: [],
    exemptions: [],
  };
  return buildLogworkReport({ ...base, ...over });
}

const member = (res: ReturnType<typeof build>, accountId: string) => {
  const m = res.members.find((x) => x.accountId === accountId);
  if (!m) throw new Error(`no member ${accountId}`);
  return m;
};

describe('buildLogworkReport', () => {
  it('ticket nhiều participant xuất hiện dưới TỪNG member', () => {
    const res = build({
      subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a', 'Alice'), P('b', 'Bob')] })],
    });
    expect(member(res, 'a').tickets.map((t) => t.issueKey)).toEqual(['PAY-1']);
    expect(member(res, 'b').tickets.map((t) => t.issueKey)).toEqual(['PAY-1']);
  });

  it('participant trùng trong CÙNG ticket chỉ ra một dòng', () => {
    const res = build({ subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a'), P('a')] })] });
    expect(member(res, 'a').tickets).toHaveLength(1);
  });

  it('chưa-log / đã-log / người-khác-log', () => {
    const res = build({
      subtasks: [
        sub({ issueKey: 'PAY-1', participants: [P('a', 'A')] }),
        sub({ issueKey: 'PAY-2', participants: [P('a', 'A')] }),
        sub({ issueKey: 'PAY-3', participants: [P('a', 'A')] }),
      ],
      worklogSums: [sum('PAY-2', 'a', 3), sum('PAY-3', 'z', 2)],
    });
    const a = member(res, 'a');
    const t1 = a.tickets.find((t) => t.issueKey === 'PAY-1')!;
    const t2 = a.tickets.find((t) => t.issueKey === 'PAY-2')!;
    const t3 = a.tickets.find((t) => t.issueKey === 'PAY-3')!;
    expect(t1.notLogged).toBe(true);
    expect(t1.totalLoggedHours).toBe(0);
    expect(t2.notLogged).toBe(false);
    expect(t2.memberLoggedHours).toBe(3);
    // Người khác đã log: bản thân vẫn "chưa log", nhưng total > 0 → "0 / 2".
    expect(t3.notLogged).toBe(true);
    expect(t3.memberLoggedHours).toBe(0);
    expect(t3.totalLoggedHours).toBe(2);
    expect(a.notLoggedCount).toBe(2);
    expect(a.totalLoggedHours).toBe(3);
  });

  it('ticket nhiều participant: MỘT người log là hết cờ cho cả nhóm', () => {
    const res = build({
      subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a', 'A'), P('b', 'B'), P('c', 'C')] })],
      // Chỉ 'a' log; 'b'/'c' không tự log nhưng ticket đã có người trong nhóm log.
      worklogSums: [sum('PAY-1', 'a', 5)],
    });
    const ta = member(res, 'a').tickets[0]!;
    const tb = member(res, 'b').tickets[0]!;
    const tc = member(res, 'c').tickets[0]!;
    // Không ai bị gắn cờ vì participant 'a' đã log hộ cả ticket.
    expect(ta.notLogged).toBe(false);
    expect(tb.notLogged).toBe(false);
    expect(tc.notLogged).toBe(false);
    // Giờ log RIÊNG từng người vẫn đúng: 'a' 5h; 'b'/'c' 0 (UI đọc "0 / 5").
    expect(ta.memberLoggedHours).toBe(5);
    expect(tb.memberLoggedHours).toBe(0);
    expect(tb.totalLoggedHours).toBe(5);
    expect(member(res, 'b').notLoggedCount).toBe(0);
    expect(res.totalNotLogged).toBe(0);
  });

  it('ticket nhiều participant: KHÔNG ai trong nhóm log thì cả nhóm bị gắn cờ', () => {
    const res = build({
      subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a'), P('b')] })],
    });
    expect(member(res, 'a').tickets[0]!.notLogged).toBe(true);
    expect(member(res, 'b').tickets[0]!.notLogged).toBe(true);
    expect(res.totalNotLogged).toBe(2);
  });

  it('ticket nhiều participant: người NGOÀI nhóm log KHÔNG gỡ cờ (chỉ tính participant)', () => {
    const res = build({
      subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a'), P('b')] })],
      // 'z' không phải participant → không đại diện nhóm in-charge, chỉ cộng total.
      worklogSums: [sum('PAY-1', 'z', 4)],
    });
    const ta = member(res, 'a').tickets[0]!;
    expect(ta.notLogged).toBe(true);
    expect(ta.memberLoggedHours).toBe(0);
    expect(ta.totalLoggedHours).toBe(4);
  });

  it('ticket nhiều participant: participant log được exempt KHÔNG che khuất việc nhóm đã log', () => {
    // 'a' vừa log vừa được exempt; 'b' chưa log. Nhóm coi như đã log → 'b' hết cờ.
    const res = build({
      subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a'), P('b')] })],
      worklogSums: [sum('PAY-1', 'a', 3)],
      exemptions: [exemption('PAY-1', 'a')],
    });
    expect(member(res, 'a').tickets[0]!.exempted).toBe(true);
    expect(member(res, 'b').tickets[0]!.notLogged).toBe(false);
    expect(res.totalNotLogged).toBe(0);
  });

  it('người có log nhưng không in-charge: gộp khi bật cờ, bỏ khi tắt', () => {
    const withZ = build({
      subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a', 'A')] })],
      worklogSums: [sum('PAY-1', 'z', 4)],
      includeUnassignedAuthors: true,
    });
    const z = member(withZ, 'z');
    expect(z.hasOpenAssignments).toBe(false);
    expect(z.tickets).toHaveLength(0);
    expect(z.totalLoggedHours).toBe(4);

    const without = build({
      subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a', 'A')] })],
      worklogSums: [sum('PAY-1', 'z', 4)],
      includeUnassignedAuthors: false,
    });
    expect(without.members.some((m) => m.accountId === 'z')).toBe(false);
    // Giờ của z vẫn cộng vào TOTAL của ticket dù z không phải member.
    expect(member(without, 'a').tickets[0]!.totalLoggedHours).toBe(4);
    expect(member(without, 'a').tickets[0]!.memberLoggedHours).toBe(0);
  });

  it('cùng người ở hai ticket: hai dòng ticket, tổng giờ cộng một lần', () => {
    const res = build({
      subtasks: [
        sub({ issueKey: 'PAY-1', participants: [P('a')] }),
        sub({ issueKey: 'PAY-2', participants: [P('a')] }),
      ],
      worklogSums: [sum('PAY-1', 'a', 2), sum('PAY-2', 'a', 3)],
    });
    const a = member(res, 'a');
    expect(a.tickets).toHaveLength(2);
    expect(a.totalLoggedHours).toBe(5);
  });

  it('tên hiển thị: bản không rỗng đầu tiên thắng, không có thì null (web hiện accountId)', () => {
    const res = build({
      subtasks: [
        sub({ issueKey: 'PAY-1', participants: [P('a', null)] }),
        sub({ issueKey: 'PAY-2', participants: [P('a', 'Alice')] }),
        sub({ issueKey: 'PAY-3', participants: [P('c', null)] }),
      ],
    });
    expect(member(res, 'a').displayName).toBe('Alice');
    expect(member(res, 'c').displayName).toBeNull();
  });

  it('capacity: chọn Epic chính nhiều ticket nhất, tính behind + deficit', () => {
    const res = build({
      perEpic: {
        PAY: { projectKey: 'PAY', effectiveWorkdays: 5, hoursPerDay: 8 },
        CRM: { projectKey: 'CRM', effectiveWorkdays: 5, hoursPerDay: 7 },
      },
      visibleEpicCount: 2,
      subtasks: [
        sub({ issueKey: 'PAY-1', epicKey: 'PAY', participants: [P('a')] }),
        sub({ issueKey: 'PAY-2', epicKey: 'PAY', participants: [P('a')] }),
        sub({ issueKey: 'CRM-1', epicKey: 'CRM', participants: [P('a')] }),
      ],
      worklogSums: [sum('PAY-1', 'a', 10)],
    });
    const a = member(res, 'a');
    expect(a.primaryEpicKey).toBe('PAY'); // 2 ticket > CRM 1 ticket
    expect(a.expectedHours).toBe(40); // 5 × 8
    expect(a.behind).toBe(true);
    expect(a.deficitHours).toBe(30);
  });

  it('capacity: đủ giờ thì không behind, deficit 0', () => {
    const res = build({
      subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a')] })],
      worklogSums: [sum('PAY-1', 'a', 40)],
    });
    const a = member(res, 'a');
    expect(a.behind).toBe(false);
    expect(a.deficitHours).toBe(0);
  });

  it('không in-charge Epic nào → expected 0, không behind', () => {
    const res = build({ worklogSums: [sum('X-1', 'z', 2)] });
    const z = member(res, 'z');
    expect(z.primaryEpicKey).toBeNull();
    expect(z.expectedHours).toBe(0);
    expect(z.behind).toBe(false);
  });

  it('hasParticipantData phản ánh có participant hay không', () => {
    expect(build({ subtasks: [sub({ issueKey: 'PAY-1', participants: [] })] }).hasParticipantData).toBe(
      false,
    );
    expect(
      build({ subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a')] })] }).hasParticipantData,
    ).toBe(true);
  });

  it('worklog authorId null: cộng vào total của ticket, không thuộc member nào', () => {
    const res = build({
      subtasks: [sub({ issueKey: 'PAY-1', participants: [P('a')] })],
      worklogSums: [sum('PAY-1', null, 5)],
    });
    const a = member(res, 'a');
    expect(a.tickets[0]!.totalLoggedHours).toBe(5);
    expect(a.tickets[0]!.memberLoggedHours).toBe(0);
    expect(a.tickets[0]!.notLogged).toBe(true);
    expect(a.totalLoggedHours).toBe(0);
    expect(res.members).toHaveLength(1); // chỉ 'a'
  });

  it('exempt: loại khỏi notLogged/count nhưng vẫn hiện với exempted=true', () => {
    const res = build({
      subtasks: [
        sub({ issueKey: 'PAY-1', participants: [P('a')] }),
        sub({ issueKey: 'PAY-2', participants: [P('a')] }),
      ],
      exemptions: [exemption('PAY-1', 'a')],
    });
    const a = member(res, 'a');
    const t1 = a.tickets.find((t) => t.issueKey === 'PAY-1')!;
    expect(t1.exempted).toBe(true);
    expect(t1.exemptedBy).toBe('pm@example.com');
    expect(t1.notLogged).toBe(false);
    expect(a.exemptedCount).toBe(1);
    expect(a.notLoggedCount).toBe(1); // chỉ PAY-2
    expect(res.totalNotLogged).toBe(1);
  });

  it('sắp member: nhiều ticket chưa-log lên đầu, rồi ít giờ hơn, rồi theo tên', () => {
    const res = build({
      perEpic: { E: { projectKey: 'P', effectiveWorkdays: 5, hoursPerDay: 8 } },
      subtasks: [
        sub({ issueKey: 'E-1', epicKey: 'E', participants: [P('cuong', 'Cuong')] }),
        sub({ issueKey: 'E-2', epicKey: 'E', participants: [P('cuong', 'Cuong')] }),
        sub({ issueKey: 'E-3', epicKey: 'E', participants: [P('cuong', 'Cuong')] }),
        sub({ issueKey: 'E-4', epicKey: 'E', participants: [P('an', 'An')] }),
        sub({ issueKey: 'E-5', epicKey: 'E', participants: [P('an', 'An')] }),
        sub({ issueKey: 'E-6', epicKey: 'E', participants: [P('bich', 'Bich')] }),
      ],
      // an: E-4 logged, E-5 chưa → notLogged 1, total 12; bich: E-6 logged 41;
      // ha: chỉ log giờ (unassigned) 5, notLogged 0.
      worklogSums: [sum('E-4', 'an', 12), sum('E-6', 'bich', 41), sum('X', 'ha', 5)],
    });
    expect(member(res, 'cuong').notLoggedCount).toBe(3);
    expect(member(res, 'an').notLoggedCount).toBe(1);
    // cuong (3) → an (1) → tie 0: ha (5h) trước bich (41h) theo giờ tăng dần.
    expect(res.members.map((m) => m.accountId)).toEqual(['cuong', 'an', 'ha', 'bich']);
  });

  it('truyền qua from/to/partialPeriod/warnings/visibleEpicCount', () => {
    const res = build({ partialPeriod: true, warnings: ['w1'], visibleEpicCount: 4 });
    expect(res.from).toBe('2026-08-10');
    expect(res.to).toBe('2026-08-16');
    expect(res.partialPeriod).toBe(true);
    expect(res.warnings).toEqual(['w1']);
    expect(res.visibleEpicCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------

const DATES = ['2026-08-10', '2026-08-11', '2026-08-12'] as const;

const daily = (authorId: string | null, localDate: string, hours: number): WorklogDailyRow => ({
  authorId,
  localDate,
  seconds: hours * H,
});

function buildByPic(over: Partial<BuildLogworkByPicInput> = {}) {
  const base: BuildLogworkByPicInput = {
    from: '2026-08-10',
    to: '2026-08-12',
    dates: [...DATES],
    dailyRows: [],
    names: new Map(),
    warnings: [],
  };
  return buildLogworkByPicReport({ ...base, ...over });
}

const picRow = (res: ReturnType<typeof buildByPic>, accountId: string) => {
  const r = res.rows.find((x) => x.accountId === accountId);
  if (!r) throw new Error(`no pic ${accountId}`);
  return r;
};

describe('buildLogworkByPicReport', () => {
  it('bày giờ vào đúng cột ngày, cộng dồn nhiều dòng cùng ngày', () => {
    const res = buildByPic({
      dailyRows: [
        daily('a', '2026-08-10', 3),
        daily('a', '2026-08-10', 2), // cùng ngày → cộng dồn = 5
        daily('a', '2026-08-12', 6),
      ],
    });
    const a = picRow(res, 'a');
    expect(a.hoursByDate).toEqual([5, 0, 6]);
    expect(a.totalHours).toBe(11);
  });

  it('đếm warnCount theo ngưỡng <=4 (thiếu) và >8 (quá); 0h/khoảng lành không tính', () => {
    const res = buildByPic({
      dailyRows: [
        daily('a', '2026-08-10', 4), // 4 chẵn = thiếu
        daily('a', '2026-08-11', 6), // lành
        daily('a', '2026-08-12', 8.5), // quá
      ],
    });
    expect(picRow(res, 'a').warnCount).toBe(2);
  });

  it('8h chẵn KHÔNG cảnh báo; 0h (không log) để trống, không cảnh báo', () => {
    const res = buildByPic({ dailyRows: [daily('a', '2026-08-10', 8)] });
    const a = picRow(res, 'a');
    expect(a.hoursByDate).toEqual([8, 0, 0]);
    expect(a.warnCount).toBe(0);
  });

  it('tra tên từ names; thiếu tên → displayName null (web hiện accountId)', () => {
    const res = buildByPic({
      names: new Map([['a', 'Alice']]),
      dailyRows: [daily('a', '2026-08-10', 5), daily('b', '2026-08-11', 5)],
    });
    expect(picRow(res, 'a').displayName).toBe('Alice');
    expect(picRow(res, 'b').displayName).toBeNull();
  });

  it('xếp hàng theo tên (rồi accountId)', () => {
    const res = buildByPic({
      names: new Map([
        ['x', 'An'],
        ['y', 'Bình'],
      ]),
      dailyRows: [daily('y', '2026-08-10', 5), daily('x', '2026-08-10', 5), daily('z', '2026-08-10', 5)],
    });
    // An (x), Bình (y), rồi 'z' (không tên) — 'z' > 'A'/'B' theo locale.
    expect(res.rows.map((r) => r.accountId)).toEqual(['x', 'y', 'z']);
  });

  it('tổng cột (dailyTotals) + tổng toàn kỳ (grandTotal)', () => {
    const res = buildByPic({
      dailyRows: [
        daily('a', '2026-08-10', 3),
        daily('b', '2026-08-10', 8),
        daily('a', '2026-08-12', 9),
      ],
    });
    expect(res.dailyTotals).toEqual([11, 0, 9]);
    expect(res.grandTotal).toBe(20);
  });

  it('bỏ worklog tác giả null và worklog rơi ngoài dải cột (phòng thủ)', () => {
    const res = buildByPic({
      dailyRows: [
        daily(null, '2026-08-10', 5), // không tác giả → bỏ
        daily('a', '2026-08-09', 5), // ngoài cột → bỏ
        daily('a', '2026-08-11', 4),
      ],
    });
    expect(res.rows).toHaveLength(1);
    expect(picRow(res, 'a').hoursByDate).toEqual([0, 4, 0]);
    expect(res.grandTotal).toBe(4);
  });

  it('làm tròn ô về 2 số lẻ (giây / 3600 ra số lẻ dài)', () => {
    // 10000 giây = 2.7777…h → 2.78; con số hiển thị = con số quyết định cảnh báo.
    const res = buildLogworkByPicReport({
      from: '2026-08-10',
      to: '2026-08-12',
      dates: [...DATES],
      names: new Map(),
      warnings: [],
      dailyRows: [{ authorId: 'a', localDate: '2026-08-10', seconds: 10000 }],
    });
    const a = picRow(res, 'a');
    expect(a.hoursByDate[0]).toBe(2.78);
    expect(a.totalHours).toBe(2.78);
    expect(a.warnCount).toBe(1); // 2.78 <= 4 → thiếu
  });

  it('truyền qua from/to/dates/warnings + ngưỡng', () => {
    const res = buildByPic({ warnings: ['w'] });
    expect(res.from).toBe('2026-08-10');
    expect(res.to).toBe('2026-08-12');
    expect(res.dates).toEqual([...DATES]);
    expect(res.warnings).toEqual(['w']);
    expect(res.underLimitHours).toBe(4);
    expect(res.overLimitHours).toBe(8);
  });
});
