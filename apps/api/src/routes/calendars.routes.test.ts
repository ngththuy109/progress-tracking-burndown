import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CalendarSummary, Holiday, MakeupWorkday, Principal } from '@app/shared';
import { registerCalendarRoutes, type CalendarStore } from './calendars.routes.js';
import { asAdmin, asPm, asViewer, testGuards } from '../test-fakes.js';

/**
 * Test nhóm API lịch làm việc, ngày nghỉ & ngày làm bù — T-36/T-39, multi-tenant.
 *
 * Trọng tâm: phân quyền ba phạm vi (built-in đọc chung / lịch dự án PM sửa /
 * admin sửa built-in), kiểm dữ liệu import (lỗi từng dòng, không ghi nửa
 * chừng), và LAN TRUYỀN sau khi sửa — xoá cache biểu đồ và đánh dấu Epic tính
 * lại. Phần transaction nằm ở repository test.
 */

function summary(calendarId: string): CalendarSummary {
  return {
    calendarId,
    timezone: 'Asia/Ho_Chi_Minh',
    workdaysMask: 31,
    hoursPerDay: 8,
    holidayCount: 1,
    years: [2026],
    makeupWorkdayCount: 1,
    makeupYears: [2026],
  };
}

/** calendarId → chủ sở hữu (null = built-in). */
const OWNERS: Record<string, string | null> = {
  VN_STANDARD: null,
  JP_STANDARD: null,
  PAY_CAL: 'PAY',
  CRM_CAL: 'CRM',
};

class FakeStore implements CalendarStore {
  holidayRows: Holiday[] = [{ date: '2026-02-17', label: 'Tết' }];
  makeupRows: MakeupWorkday[] = [{ date: '2026-04-25', label: 'Làm bù 30/4' }];
  importCalls: unknown[] = [];
  makeupImportCalls: unknown[] = [];
  deleteCalls: string[] = [];
  makeupDeleteCalls: string[] = [];
  deleteResult = 1;
  makeupDeleteResult = 1;
  epics = { all: ['PAY-1', 'PAY-2'], active: ['PAY-1'] };

  async list(forProject: string | null) {
    return Object.entries(OWNERS)
      .filter(([, owner]) => owner === null || owner === forProject)
      .map(([id]) => summary(id));
  }
  async owner(calendarId: string) {
    const owner = OWNERS[calendarId];
    return owner === undefined ? null : { projectKey: owner };
  }
  async holidays() {
    return this.holidayRows;
  }
  async importHolidays(args: unknown) {
    this.importCalls.push(args);
    return { inserted: 2, updated: 1, deleted: 0 };
  }
  async deleteHoliday(_c: string, date: string) {
    this.deleteCalls.push(date);
    return this.deleteResult;
  }
  async makeupWorkdays() {
    return this.makeupRows;
  }
  async importMakeupWorkdays(args: unknown) {
    this.makeupImportCalls.push(args);
    return { inserted: 2, updated: 1, deleted: 0 };
  }
  async deleteMakeupWorkday(_c: string, date: string) {
    this.makeupDeleteCalls.push(date);
    return this.makeupDeleteResult;
  }
  async epicsUsing() {
    return this.epics;
  }
}

let app: FastifyInstance;
let store: FakeStore;
let principal: Principal | null;
let dirtied: string[][];
let invalidated: string[];

beforeEach(async () => {
  store = new FakeStore();
  principal = asAdmin();
  dirtied = [];
  invalidated = [];

  app = Fastify();
  registerCalendarRoutes(app, {
    store,
    dirty: {
      add: async (keys) => {
        dirtied.push([...keys]);
      },
    },
    invalidateChart: async (epicKey) => {
      invalidated.push(epicKey);
    },
    guards: testGuards({ principal: () => principal }),
  });
  await app.ready();
});

const importBody = (over: Record<string, unknown> = {}) => ({
  mode: 'MERGE',
  year: null,
  holidays: [
    { date: '2026-02-17', label: 'Tết' },
    { date: '2026-02-18', label: null },
  ],
  ...over,
});

describe('đọc lịch và ngày lễ', () => {
  it('chưa đăng nhập bị chặn 401', async () => {
    principal = null;
    const res = await app.inject({ method: 'GET', url: '/api/calendars' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/calendars: ai đăng nhập cũng thấy, nhưng CHỈ lịch built-in', async () => {
    principal = asViewer('PAY');
    const list = await app.inject({ method: 'GET', url: '/api/calendars' });
    expect(list.statusCode).toBe(200);
    expect(list.json().calendars.map((c: CalendarSummary) => c.calendarId)).toEqual([
      'VN_STANDARD',
      'JP_STANDARD',
    ]);

    const days = await app.inject({ method: 'GET', url: '/api/calendars/VN_STANDARD/holidays?year=2026' });
    expect(days.statusCode).toBe(200);
    expect(days.json().holidays[0].date).toBe('2026-02-17');
  });

  it('lịch riêng của một dự án KHÔNG đọc được qua đường built-in (404)', async () => {
    principal = asViewer('PAY');
    const res = await app.inject({ method: 'GET', url: '/api/calendars/PAY_CAL/holidays' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/projects/PAY/calendars: built-in + lịch riêng của PAY, không thấy của CRM', async () => {
    principal = asViewer('PAY');
    const res = await app.inject({ method: 'GET', url: '/api/projects/PAY/calendars' });
    expect(res.statusCode).toBe(200);
    expect(res.json().calendars.map((c: CalendarSummary) => c.calendarId)).toEqual([
      'VN_STANDARD',
      'JP_STANDARD',
      'PAY_CAL',
    ]);
  });

  it('lịch của TENANT KHÁC qua đường dự án mình → 404 như không tồn tại', async () => {
    principal = asViewer('PAY');
    const res = await app.inject({ method: 'GET', url: '/api/projects/PAY/calendars/CRM_CAL/holidays' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('CALENDAR_NOT_FOUND');
  });

  it('lịch không tồn tại trả 404, không trả danh sách rỗng giả vờ ổn', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/calendars/US_STANDARD/holidays' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('CALENDAR_NOT_FOUND');
  });

  it('tham số year rác báo 400 ngay, không im lặng bỏ lọc', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/calendars/VN_STANDARD/holidays?year=abc' });
    expect(res.statusCode).toBe(400);
  });
});

describe('quyền ghi', () => {
  it.each([
    ['PM', asPm('PAY')],
    ['VIEWER', asViewer('PAY')],
  ])('%s không sửa được lịch BUILT-IN qua đường admin (403)', async (_role, p) => {
    principal = p;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/calendars/VN_STANDARD/holidays/import',
      payload: importBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(store.importCalls).toHaveLength(0);
  });

  it('PM cũng không sửa được lịch built-in qua đường DỰ ÁN — nó ảnh hưởng mọi tenant', async () => {
    principal = asPm('PAY');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/calendars/VN_STANDARD/holidays/import',
      payload: importBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN');
    expect(store.importCalls).toHaveLength(0);
  });

  it('PM SỬA ĐƯỢC lịch riêng của dự án mình', async () => {
    principal = asPm('PAY');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/calendars/PAY_CAL/holidays/import',
      payload: importBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(store.importCalls).toHaveLength(1);
  });

  it('VIEWER của dự án không import được vào lịch dự án (403)', async () => {
    principal = asViewer('PAY');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/calendars/PAY_CAL/holidays/import',
      payload: importBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(store.importCalls).toHaveLength(0);
  });

  it('PM không xoá được ngày lễ của lịch built-in', async () => {
    principal = asPm('PAY');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/projects/PAY/calendars/VN_STANDARD/holidays/2026-02-17',
    });
    expect(res.statusCode).toBe(403);
    expect(store.deleteCalls).toHaveLength(0);
  });
});

describe('import (đường admin, lịch built-in)', () => {
  it('import hợp lệ trả số đếm và lan truyền: xoá cache chart mọi Epic, dirty Epic ACTIVE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/calendars/VN_STANDARD/holidays/import',
      payload: importBody(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      calendarId: 'VN_STANDARD',
      inserted: 2,
      updated: 1,
      deleted: 0,
      epicsMarkedForRecompute: 1,
    });
    expect(invalidated.sort()).toEqual(['PAY-1', 'PAY-2']);
    expect(dirtied).toEqual([['PAY-1']]);
  });

  it('dòng sai trả lỗi TỪNG DÒNG và không ghi gì cả', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/calendars/VN_STANDARD/holidays/import',
      payload: importBody({
        holidays: [
          { date: '2026-02-17', label: null },
          { date: '17/02/2026', label: null },
          { date: 'Tết', label: null },
        ],
      }),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    // Hai dòng sai → ít nhất hai issue, mỗi issue trỏ đúng dòng.
    expect(body.issues.length).toBeGreaterThanOrEqual(2);
    expect(body.issues.some((i: { path: string }) => i.path.startsWith('holidays.1'))).toBe(true);
    expect(store.importCalls).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
  });

  it('REPLACE_YEAR thiếu năm hoặc lẫn ngày năm khác đều bị chặn', async () => {
    const noYear = await app.inject({
      method: 'POST',
      url: '/api/admin/calendars/VN_STANDARD/holidays/import',
      payload: importBody({ mode: 'REPLACE_YEAR' }),
    });
    expect(noYear.statusCode).toBe(400);

    const wrongYear = await app.inject({
      method: 'POST',
      url: '/api/admin/calendars/VN_STANDARD/holidays/import',
      payload: importBody({
        mode: 'REPLACE_YEAR',
        year: 2026,
        holidays: [{ date: '2027-01-01', label: null }],
      }),
    });
    expect(wrongYear.statusCode).toBe(400);
    expect(store.importCalls).toHaveLength(0);
  });

  it('import vào lịch không tồn tại trả 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/calendars/US_STANDARD/holidays/import',
      payload: importBody(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('xoá một ngày (đường admin)', () => {
  it('xoá thành công thì lan truyền như import', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/calendars/VN_STANDARD/holidays/2026-02-17',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(1);
    expect(invalidated.sort()).toEqual(['PAY-1', 'PAY-2']);
    expect(dirtied).toEqual([['PAY-1']]);
  });

  it('xoá ngày vốn không tồn tại là no-op: không lan truyền, không lỗi', async () => {
    store.deleteResult = 0;
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/calendars/VN_STANDARD/holidays/2026-12-25',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ calendarId: 'VN_STANDARD', deleted: 0, epicsMarkedForRecompute: 0 });
    expect(invalidated).toHaveLength(0);
    expect(dirtied).toHaveLength(0);
  });

  it('ngày sai định dạng báo 400', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/calendars/VN_STANDARD/holidays/17-02-2026',
    });
    expect(res.statusCode).toBe(400);
  });
});

const makeupImportBody = (over: Record<string, unknown> = {}) => ({
  mode: 'MERGE',
  year: null,
  makeupWorkdays: [
    { date: '2026-04-25', label: 'Làm bù 30/4' },
    { date: '2026-05-30', label: null },
  ],
  ...over,
});

describe('ngày làm bù', () => {
  it('ai đăng nhập cũng xem được ngày làm bù của lịch built-in', async () => {
    principal = asViewer('PAY');
    const res = await app.inject({
      method: 'GET',
      url: '/api/calendars/VN_STANDARD/makeup-workdays?year=2026',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().makeupWorkdays[0].date).toBe('2026-04-25');
  });

  it('VIEWER của dự án xem được ngày làm bù của lịch dự án qua đường dự án', async () => {
    principal = asViewer('PAY');
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/PAY/calendars/PAY_CAL/makeup-workdays',
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['PM', asPm('PAY')],
    ['VIEWER', asViewer('PAY')],
  ])('%s không được import ngày làm bù vào lịch built-in', async (_role, p) => {
    principal = p;
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/calendars/VN_STANDARD/makeup-workdays/import',
      payload: makeupImportBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(store.makeupImportCalls).toHaveLength(0);
  });

  it('import hợp lệ (admin, built-in) trả số đếm và lan truyền như ngày lễ', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/calendars/VN_STANDARD/makeup-workdays/import',
      payload: makeupImportBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      calendarId: 'VN_STANDARD',
      inserted: 2,
      updated: 1,
      deleted: 0,
      epicsMarkedForRecompute: 1,
    });
    expect(store.makeupImportCalls).toHaveLength(1);
    expect(invalidated.sort()).toEqual(['PAY-1', 'PAY-2']);
    expect(dirtied).toEqual([['PAY-1']]);
  });

  it('PM import được ngày làm bù vào LỊCH DỰ ÁN MÌNH và lan truyền đầy đủ', async () => {
    principal = asPm('PAY');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/PAY/calendars/PAY_CAL/makeup-workdays/import',
      payload: makeupImportBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(store.makeupImportCalls).toHaveLength(1);
    expect(invalidated.sort()).toEqual(['PAY-1', 'PAY-2']);
    expect(dirtied).toEqual([['PAY-1']]);
  });

  it('dòng sai trả lỗi TỪNG DÒNG (trỏ đúng makeupWorkdays.i) và không ghi gì', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/calendars/VN_STANDARD/makeup-workdays/import',
      payload: makeupImportBody({
        makeupWorkdays: [
          { date: '2026-04-25', label: null },
          { date: '25/04/2026', label: null },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(
      res.json().issues.some((i: { path: string }) => i.path.startsWith('makeupWorkdays.1')),
    ).toBe(true);
    expect(store.makeupImportCalls).toHaveLength(0);
  });

  it('xoá ngày làm bù thành công thì lan truyền', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/calendars/VN_STANDARD/makeup-workdays/2026-04-25',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(1);
    expect(store.makeupDeleteCalls).toEqual(['2026-04-25']);
    expect(invalidated.sort()).toEqual(['PAY-1', 'PAY-2']);
  });

  it('PM xoá được ngày làm bù của lịch dự án mình qua đường dự án', async () => {
    principal = asPm('PAY');
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/projects/PAY/calendars/PAY_CAL/makeup-workdays/2026-04-25',
    });
    expect(res.statusCode).toBe(200);
    expect(store.makeupDeleteCalls).toEqual(['2026-04-25']);
  });
});
