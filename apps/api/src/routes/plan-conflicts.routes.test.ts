import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKDAYS_MASK, type Principal, type WorkCalendar, type WorkSide } from '@app/shared';
import {
  JP_REVIEW_CALENDAR_ID,
  registerPlanConflictRoutes,
  type PlanConflictReadPort,
} from './plan-conflicts.routes.js';
import type { PlanCheckSubtask, SideCalendar } from '../services/plan-conflicts.service.js';
import { asAdmin, asPm, testGuards } from '../test-fakes.js';

/**
 * Test tầng route của plan-conflicts — T-37: phân quyền theo tenant, chọn
 * lịch theo phía, và endpoint tổng hợp đã bó trong một dự án.
 */

function sideCalendar(id: string, holidays: Record<string, string>): SideCalendar {
  const cal: WorkCalendar = {
    calendarId: id,
    timezone: 'Asia/Ho_Chi_Minh',
    workdaysMask: DEFAULT_WORKDAYS_MASK,
    hoursPerDay: 8,
    holidays: new Set(Object.keys(holidays)),
    warnings: [],
  };
  return { calendar: cal, holidayLabels: new Map(Object.entries(holidays)) };
}

class FakeReads implements PlanConflictReadPort {
  calendarRequests: string[] = [];
  epics = [
    { epicKey: 'PAY-1', projectKey: 'PAY', calendarId: 'VN_STANDARD' },
    { epicKey: 'SHOP-1', projectKey: 'SHOP', calendarId: 'VN_STANDARD' },
  ];
  subtasks: Record<string, PlanCheckSubtask[]> = {};
  sides = new Map<string, WorkSide>([['JMReview', 'JP']]);

  async epicMeta(epicKey: string) {
    const found = this.epics.find((e) => e.epicKey === epicKey);
    return found === undefined ? null : { projectKey: found.projectKey, calendarId: found.calendarId };
  }
  async listEpics(projectKey: string) {
    return this.epics.filter((e) => e.projectKey === projectKey);
  }
  async subtasksForCheck(epicKey: string) {
    return this.subtasks[epicKey] ?? [];
  }
  async columnSides() {
    return this.sides;
  }
  async sideCalendar(calendarId: string) {
    this.calendarRequests.push(calendarId);
    // Lịch JP có ngày lễ 11/08; lịch VN không có ngày lễ nào trong test này.
    return calendarId === JP_REVIEW_CALENDAR_ID
      ? sideCalendar(calendarId, { '2026-08-11': '山の日' })
      : sideCalendar(calendarId, {});
  }
}

const jmReviewEndsOnJpHoliday: PlanCheckSubtask = {
  issueKey: 'PAY-101',
  summary: 'Review màn hình đăng nhập',
  parentKey: 'PAY-10',
  phaseCode: 'DESIGN',
  taskType: 'JMReview',
  wbsStartDate: '2026-08-10',
  wbsEndDate: '2026-08-11',
};

let app: FastifyInstance;
let reads: FakeReads;
let principal: Principal | null;

beforeEach(async () => {
  reads = new FakeReads();
  principal = asAdmin();
  app = Fastify();
  registerPlanConflictRoutes(app, {
    reads,
    guards: testGuards({ principal: () => principal, projects: ['PAY', 'SHOP'] }),
  });
  await app.ready();
});

describe('chi tiết một Epic', () => {
  it('task JMReview kết thúc đúng ngày lễ JP bị bắt, dù lịch VN hôm đó đi làm', async () => {
    reads.subtasks['PAY-1'] = [jmReviewEndsOnJpHoliday];

    const res = await app.inject({ method: 'GET', url: '/api/projects/PAY/epics/PAY-1/plan-conflicts' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.summary).toEqual({ total: 1, bySide: { VN: 0, JP: 1 }, sideUnknownCount: 0 });
    expect(body.conflicts[0].violations).toEqual([
      { field: 'END', date: '2026-08-11', reason: 'HOLIDAY', holidayLabel: '山の日' },
    ]);
    // Phía VN soi bằng lịch THỰC THI của Epic, phía JP bằng lịch chuẩn khách hàng.
    expect(reads.calendarRequests).toEqual(['VN_STANDARD', 'JP_STANDARD']);
  });

  it('Epic không theo dõi trả 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects/PAY/epics/NOPE-1/plan-conflicts' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('EPIC_NOT_FOUND');
  });

  it('PM không phụ trách project đó nhận 404 — không lộ tenant tồn tại', async () => {
    principal = asPm('PAY');
    const res = await app.inject({ method: 'GET', url: '/api/projects/SHOP/epics/SHOP-1/plan-conflicts' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('PROJECT_NOT_FOUND');
  });

  it('Epic của tenant khác ghép vào URL dự án mình → 404 EPIC_NOT_FOUND', async () => {
    principal = asPm('PAY');
    const res = await app.inject({ method: 'GET', url: '/api/projects/PAY/epics/SHOP-1/plan-conflicts' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('EPIC_NOT_FOUND');
  });

  it('chưa đăng nhập bị chặn 401', async () => {
    principal = null;
    const res = await app.inject({ method: 'GET', url: '/api/projects/PAY/epics/PAY-1/plan-conflicts' });
    expect(res.statusCode).toBe(401);
  });
});

describe('tổng hợp cho màn Epics', () => {
  it('chỉ trả Epic CÓ vi phạm, Epic sạch không chiếm chỗ', async () => {
    reads.subtasks['PAY-1'] = [jmReviewEndsOnJpHoliday];

    const res = await app.inject({ method: 'GET', url: '/api/projects/PAY/plan-conflicts/summary' });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts).toEqual([{ epicKey: 'PAY-1', total: 1 }]);
  });

  it('tổng hợp CHỈ đếm Epic của tenant trong URL — không rò số liệu tenant khác', async () => {
    principal = asPm('PAY');
    reads.subtasks['PAY-1'] = [jmReviewEndsOnJpHoliday];
    reads.subtasks['SHOP-1'] = [{ ...jmReviewEndsOnJpHoliday, issueKey: 'SHOP-101' }];

    const res = await app.inject({ method: 'GET', url: '/api/projects/PAY/plan-conflicts/summary' });
    expect(res.json().counts).toEqual([{ epicKey: 'PAY-1', total: 1 }]);
  });
});
