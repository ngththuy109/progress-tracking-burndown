import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { meResponseSchema, type Principal } from '@app/shared';
import type { ProjectRow } from '@app/db';
import { registerMeRoutes } from './me.routes.js';
import { asAdmin, asPm, asViewer } from '../test-fakes.js';

function projectRow(projectKey: string, over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    projectKey,
    displayName: `Dự án ${projectKey}`,
    status: 'ACTIVE',
    jiraBaseUrl: null,
    jiraEmail: null,
    hasJiraToken: false,
    hierarchyDepth: 2,
    timezone: 'Asia/Ho_Chi_Minh',
    defaultCalendarId: null,
    memberCount: 0,
    ...over,
  };
}

const CATALOG: ProjectRow[] = [
  projectRow('PAY'),
  projectRow('CRM'),
  projectRow('OLD', { status: 'ARCHIVED' }),
];

function build(principal: Principal | null, rows: ProjectRow[] = CATALOG): FastifyInstance {
  const app = Fastify({ logger: false });
  registerMeRoutes(app, {
    resolvePrincipal: () => principal,
    listProjects: () => Promise.resolve(rows),
  });
  return app;
}

describe('GET /api/me', () => {
  it('MEMBER: chỉ thấy dự án mình là thành viên, kèm role trong dự án đó', async () => {
    const app = build({
      userId: 'pm@x.com',
      isAdmin: false,
      memberships: { PAY: 'PM', OTHER: 'VIEWER' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(200);

    // Parse bằng đúng schema mà web dùng — thiếu trường nào là client từ chối.
    const body = meResponseSchema.parse(res.json());
    expect(body.userId).toBe('pm@x.com');
    expect(body.isAdmin).toBe(false);
    // OTHER không có trong danh mục → không hiện; membership tới dự án ma bị lọc.
    expect(body.projects).toEqual([{ projectKey: 'PAY', displayName: 'Dự án PAY', role: 'PM' }]);
  });

  it('VIEWER của một dự án nhận đúng role VIEWER', async () => {
    const app = build(asViewer('CRM'));
    const body = meResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/me' })).json());
    expect(body.projects).toEqual([{ projectKey: 'CRM', displayName: 'Dự án CRM', role: 'VIEWER' }]);
  });

  it('ADMIN: thấy MỌI dự án chưa ARCHIVED với role hiệu dụng PM', async () => {
    const app = build(asAdmin());
    const body = meResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/me' })).json());
    expect(body.isAdmin).toBe(true);
    expect(body.projects.map((p) => [p.projectKey, p.role])).toEqual([
      ['PAY', 'PM'],
      ['CRM', 'PM'],
    ]);
  });

  it('dự án ARCHIVED ẩn khỏi switcher với cả MEMBER', async () => {
    const app = build(asPm(['PAY', 'OLD']));
    const body = meResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/me' })).json());
    expect(body.projects.map((p) => p.projectKey)).toEqual(['PAY']);
  });

  it('401 UNAUTHENTICATED khi không có người dùng đăng nhập', async () => {
    const app = build(null);
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHENTICATED');
  });
});
