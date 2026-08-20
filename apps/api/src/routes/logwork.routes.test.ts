import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LogworkResponse, Principal, WorkCalendar } from '@app/shared';
import { endOfDayUtcMs, startOfDayUtcMs } from '@app/engine';
import {
  registerLogworkRoutes,
  type LogworkReadPort,
  type LogworkWritePort,
  type VisibleEpic,
} from './logwork.routes.js';
import type {
  LoadedLogworkSubtask,
  LogworkExemptionRow,
  WorklogDailyRow,
  WorklogSumRow,
} from '../services/logwork.service.js';

const ADMIN: Principal = { userId: 'admin', role: 'ADMIN', projects: [] };
// 2026-08-19 là Thứ Tư; giờ VN tuần chứa nó là 2026-08-17 (T2) .. 2026-08-23 (CN).
const NOW = new Date('2026-08-19T03:00:00.000Z');
const TZ = 'Asia/Ho_Chi_Minh';

const vnCalendar: WorkCalendar = {
  calendarId: 'VN',
  timezone: TZ,
  workdaysMask: 31,
  hoursPerDay: 8,
  holidays: new Set(),
  makeupWorkdays: new Set(),
  warnings: [],
};

class FakeReads implements LogworkReadPort {
  epics: VisibleEpic[] = [{ epicKey: 'PAY-1', projectKey: 'PAY', calendarId: 'VN', expectedHoursPerDay: null }];
  /** Mọi Epic đang theo dõi (by-pic dùng cái này, không lọc quyền). Mặc định = epics. */
  allEpics: VisibleEpic[] = [{ epicKey: 'PAY-1', projectKey: 'PAY', calendarId: 'VN', expectedHoursPerDay: null }];
  cal: WorkCalendar = vnCalendar;
  subs: LoadedLogworkSubtask[] = [];
  sums: WorklogSumRow[] = [];
  daily: WorklogDailyRow[] = [];
  exempt: LogworkExemptionRow[] = [];
  projectHoursMap = new Map<string, number | null>();
  visibleArg: readonly string[] | null | undefined = undefined;
  worklogCalls: { keys: readonly string[]; startMs: number; endMs: number }[] = [];
  dailyCalls: { startMs: number; endMs: number; tz: string }[] = [];

  async visibleEpics(projectKeys: readonly string[] | null) {
    this.visibleArg = projectKeys;
    return this.epics;
  }
  async allTrackedEpics() {
    return this.allEpics;
  }
  async calendars(ids: readonly string[]) {
    const m = new Map<string, WorkCalendar>();
    for (const id of ids) m.set(id, this.cal);
    return m;
  }
  async openSubtasks() {
    return this.subs;
  }
  async worklogSums(keys: readonly string[], startMs: number, endMs: number) {
    this.worklogCalls.push({ keys, startMs, endMs });
    return this.sums;
  }
  async worklogDailyByAuthor(startMs: number, endMs: number, tz: string) {
    this.dailyCalls.push({ startMs, endMs, tz });
    return this.daily;
  }
  async exemptionsForEpics() {
    return this.exempt;
  }
  async projectHours(projectKeys: readonly string[]) {
    const m = new Map<string, number | null>();
    for (const k of projectKeys) m.set(k, this.projectHoursMap.get(k) ?? null);
    return m;
  }
}

class FakeWrites implements LogworkWritePort {
  issueLoc: { epicKey: string; projectKey: string } | null = { epicKey: 'PAY-1', projectKey: 'PAY' };
  upserts: Array<{ accountId: string; issueKey: string; projectKey: string; exemptedBy: string }> = [];
  deletes: Array<{ accountId: string; issueKey: string }> = [];
  hoursSet: Array<{ projectKey: string; hours: number | null }> = [];

  async issueEpicProject() {
    return this.issueLoc;
  }
  async upsertExemption(args: {
    accountId: string;
    issueKey: string;
    epicKey: string;
    projectKey: string;
    exemptedBy: string;
    note: string | null;
  }) {
    this.upserts.push({
      accountId: args.accountId,
      issueKey: args.issueKey,
      projectKey: args.projectKey,
      exemptedBy: args.exemptedBy,
    });
  }
  async deleteExemption(accountId: string, issueKey: string) {
    this.deletes.push({ accountId, issueKey });
  }
  async setProjectHours(projectKey: string, hours: number | null) {
    this.hoursSet.push({ projectKey, hours });
  }
}

let reads: FakeReads;
let writes: FakeWrites;
let app: FastifyInstance;
let principal: Principal | null;

beforeEach(async () => {
  reads = new FakeReads();
  writes = new FakeWrites();
  principal = ADMIN;
  app = Fastify();
  registerLogworkRoutes(app, { reads, writes, resolvePrincipal: () => principal, now: () => NOW });
  await app.ready();
});

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as LogworkResponse & { error?: string } };
}

async function send(method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) {
  const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  return { status: res.statusCode, body: res.json() as { error?: string; ok?: boolean } };
}

const PM_PAY: Principal = { userId: 'pm', role: 'PM', projects: ['PAY'] };
const PM_OTHER: Principal = { userId: 'pm2', role: 'PM', projects: ['CRM'] };
const VIEWER: Principal = { userId: 'v', role: 'VIEWER', projects: [] };

describe('GET /api/logwork', () => {
  it('không có tham số → mặc định tuần chứa hôm nay (theo múi giờ Epic)', async () => {
    reads.subs = [
      {
        issueKey: 'PAY-11',
        epicKey: 'PAY-1',
        summary: 'x',
        parentKey: null,
        phaseCode: 'DEV',
        statusCategory: 'indeterminate',
        originalEstimateSeconds: 3600,
        participants: [{ accountId: 'a', displayName: 'Alice' }],
      },
    ];
    const { status, body } = await get('/api/logwork');
    expect(status).toBe(200);
    expect(body.from).toBe('2026-08-17');
    expect(body.to).toBe('2026-08-23');
    // Kỳ bao gồm hôm nay (19) → prorate.
    expect(body.partialPeriod).toBe(true);
    expect(body.visibleEpicCount).toBe(1);
    expect(body.hasParticipantData).toBe(true);
    expect(body.members.map((m) => m.accountId)).toContain('a');
  });

  it('cửa sổ worklog tính đúng theo múi giờ Epic', async () => {
    await get('/api/logwork');
    expect(reads.worklogCalls).toHaveLength(1);
    expect(reads.worklogCalls[0]?.keys).toEqual(['PAY-1']);
    expect(reads.worklogCalls[0]?.startMs).toBe(startOfDayUtcMs('2026-08-17', TZ));
    expect(reads.worklogCalls[0]?.endMs).toBe(endOfDayUtcMs('2026-08-23', TZ));
  });

  it('kỳ đã kết thúc (from/to trong quá khứ) → không prorate', async () => {
    const { body } = await get('/api/logwork?from=2026-08-10&to=2026-08-16');
    expect(body.from).toBe('2026-08-10');
    expect(body.to).toBe('2026-08-16');
    expect(body.partialPeriod).toBe(false);
  });

  it('thiếu người dùng → 401', async () => {
    principal = null;
    expect((await get('/api/logwork')).status).toBe(401);
  });

  it('PM chỉ hỏi project mình phụ trách', async () => {
    principal = { userId: 'pm', role: 'PM', projects: ['PAY', 'CRM'] };
    await get('/api/logwork');
    expect(reads.visibleArg).toEqual(['PAY', 'CRM']);
  });

  it('ADMIN/VIEWER hỏi tất cả (projectKeys = null)', async () => {
    principal = ADMIN;
    await get('/api/logwork');
    expect(reads.visibleArg).toBeNull();

    principal = { userId: 'v', role: 'VIEWER', projects: [] };
    await get('/api/logwork');
    expect(reads.visibleArg).toBeNull();
  });

  it('from sai định dạng → 400', async () => {
    expect((await get('/api/logwork?from=2026-8-1&to=2026-08-16')).status).toBe(400);
  });

  it('to < from → 400', async () => {
    expect((await get('/api/logwork?from=2026-08-16&to=2026-08-10')).status).toBe(400);
  });

  it('chỉ có một trong hai from/to → 400', async () => {
    expect((await get('/api/logwork?from=2026-08-10')).status).toBe(400);
  });

  it('PM không có Epic nào → 200 rỗng, vẫn có khoảng thời gian hợp lệ', async () => {
    principal = { userId: 'pm', role: 'PM', projects: ['NONE'] };
    reads.epics = [];
    const { status, body } = await get('/api/logwork');
    expect(status).toBe(200);
    expect(body.visibleEpicCount).toBe(0);
    expect(body.members).toEqual([]);
    expect(body.from).toBe('2026-08-17');
    expect(body.to).toBe('2026-08-23');
  });
});

interface ByPicBody {
  from: string;
  to: string;
  dates: string[];
  rows: { accountId: string; displayName: string | null; hoursByDate: number[]; totalHours: number; warnCount: number }[];
  dailyTotals: number[];
  grandTotal: number;
  underLimitHours: number;
  overLimitHours: number;
  warnings: string[];
  error?: string;
}

async function getByPic(url: string): Promise<{ status: number; body: ByPicBody }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as ByPicBody };
}

describe('GET /api/logwork/by-pic', () => {
  it('không tham số → mặc định tuần chứa hôm nay, cột là từng ngày lịch', async () => {
    const { status, body } = await getByPic('/api/logwork/by-pic');
    expect(status).toBe(200);
    expect(body.from).toBe('2026-08-17');
    expect(body.to).toBe('2026-08-23');
    // 7 ngày lịch (kể cả cuối tuần).
    expect(body.dates).toEqual([
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
    ]);
    expect(body.underLimitHours).toBe(4);
    expect(body.overLimitHours).toBe(8);
  });

  it('cửa sổ worklog theo NGÀY tính đúng múi giờ Epic', async () => {
    await getByPic('/api/logwork/by-pic');
    expect(reads.dailyCalls).toHaveLength(1);
    expect(reads.dailyCalls[0]?.tz).toBe(TZ);
    expect(reads.dailyCalls[0]?.startMs).toBe(startOfDayUtcMs('2026-08-17', TZ));
    expect(reads.dailyCalls[0]?.endMs).toBe(endOfDayUtcMs('2026-08-23', TZ));
  });

  it('bày giờ vào đúng cột ngày; tô cảnh báo <=4h / >8h; tổng hàng + cột', async () => {
    reads.subs = [
      {
        issueKey: 'PAY-11',
        epicKey: 'PAY-1',
        summary: 'x',
        parentKey: null,
        phaseCode: 'DEV',
        statusCategory: 'indeterminate',
        originalEstimateSeconds: 3600,
        participants: [
          { accountId: 'a', displayName: 'Alice' },
          { accountId: 'b', displayName: 'Bob' },
        ],
      },
    ];
    reads.daily = [
      { authorId: 'a', localDate: '2026-08-17', seconds: 3 * 3600 }, // thiếu (<=4)
      { authorId: 'a', localDate: '2026-08-18', seconds: 6 * 3600 }, // ổn
      { authorId: 'a', localDate: '2026-08-19', seconds: 9 * 3600 }, // quá (>8)
      { authorId: 'b', localDate: '2026-08-17', seconds: 8 * 3600 }, // 8 chẵn = ổn
    ];

    const { body } = await getByPic('/api/logwork/by-pic');
    // Xếp theo tên: Alice rồi Bob.
    expect(body.rows.map((r) => r.accountId)).toEqual(['a', 'b']);

    const alice = body.rows[0]!;
    expect(alice.displayName).toBe('Alice');
    expect(alice.hoursByDate).toEqual([3, 6, 9, 0, 0, 0, 0]);
    expect(alice.totalHours).toBe(18);
    expect(alice.warnCount).toBe(2); // 17 (thiếu) + 19 (quá)

    const bob = body.rows[1]!;
    expect(bob.hoursByDate).toEqual([8, 0, 0, 0, 0, 0, 0]);
    expect(bob.warnCount).toBe(0);

    expect(body.dailyTotals).toEqual([11, 6, 9, 0, 0, 0, 0]);
    expect(body.grandTotal).toBe(26);
  });

  it('worklog không rõ tác giả (authorId=null) không tạo hàng', async () => {
    reads.daily = [{ authorId: null, localDate: '2026-08-17', seconds: 5 * 3600 }];
    const { body } = await getByPic('/api/logwork/by-pic');
    expect(body.rows).toEqual([]);
    expect(body.grandTotal).toBe(0);
  });

  it('KHÔNG lọc quyền: PM project khác vẫn thấy toàn bộ (không gọi visibleEpics)', async () => {
    principal = { userId: 'pm', role: 'PM', projects: ['OTHER'] };
    reads.daily = [{ authorId: 'a', localDate: '2026-08-19', seconds: 6 * 3600 }];
    const { status, body } = await getByPic('/api/logwork/by-pic');
    expect(status).toBe(200);
    expect(body.rows.map((r) => r.accountId)).toEqual(['a']);
    // by-pic KHÔNG đi qua cổng lọc theo project.
    expect(reads.visibleArg).toBeUndefined();
  });

  it('không Epic đang theo dõi nhưng còn worklog mồ côi → vẫn hiện', async () => {
    reads.allEpics = [];
    reads.daily = [{ authorId: 'a', localDate: '2026-08-19', seconds: 5 * 3600 }];
    const { status, body } = await getByPic('/api/logwork/by-pic');
    expect(status).toBe(200);
    // Không Epic → múi giờ mặc định (Asia/Ho_Chi_Minh), tuần chứa hôm nay.
    expect(body.from).toBe('2026-08-17');
    expect(body.dates).toHaveLength(7);
    expect(body.rows.map((r) => r.accountId)).toEqual(['a']);
    expect(reads.dailyCalls).toHaveLength(1); // vẫn quét worklog dù không có Epic
  });

  it('thiếu người dùng → 401', async () => {
    principal = null;
    expect((await getByPic('/api/logwork/by-pic')).status).toBe(401);
  });

  it('to < from → 400', async () => {
    expect((await getByPic('/api/logwork/by-pic?from=2026-08-16&to=2026-08-10')).status).toBe(400);
  });
});

describe('verify (exemption) + cấu hình giờ/ngày', () => {
  it('POST exemption: ADMIN đánh dấu được, ghi đúng người + project (server tự tra)', async () => {
    const { status } = await send('POST', '/api/logwork/exemptions', { accountId: 'a', issueKey: 'PAY-11' });
    expect(status).toBe(200);
    expect(writes.upserts).toHaveLength(1);
    expect(writes.upserts[0]).toMatchObject({
      accountId: 'a',
      issueKey: 'PAY-11',
      projectKey: 'PAY',
      exemptedBy: 'admin',
    });
  });

  it('POST exemption: PM đúng project 200, PM khác project 403, VIEWER 403', async () => {
    principal = PM_PAY;
    expect((await send('POST', '/api/logwork/exemptions', { accountId: 'a', issueKey: 'PAY-11' })).status).toBe(200);
    principal = PM_OTHER;
    expect((await send('POST', '/api/logwork/exemptions', { accountId: 'a', issueKey: 'PAY-11' })).status).toBe(403);
    principal = VIEWER;
    expect((await send('POST', '/api/logwork/exemptions', { accountId: 'a', issueKey: 'PAY-11' })).status).toBe(403);
  });

  it('POST exemption: ticket không có trong sổ → 404; thiếu accountId → 400', async () => {
    writes.issueLoc = null;
    expect((await send('POST', '/api/logwork/exemptions', { accountId: 'a', issueKey: 'X-9' })).status).toBe(404);
    expect((await send('POST', '/api/logwork/exemptions', { issueKey: 'PAY-11' })).status).toBe(400);
  });

  it('DELETE exemption: ADMIN gỡ được; thiếu tham số → 400; PM khác project → 403', async () => {
    expect((await send('DELETE', '/api/logwork/exemptions?accountId=a&issueKey=PAY-11')).status).toBe(200);
    expect(writes.deletes[0]).toEqual({ accountId: 'a', issueKey: 'PAY-11' });
    expect((await send('DELETE', '/api/logwork/exemptions?issueKey=PAY-11')).status).toBe(400);
    principal = PM_OTHER;
    expect((await send('DELETE', '/api/logwork/exemptions?accountId=a&issueKey=PAY-11')).status).toBe(403);
  });

  it('PUT settings: PM sửa project mình 200, project khác 403, VIEWER 403', async () => {
    principal = PM_PAY;
    expect((await send('PUT', '/api/logwork/settings/PAY', { expectedHoursPerDay: 7 })).status).toBe(200);
    expect(writes.hoursSet[0]).toEqual({ projectKey: 'PAY', hours: 7 });
    principal = PM_OTHER;
    expect((await send('PUT', '/api/logwork/settings/PAY', { expectedHoursPerDay: 7 })).status).toBe(403);
    principal = VIEWER;
    expect((await send('PUT', '/api/logwork/settings/PAY', { expectedHoursPerDay: 7 })).status).toBe(403);
  });

  it('PUT settings: null (reset) hợp lệ; số ngoài (0, 24] → 400', async () => {
    expect((await send('PUT', '/api/logwork/settings/PAY', { expectedHoursPerDay: null })).status).toBe(200);
    expect((await send('PUT', '/api/logwork/settings/PAY', { expectedHoursPerDay: 0 })).status).toBe(400);
    expect((await send('PUT', '/api/logwork/settings/PAY', { expectedHoursPerDay: 25 })).status).toBe(400);
  });

  it('GET settings: liệt kê project thấy được kèm cờ canEdit + giờ hiện tại', async () => {
    reads.epics = [
      { epicKey: 'PAY-1', projectKey: 'PAY', calendarId: 'VN', expectedHoursPerDay: null },
      { epicKey: 'CRM-1', projectKey: 'CRM', calendarId: 'VN', expectedHoursPerDay: null },
    ];
    reads.projectHoursMap.set('CRM', 7);
    principal = PM_PAY;
    const res = await app.inject({ method: 'GET', url: '/api/logwork/settings' });
    const body = res.json() as {
      defaultHoursPerDay: number;
      projects: { projectKey: string; expectedHoursPerDay: number | null; canEdit: boolean }[];
    };
    expect(res.statusCode).toBe(200);
    expect(body.defaultHoursPerDay).toBe(8);
    const pay = body.projects.find((p) => p.projectKey === 'PAY')!;
    const crm = body.projects.find((p) => p.projectKey === 'CRM')!;
    expect(pay.canEdit).toBe(true);
    expect(crm.canEdit).toBe(false);
    expect(crm.expectedHoursPerDay).toBe(7);
  });
});
