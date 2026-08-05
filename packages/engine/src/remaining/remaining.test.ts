import { describe, it, expect } from 'vitest';
import type { ChangelogEvent, StatusIdMap, SubtaskRecord, WorklogRecord } from '@app/shared';
import { resolveHistoricalRemaining, explainRule } from './resolve-historical-remaining.js';
import { resolveOriginalEstimateAt } from './resolve-original-estimate-at.js';
import { totalSpentTill, spentBetween } from './total-spent-till.js';

const H = 3600;
const at = (iso: string) => Date.parse(iso);

/** '1' = To Do, '3' = In Progress, '10001' = Done. */
const STATUS: StatusIdMap = new Map([
  ['1', 'new'],
  ['3', 'indeterminate'],
  ['10001', 'done'],
]);

const ev = (
  field: string,
  toValue: string | null,
  iso: string,
  fromValue: string | null = null,
): ChangelogEvent => ({
  issueKey: 'PAY-121',
  field,
  fromValue,
  toValue,
  createdAtMs: at(iso),
});

const wl = (seconds: number, iso: string, isDeleted = false): WorklogRecord => ({
  worklogId: `w-${iso}`,
  issueKey: 'PAY-121',
  timeSpentSeconds: seconds,
  startedAtMs: at(iso),
  isDeleted,
});

const sub = (over: Partial<SubtaskRecord> = {}): SubtaskRecord => ({
  key: 'PAY-121',
  phaseCode: 'DESIGN',
  originalEstimateSeconds: 40 * H,
  createdAtMs: at('2026-03-01T00:00:00Z'),
  removedAtMs: null,
  wbsStartDate: null,
  wbsEndDate: null,
  changelog: [],
  worklogs: [],
  ...over,
});

/** Cuối ngày d, giờ Việt Nam. */
const endOfDay = (d: string) => at(`${d}T16:59:59.999Z`);

describe('bảng ví dụ PRD §4.3.2 — PAY-121, Original Estimate 40 giờ', () => {
  const PAY_121 = sub({
    changelog: [
      ev('timeestimate', String(30 * H), '2026-03-12T03:00:00Z'),
      ev('timeestimate', String(10 * H), '2026-03-16T03:00:00Z'),
      ev('status', '10001', '2026-03-17T03:00:00Z'),
    ],
    worklogs: [
      wl(8 * H, '2026-03-10T02:00:00Z'),
      wl(8 * H, '2026-03-11T02:00:00Z'),
      wl(8 * H, '2026-03-13T02:00:00Z'),
    ],
  });

  const CASES: Array<[string, number, 1 | 2 | 3, string]> = [
    ['2026-03-09', 40 * H, 3, 'chưa làm gì'],
    ['2026-03-10', 32 * H, 3, 'log 8h'],
    ['2026-03-11', 24 * H, 3, 'log thêm 8h'],
    ['2026-03-12', 30 * H, 2, 'sửa timeestimate = 30h → ĐI LÊN'],
    ['2026-03-13', 30 * H, 2, 'log thêm 8h nhưng quy tắc 2 VẪN thắng'],
    ['2026-03-16', 10 * H, 2, 'sửa timeestimate = 10h'],
    ['2026-03-17', 0, 1, 'chuyển sang 完了'],
  ];

  it.each(CASES)('ngày %s còn lại đúng số PRD nêu (%s giây, quy tắc %s) — %s', (date, expected, rule) => {
    const r = resolveHistoricalRemaining(PAY_121, endOfDay(date), STATUS);
    expect(r.seconds).toBe(expected);
    expect(r.rule).toBe(rule);
  });

  it('ngày 13/03 KHÔNG giảm dù có log giờ — đây là hành vi đúng theo thiết kế', () => {
    // Cám dỗ lớn nhất ở card này là "sửa" dòng này. Nó trông như bug.
    const d12 = resolveHistoricalRemaining(PAY_121, endOfDay('2026-03-12'), STATUS);
    const d13 = resolveHistoricalRemaining(PAY_121, endOfDay('2026-03-13'), STATUS);
    expect(d13.seconds).toBe(d12.seconds);
    expect(d13.rule).toBe(2);
  });
});

describe('từng quy tắc', () => {
  it('Sub-task đã Done thì còn lại 0, kể cả khi Jira còn sót số dư', () => {
    const s = sub({
      changelog: [
        ev('timeestimate', String(25 * H), '2026-03-10T03:00:00Z'),
        ev('status', '10001', '2026-03-11T03:00:00Z'),
      ],
    });
    const r = resolveHistoricalRemaining(s, endOfDay('2026-03-12'), STATUS);
    expect(r.seconds).toBe(0);
    expect(r.rule).toBe(1);
  });

  it('có changelog timeestimate thì lấy giá trị mới nhất, bỏ qua phép trừ', () => {
    const s = sub({
      changelog: [
        ev('timeestimate', String(30 * H), '2026-03-10T03:00:00Z'),
        ev('timeestimate', String(20 * H), '2026-03-11T03:00:00Z'),
      ],
      worklogs: [wl(100 * H, '2026-03-09T02:00:00Z')],
    });
    expect(resolveHistoricalRemaining(s, endOfDay('2026-03-12'), STATUS).seconds).toBe(20 * H);
  });

  it('lấy giá trị MỚI NHẤT, không phải giá trị ĐẦU TIÊN', () => {
    const s = sub({
      changelog: [
        ev('timeestimate', String(30 * H), '2026-03-10T03:00:00Z'),
        ev('timeestimate', String(5 * H), '2026-03-11T03:00:00Z'),
      ],
    });
    expect(resolveHistoricalRemaining(s, endOfDay('2026-03-12'), STATUS).seconds).toBe(5 * H);
  });

  it('không có changelog timeestimate thì lấy Original Estimate trừ giờ đã log', () => {
    const s = sub({ worklogs: [wl(15 * H, '2026-03-10T02:00:00Z')] });
    const r = resolveHistoricalRemaining(s, endOfDay('2026-03-11'), STATUS);
    expect(r.seconds).toBe(25 * H);
    expect(r.rule).toBe(3);
    expect(r.originalEstimateSeconds).toBe(40 * H);
    expect(r.spentSeconds).toBe(15 * H);
  });
});

describe('thứ tự ưu tiên', () => {
  it('Done thắng cả khi có changelog timeestimate khác 0', () => {
    const s = sub({
      changelog: [
        ev('status', '10001', '2026-03-10T03:00:00Z'),
        ev('timeestimate', String(30 * H), '2026-03-11T03:00:00Z'),
      ],
    });
    expect(resolveHistoricalRemaining(s, endOfDay('2026-03-12'), STATUS).rule).toBe(1);
  });

  it('Sub-task Done rồi mở lại thì mốc sau khi mở lại KHÔNG còn trả 0', () => {
    const s = sub({
      changelog: [
        ev('status', '10001', '2026-03-10T03:00:00Z'),
        ev('status', '3', '2026-03-12T03:00:00Z'), // mở lại
      ],
      worklogs: [wl(10 * H, '2026-03-09T02:00:00Z')],
    });
    expect(resolveHistoricalRemaining(s, endOfDay('2026-03-11'), STATUS).seconds).toBe(0);

    const after = resolveHistoricalRemaining(s, endOfDay('2026-03-13'), STATUS);
    expect(after.rule).toBe(3);
    expect(after.seconds).toBe(30 * H);
  });
});

describe('biên', () => {
  it('log giờ vượt Original Estimate thì trả 0, KHÔNG trả số âm', () => {
    const s = sub({ worklogs: [wl(50 * H, '2026-03-10T02:00:00Z')] });
    expect(resolveHistoricalRemaining(s, endOfDay('2026-03-11'), STATUS).seconds).toBe(0);
  });

  it('timeestimate âm được kẹp về 0', () => {
    const s = sub({ changelog: [ev('timeestimate', '-3600', '2026-03-10T03:00:00Z')] });
    expect(resolveHistoricalRemaining(s, endOfDay('2026-03-11'), STATUS).seconds).toBe(0);
  });

  it('timeestimate bị xoá trắng thành null thì rơi xuống quy tắc 3, KHÔNG hiểu là 0', () => {
    const s = sub({
      changelog: [
        ev('timeestimate', String(30 * H), '2026-03-10T03:00:00Z'),
        ev('timeestimate', null, '2026-03-11T03:00:00Z'), // xoá trắng
      ],
      worklogs: [wl(5 * H, '2026-03-09T02:00:00Z')],
    });
    const r = resolveHistoricalRemaining(s, endOfDay('2026-03-12'), STATUS);
    expect(r.rule).toBe(3);
    expect(r.seconds).toBe(35 * H);
  });

  it('chuỗi rỗng cũng được coi là xoá trắng, KHÔNG phải đặt về 0', () => {
    // `Number('')` cho ra 0 chứ không phải NaN — đây là cái bẫy
    const s = sub({
      changelog: [
        ev('timeestimate', String(30 * H), '2026-03-10T03:00:00Z'),
        ev('timeestimate', '', '2026-03-11T03:00:00Z'),
      ],
    });
    const r = resolveHistoricalRemaining(s, endOfDay('2026-03-12'), STATUS);
    expect(r.rule).toBe(3);
    expect(r.seconds).toBe(40 * H);
  });

  it('timeestimate đặt về đúng 0 KHÁC với xoá trắng', () => {
    const s = sub({ changelog: [ev('timeestimate', '0', '2026-03-10T03:00:00Z')] });
    const r = resolveHistoricalRemaining(s, endOfDay('2026-03-11'), STATUS);
    expect(r.rule).toBe(2); // vẫn là quy tắc 2, không rơi xuống 3
    expect(r.seconds).toBe(0);
  });

  it('sự kiện changelog sau mốc T bị bỏ qua', () => {
    const s = sub({ changelog: [ev('timeestimate', String(5 * H), '2026-03-20T03:00:00Z')] });
    expect(resolveHistoricalRemaining(s, endOfDay('2026-03-10'), STATUS).rule).toBe(3);
  });

  it('worklog có started sau mốc T bị bỏ qua', () => {
    const s = sub({ worklogs: [wl(10 * H, '2026-03-20T02:00:00Z')] });
    expect(resolveHistoricalRemaining(s, endOfDay('2026-03-10'), STATUS).seconds).toBe(40 * H);
  });

  it('worklog đã bị xoá không được cộng vào', () => {
    const s = sub({
      worklogs: [wl(8 * H, '2026-03-10T02:00:00Z'), wl(8 * H, '2026-03-10T03:00:00Z', true)],
    });
    expect(totalSpentTill(s, endOfDay('2026-03-11'))).toBe(8 * H);
  });
});

describe('Original Estimate đổi giữa chừng', () => {
  it('Original Estimate bị sửa từ 40 lên 60 thì mốc trước khi sửa vẫn dùng 40', () => {
    const s = sub({
      originalEstimateSeconds: 60 * H,
      changelog: [
        ev('timeoriginalestimate', String(60 * H), '2026-03-15T03:00:00Z', String(40 * H)),
      ],
    });
    expect(resolveOriginalEstimateAt(s, endOfDay('2026-03-10')).seconds).toBe(40 * H);
    expect(resolveOriginalEstimateAt(s, endOfDay('2026-03-16')).seconds).toBe(60 * H);
  });

  it('lịch sử Original Estimate không được để cả biểu đồ tự viết lại', () => {
    const s = sub({
      originalEstimateSeconds: 60 * H,
      changelog: [
        ev('timeoriginalestimate', String(60 * H), '2026-03-15T03:00:00Z', String(40 * H)),
      ],
      worklogs: [wl(10 * H, '2026-03-09T02:00:00Z')],
    });
    expect(resolveHistoricalRemaining(s, endOfDay('2026-03-10'), STATUS).seconds).toBe(30 * H);
  });

  it('không có changelog Original Estimate thì dùng giá trị hiện tại và cảnh báo', () => {
    const codes: string[] = [];
    const r = resolveOriginalEstimateAt(sub(), endOfDay('2026-03-10'), (c) => codes.push(c));
    expect(r.seconds).toBe(40 * H);
    expect(r.fromCurrentValue).toBe(true);
    expect(codes).toContain('ESTIMATE_HISTORY_MISSING');
  });

  it('có changelog Original Estimate thì KHÔNG cảnh báo', () => {
    const codes: string[] = [];
    const s = sub({
      changelog: [ev('timeoriginalestimate', String(40 * H), '2026-03-01T03:00:00Z')],
    });
    resolveOriginalEstimateAt(s, endOfDay('2026-03-10'), (c) => codes.push(c));
    expect(codes).not.toContain('ESTIMATE_HISTORY_MISSING');
  });
});

describe('giờ đã log trong một khoảng', () => {
  it('spentBetween chỉ cộng worklog nằm trong khoảng', () => {
    const worklogs = [
      wl(1 * H, '2026-03-09T02:00:00Z'),
      wl(2 * H, '2026-03-10T02:00:00Z'),
      wl(4 * H, '2026-03-11T02:00:00Z'),
    ];
    const from = at('2026-03-09T17:00:00Z'); // 00:00 ngày 10/03 giờ VN
    const to = endOfDay('2026-03-10');
    expect(spentBetween(worklogs, from, to)).toBe(2 * H);
  });
});

describe('câu giải thích cho API /explain', () => {
  it('mỗi quy tắc có câu giải thích tiếng Việt riêng', () => {
    const done = explainRule({ seconds: 0, rule: 1 });
    const explicit = explainRule({
      seconds: 30 * H,
      rule: 2,
      explicitEstimate: { seconds: 30 * H, atMs: 0 },
    });
    const derived = explainRule({
      seconds: 25 * H,
      rule: 3,
      originalEstimateSeconds: 40 * H,
      spentSeconds: 15 * H,
    });

    expect(done).toContain('Rule 1');
    expect(explicit).toContain('30');
    expect(derived).toContain('40');
    expect(derived).toContain('15');
    expect(new Set([done, explicit, derived]).size).toBe(3);
  });
});
