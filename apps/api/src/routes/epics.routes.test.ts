import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  RECOMPUTE_SECONDS_PER_EPIC,
  addEpicsResponseSchema,
  type Principal,
  type TrackedEpicStatus,
} from '@app/shared';
import { registerEpicRoutes } from './epics.routes.js';
import { assertTransition } from '../services/epic-registry.service.js';
import {
  FakeBackfillQueue,
  FakeJiraEpicPort,
  FakeTrackedEpicStore,
  jiraEpic,
  type FakeEpicRow,
} from '../test-fakes.js';

const ADMIN: Principal = { userId: 'admin@x.com', role: 'ADMIN', projects: [] };
const VIEWER: Principal = { userId: 'v@x.com', role: 'VIEWER', projects: [] };

const JIRA = new Map([
  ['PAY-100', jiraEpic('PAY-100', { displayName: 'Cổng thanh toán', missingWbsDateCount: 2 })],
  ['PAY-200', jiraEpic('PAY-200')],
  ['PAY-300', jiraEpic('PAY-300', { phaseCount: 0, subtaskCount: 0 })],
  ['PAY-7', jiraEpic('PAY-7', { issueType: 'Task' })],
  ['CRM-7', jiraEpic('CRM-7')],
  ['HR-1', { ok: false as const, reason: 'NO_PERMISSION' as const }],
]);

let store: FakeTrackedEpicStore;
let backfill: FakeBackfillQueue;
let principal: Principal | null;
let app: FastifyInstance;

function build(seed: readonly FakeEpicRow[] = []): FastifyInstance {
  store = new FakeTrackedEpicStore(seed);
  backfill = new FakeBackfillQueue();
  const instance = Fastify({ logger: false });
  registerEpicRoutes(instance, {
    store,
    backfill,
    jira: new FakeJiraEpicPort(JIRA),
    resolvePrincipal: () => principal,
  });
  return instance;
}

const epic = (epicKey: string, status: TrackedEpicStatus, over: Partial<FakeEpicRow> = {}): FakeEpicRow => ({
  epicKey,
  status,
  projectKey: epicKey.split('-')[0]!,
  displayName: `Epic ${epicKey}`,
  timezone: 'Asia/Ho_Chi_Minh',
  calendarId: 'VN_MON_FRI',
  note: null,
  ...over,
});

beforeEach(() => {
  principal = ADMIN;
  app = build([epic('CRM-7', 'ACTIVE')]);
});

const addBody = (keys: string[]) => ({
  method: 'POST' as const,
  url: '/api/epics',
  payload: { keys, timezone: 'Asia/Ho_Chi_Minh', calendarId: 'VN_MON_FRI' },
});

describe('kiểm tra khi thêm', () => {
  it('dán 4 key trong đó 1 Task, 1 đã theo dõi, 2 hợp lệ thì trả đúng kết quả từng dòng', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/epics/validate',
      payload: { keys: ['PAY-100', 'PAY-7', 'CRM-7', 'PAY-200'] },
    });
    const body = res.json();

    expect(body.summary).toEqual({ valid: 2, invalid: 2, canAdd: 2 });
    expect(body.results.map((r: { key: string; valid: boolean }) => [r.key, r.valid])).toEqual([
      ['PAY-100', true],
      ['PAY-7', false],
      ['CRM-7', false],
      ['PAY-200', true],
    ]);
    expect(body.results[0]).toMatchObject({
      displayName: 'Cổng thanh toán',
      projectKey: 'PAY',
      phaseCount: 3,
      subtaskCount: 25,
      totalEstimateHours: 200,
      missingWbsDateCount: 2,
    });
  });

  it('key là Task chứ không phải Epic thì reason = NOT_AN_EPIC', async () => {
    const body = (await app.inject({ method: 'POST', url: '/api/epics/validate', payload: { keys: ['PAY-7'] } })).json();
    expect(body.results[0]).toMatchObject({ valid: false, reason: 'NOT_AN_EPIC' });
    expect(body.results[0].message).toContain('not an Epic');
  });

  it('key không tồn tại trên Jira thì reason = NOT_FOUND', async () => {
    const body = (await app.inject({ method: 'POST', url: '/api/epics/validate', payload: { keys: ['PAY-999'] } })).json();
    expect(body.results[0]).toMatchObject({ valid: false, reason: 'NOT_FOUND' });
  });

  it('không có quyền đọc project thì reason = NO_PERMISSION', async () => {
    const body = (await app.inject({ method: 'POST', url: '/api/epics/validate', payload: { keys: ['HR-1'] } })).json();
    expect(body.results[0]).toMatchObject({ valid: false, reason: 'NO_PERMISSION' });
  });

  it('Epic đã theo dõi thì reason = ALREADY_TRACKED và KHÔNG bị thêm lần hai', async () => {
    const before = store.rows.size;
    const res = await app.inject(addBody(['CRM-7']));
    expect(res.json().results[0]).toMatchObject({ valid: false, reason: 'ALREADY_TRACKED' });
    expect(res.json().added).toEqual([]);
    expect(res.json().skipped).toEqual(['CRM-7']);
    expect(store.rows.size).toBe(before);
    expect(backfill.enqueued).toEqual([]);
  });

  it('Epic không có Task con vẫn được thêm, kèm cảnh báo', async () => {
    const res = await app.inject(addBody(['PAY-300']));
    const row = res.json().results[0];
    expect(row.valid).toBe(true);
    expect(row.warnings).toContain('NO_CHILD_TASK');
    expect(store.rows.has('PAY-300')).toBe(true);
  });

  it('Epic thiếu ngày wbs_* vẫn thêm được nhưng có cảnh báo MISSING_WBS_DATES', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/epics/validate', payload: { keys: ['PAY-100'] } });
    expect(res.json().results[0].warnings).toContain('MISSING_WBS_DATES');
  });

  it('key trùng nhau trong cùng một lần dán chỉ xét một lần', async () => {
    const body = (await app.inject({
      method: 'POST',
      url: '/api/epics/validate',
      payload: { keys: ['PAY-100', 'PAY-100', ' PAY-100 '] },
    })).json();
    expect(body.results).toHaveLength(1);
  });
});

describe('vòng đời', () => {
  it('thêm thành công đặt status = PENDING và đẩy job backfill', async () => {
    const res = await app.inject(addBody(['PAY-100', 'PAY-200']));
    expect(res.statusCode).toBe(200);
    // Thân phản hồi phải qua được đúng schema mà frontend kiểm tại biên —
    // chính chỗ từng vỡ với RESPONSE_SHAPE_INVALID.
    const body = addEpicsResponseSchema.parse(res.json());
    expect(body.added).toEqual(['PAY-100', 'PAY-200']);
    expect(body.skipped).toEqual([]);
    expect(body.estimatedSeconds).toBe(2 * RECOMPUTE_SECONDS_PER_EPIC);
    expect(store.rows.get('PAY-100')!.status).toBe('PENDING');
    expect(backfill.enqueued.sort()).toEqual(['PAY-100', 'PAY-200']);
  });

  it('chuyển PENDING → ACTIVE trực tiếp bị từ chối', async () => {
    // Bỏ qua BACKFILLING nghĩa là Epic vào job đêm khi chưa có lịch sử
    expect(() => assertTransition('PENDING', 'ACTIVE')).toThrow(/cannot go from/i);

    const local = build([epic('PAY-100', 'PENDING')]);
    const res = await local.inject({ method: 'PATCH', url: '/api/epics/PAY-100', payload: { status: 'ACTIVE' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INVALID_TRANSITION');
    expect(store.rows.get('PAY-100')!.status).toBe('PENDING');
  });

  it('chuyển ACTIVE → PAUSED rồi PAUSED → ACTIVE đều hợp lệ', async () => {
    const local = build([epic('PAY-100', 'ACTIVE')]);
    expect((await local.inject({ method: 'PATCH', url: '/api/epics/PAY-100', payload: { status: 'PAUSED' } })).statusCode).toBe(200);
    expect(store.rows.get('PAY-100')!.status).toBe('PAUSED');
    expect((await local.inject({ method: 'PATCH', url: '/api/epics/PAY-100', payload: { status: 'ACTIVE' } })).statusCode).toBe(200);
    expect(store.rows.get('PAY-100')!.status).toBe('ACTIVE');
  });

  it('chuyển PAUSED → BACKFILLING bị từ chối', async () => {
    const local = build([epic('PAY-100', 'PAUSED')]);
    const res = await local.inject({ method: 'PATCH', url: '/api/epics/PAY-100', payload: { status: 'BACKFILLING' } });
    expect(res.statusCode).toBe(409);
  });

  it('job đêm chỉ lấy Epic ACTIVE', () => {
    build([
      epic('E-1', 'PENDING'),
      epic('E-2', 'BACKFILLING'),
      epic('E-3', 'ACTIVE'),
      epic('E-4', 'PAUSED'),
      epic('E-5', 'ERROR'),
    ]);
    expect(store.listActive()).toEqual(['E-3']);
  });

  it('máy trạng thái cho phép ERROR → BACKFILLING nhưng chặn ERROR → ACTIVE', () => {
    expect(() => assertTransition('ERROR', 'BACKFILLING')).not.toThrow();
    expect(() => assertTransition('ERROR', 'ACTIVE')).toThrow();
  });

  it('chuyển sang chính nó không bị coi là lỗi', () => {
    expect(() => assertTransition('ACTIVE', 'ACTIVE')).not.toThrow();
  });
});

describe('bỏ theo dõi', () => {
  it('xoá với purge=false giữ nguyên dữ liệu lịch sử', async () => {
    const local = build([epic('PAY-100', 'ACTIVE', { historyRows: 120 })]);
    const res = await local.inject({ method: 'DELETE', url: '/api/epics/PAY-100?purge=false' });
    expect(res.statusCode).toBe(200);
    expect(store.rows.has('PAY-100')).toBe(false);
    expect(store.history.get('PAY-100')).toBe(120); // lịch sử còn nguyên
  });

  it('xoá với purge=true xoá sạch mọi dữ liệu của Epic đó', async () => {
    const local = build([epic('PAY-100', 'ACTIVE', { historyRows: 120 })]);
    const res = await local.inject({
      method: 'DELETE',
      url: '/api/epics/PAY-100?purge=true',
      payload: { confirmKey: 'PAY-100' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.rows.has('PAY-100')).toBe(false);
    expect(store.history.has('PAY-100')).toBe(false);
  });

  it('purge=true mà KHÔNG gõ lại đúng key thì bị chặn và không xoá gì', async () => {
    const local = build([epic('PAY-100', 'ACTIVE', { historyRows: 120 })]);
    const res = await local.inject({ method: 'DELETE', url: '/api/epics/PAY-100?purge=true' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CONFIRM_REQUIRED');
    expect(store.rows.has('PAY-100')).toBe(true);
    expect(store.history.get('PAY-100')).toBe(120);
  });

  it('purge=true với key xác nhận SAI cũng bị chặn', async () => {
    const local = build([epic('PAY-100', 'ACTIVE')]);
    const res = await local.inject({
      method: 'DELETE',
      url: '/api/epics/PAY-100?purge=true',
      payload: { confirmKey: 'PAY-101' },
    });
    expect(res.statusCode).toBe(400);
    expect(store.rows.has('PAY-100')).toBe(true);
  });

  it('xoá Epic không có trong sổ trả HTTP 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/epics/KHONG-CO' });
    expect(res.statusCode).toBe(404);
  });
});

describe('danh sách, duyệt và phân quyền', () => {
  it('GET /epics trả đúng số Sub-task thiếu wbs_* trong tình trạng dữ liệu', async () => {
    const local = build([epic('PAY-100', 'ACTIVE', { subtaskCount: 25, missingWbsDateCount: 5 })]);
    const body = (await local.inject({ method: 'GET', url: '/api/epics' })).json();
    expect(body.epics[0].dataHealth).toMatchObject({ subtaskCount: 25, missingWbsDateCount: 5 });
  });

  it('GET /epics/browse phân trang và đánh dấu Epic đã theo dõi', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/epics/browse?project=PAY&startAt=0&maxResults=2' })).json();
    expect(body.items).toHaveLength(2);
    expect(body.maxResults).toBe(2);
    expect(body.total).toBeGreaterThan(2);

    const all = (await app.inject({ method: 'GET', url: '/api/epics/browse?project=PAY&maxResults=100' })).json();
    expect(all.items.find((i: { key: string }) => i.key === 'CRM-7').alreadyTracked).toBe(true);
    expect(all.items.find((i: { key: string }) => i.key === 'PAY-100').alreadyTracked).toBe(false);
  });

  it('GET /epics/browse thiếu tham số project trả HTTP 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/epics/browse' })).statusCode).toBe(400);
  });

  it('GET /missing-dates trả từng Sub-task kèm thiếu ngày nào', async () => {
    const local = build([epic('PAY-100', 'ACTIVE')]);
    store.missingDates.set('PAY-100', [
      { issueKey: 'PAY-131', summary: '[PAY][A][Design][決済履歴]_Create', parentKey: 'PAY-101', missingStart: true, missingEnd: true },
      { issueKey: 'PAY-132', summary: '[PAY][A][Design][Login]_Create', parentKey: 'PAY-101', missingStart: false, missingEnd: true },
    ]);
    const body = (await local.inject({ method: 'GET', url: '/api/epics/PAY-100/missing-dates' })).json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[1]).toMatchObject({ issueKey: 'PAY-132', missingStart: false, missingEnd: true });
  });

  it('PATCH với timezone không hợp lệ bị từ chối HTTP 400', async () => {
    const local = build([epic('PAY-100', 'ACTIVE')]);
    const res = await local.inject({ method: 'PATCH', url: '/api/epics/PAY-100', payload: { timezone: 'UTC+7' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_TIMEZONE');
    expect(store.rows.get('PAY-100')!.timezone).toBe('Asia/Ho_Chi_Minh');
  });

  it('PATCH với timezone IANA hợp lệ được chấp nhận', async () => {
    const local = build([epic('PAY-100', 'ACTIVE')]);
    const res = await local.inject({ method: 'PATCH', url: '/api/epics/PAY-100', payload: { timezone: 'Asia/Tokyo' } });
    expect(res.statusCode).toBe(200);
    expect(store.rows.get('PAY-100')!.timezone).toBe('Asia/Tokyo');
  });

  it('thêm Epic với timezone không hợp lệ bị từ chối và KHÔNG thêm gì', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/epics',
      payload: { keys: ['PAY-100'], timezone: 'Hà Nội', calendarId: 'VN_MON_FRI' },
    });
    expect(res.statusCode).toBe(400);
    expect(store.rows.has('PAY-100')).toBe(false);
    expect(backfill.enqueued).toEqual([]);
  });

  it('người dùng thường không được thêm hay xoá Epic', async () => {
    principal = VIEWER;
    expect((await app.inject(addBody(['PAY-100']))).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/epics/CRM-7' })).statusCode).toBe(403);
    expect(store.rows.has('CRM-7')).toBe(true);
  });

  it('người dùng thường VẪN xem được danh sách', async () => {
    principal = VIEWER;
    expect((await app.inject({ method: 'GET', url: '/api/epics' })).statusCode).toBe(200);
  });
});
