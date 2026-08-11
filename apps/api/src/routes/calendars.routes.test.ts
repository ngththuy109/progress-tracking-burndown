import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CalendarSummary, Holiday, Principal } from '@app/shared';
import { registerCalendarRoutes, type CalendarStore } from './calendars.routes.js';

/**
 * Test nhóm API lịch làm việc & ngày nghỉ — T-36.
 *
 * Trọng tâm: phân quyền (chỉ ADMIN được ghi), kiểm dữ liệu import (lỗi từng
 * dòng, không ghi nửa chừng), và LAN TRUYỀN sau khi sửa — xoá cache biểu đồ và
 * đánh dấu Epic tính lại. Phần transaction nằm ở repository test.
 */

const ADMIN: Principal = { userId: 'admin', role: 'ADMIN', projects: [] };
const PM: Principal = { userId: 'pm', role: 'PM', projects: ['PAY'] };
const VIEWER: Principal = { userId: 'viewer', role: 'VIEWER', projects: [] };

const VN: CalendarSummary = {
  calendarId: 'VN_STANDARD',
  timezone: 'Asia/Ho_Chi_Minh',
  workdaysMask: 31,
  hoursPerDay: 8,
  holidayCount: 1,
  years: [2026],
};

class FakeStore implements CalendarStore {
  holidayRows: Holiday[] = [{ date: '2026-02-17', label: 'Tết' }];
  importCalls: unknown[] = [];
  deleteCalls: string[] = [];
  deleteResult = 1;
  epics = { all: ['PAY-1', 'PAY-2'], active: ['PAY-1'] };

  async list() {
    return [VN];
  }
  async exists(calendarId: string) {
    return calendarId === 'VN_STANDARD' || calendarId === 'JP_STANDARD';
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
  principal = ADMIN;
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
    resolvePrincipal: () => principal,
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

  it('VIEWER xem được danh sách lịch và ngày lễ', async () => {
    principal = VIEWER;
    const list = await app.inject({ method: 'GET', url: '/api/calendars' });
    expect(list.statusCode).toBe(200);
    expect(list.json().calendars).toHaveLength(1);

    const days = await app.inject({ method: 'GET', url: '/api/calendars/VN_STANDARD/holidays?year=2026' });
    expect(days.statusCode).toBe(200);
    expect(days.json().holidays[0].date).toBe('2026-02-17');
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
    ['PM', PM],
    ['VIEWER', VIEWER],
  ])('%s không được import — ngày lễ ảnh hưởng mọi Epic dùng lịch', async (_role, p) => {
    principal = p;
    const res = await app.inject({
      method: 'POST',
      url: '/api/calendars/VN_STANDARD/holidays/import',
      payload: importBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(store.importCalls).toHaveLength(0);
  });

  it('PM không xoá được ngày lễ', async () => {
    principal = PM;
    const res = await app.inject({ method: 'DELETE', url: '/api/calendars/VN_STANDARD/holidays/2026-02-17' });
    expect(res.statusCode).toBe(403);
    expect(store.deleteCalls).toHaveLength(0);
  });
});

describe('import', () => {
  it('import hợp lệ trả số đếm và lan truyền: xoá cache chart mọi Epic, dirty Epic ACTIVE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/calendars/VN_STANDARD/holidays/import',
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
      url: '/api/calendars/VN_STANDARD/holidays/import',
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
      url: '/api/calendars/VN_STANDARD/holidays/import',
      payload: importBody({ mode: 'REPLACE_YEAR' }),
    });
    expect(noYear.statusCode).toBe(400);

    const wrongYear = await app.inject({
      method: 'POST',
      url: '/api/calendars/VN_STANDARD/holidays/import',
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
      url: '/api/calendars/US_STANDARD/holidays/import',
      payload: importBody(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('xoá một ngày', () => {
  it('xoá thành công thì lan truyền như import', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/calendars/VN_STANDARD/holidays/2026-02-17' });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(1);
    expect(invalidated.sort()).toEqual(['PAY-1', 'PAY-2']);
    expect(dirtied).toEqual([['PAY-1']]);
  });

  it('xoá ngày vốn không tồn tại là no-op: không lan truyền, không lỗi', async () => {
    store.deleteResult = 0;
    const res = await app.inject({ method: 'DELETE', url: '/api/calendars/VN_STANDARD/holidays/2026-12-25' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ calendarId: 'VN_STANDARD', deleted: 0, epicsMarkedForRecompute: 0 });
    expect(invalidated).toHaveLength(0);
    expect(dirtied).toHaveLength(0);
  });

  it('ngày sai định dạng báo 400', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/calendars/VN_STANDARD/holidays/17-02-2026' });
    expect(res.statusCode).toBe(400);
  });
});
