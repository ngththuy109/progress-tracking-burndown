import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Principal } from '@app/shared';
import { registerProjectsRoutes } from './projects.routes.js';
import type { ProjectStore } from '../adapters/project.adapters.js';
import type { AdminUserRow } from '../adapters/app-user.adapters.js';

const ADMIN: Principal = { userId: 'admin@x.com', role: 'ADMIN', projects: [] };
const PM: Principal = { userId: 'pm@x.com', role: 'PM', projects: ['PAY'] };

class FakeProjectStore implements ProjectStore {
  readonly rows = new Map<string, { projectKey: string; displayName: string | null }>();
  constructor(seed: Array<{ projectKey: string; displayName: string | null }> = []) {
    for (const r of seed) this.rows.set(r.projectKey, r);
  }
  list() {
    return Promise.resolve([...this.rows.values()]);
  }
  keys() {
    return Promise.resolve(new Set(this.rows.keys()) as ReadonlySet<string>);
  }
  upsert(row: { projectKey: string; displayName: string | null }) {
    this.rows.set(row.projectKey, row);
    return Promise.resolve();
  }
  remove(projectKey: string) {
    return Promise.resolve(this.rows.delete(projectKey));
  }
}

let principal: Principal | null;
let projects: FakeProjectStore;
let app: FastifyInstance;

function build(
  seedProjects: Array<{ projectKey: string; displayName: string | null }> = [],
  users: AdminUserRow[] = [],
): FastifyInstance {
  projects = new FakeProjectStore(seedProjects);
  const instance = Fastify({ logger: false });
  registerProjectsRoutes(instance, {
    resolvePrincipal: () => principal,
    projects,
    users: { list: () => Promise.resolve(users) },
  });
  return instance;
}

beforeEach(() => {
  principal = ADMIN;
  app = build([{ projectKey: 'PAY', displayName: 'Payments' }]);
});

describe('phân quyền /api/projects', () => {
  it('không đăng nhập → 401; không phải ADMIN → 403', async () => {
    principal = null;
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
    principal = PM;
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(403);
  });
});

describe('GET /api/projects', () => {
  it('liệt kê project kèm số PM được gán', async () => {
    app = build(
      [
        { projectKey: 'PAY', displayName: 'Payments' },
        { projectKey: 'CRM', displayName: null },
      ],
      [
        { userId: 'a@x.com', role: 'PM', projects: ['PAY'], displayName: null },
        { userId: 'b@x.com', role: 'PM', projects: ['PAY', 'CRM'], displayName: null },
        { userId: 'c@x.com', role: 'ADMIN', projects: [], displayName: null },
      ],
    );
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toEqual([
      { projectKey: 'PAY', displayName: 'Payments', pmCount: 2 },
      { projectKey: 'CRM', displayName: null, pmCount: 1 },
    ]);
  });
});

describe('POST /api/projects', () => {
  it('đăng ký project, chuẩn hoá về chữ HOA', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { projectKey: '  crm ', displayName: 'CRM' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projectKey: 'CRM', displayName: 'CRM', pmCount: 0 });
    expect(projects.rows.has('CRM')).toBe(true);
  });

  it('key sai định dạng → 400', async () => {
    for (const bad of ['9AB', 'a b', '']) {
      const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { projectKey: bad } });
      expect(res.statusCode, bad).toBe(400);
    }
  });
});

describe('DELETE /api/projects/:projectKey', () => {
  it('project đang có PM → 409 PROJECT_IN_USE', async () => {
    app = build(
      [{ projectKey: 'PAY', displayName: null }],
      [{ userId: 'a@x.com', role: 'PM', projects: ['PAY'], displayName: null }],
    );
    const res = await app.inject({ method: 'DELETE', url: '/api/projects/PAY' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('PROJECT_IN_USE');
    expect(projects.rows.has('PAY')).toBe(true); // không bị xoá
  });

  it('project không PM nào dùng → xoá ok; chuẩn hoá key từ URL', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/projects/pay' });
    expect(res.statusCode).toBe(200);
    expect(projects.rows.has('PAY')).toBe(false);
  });

  it('project không tồn tại → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/projects/GHOST' });
    expect(res.statusCode).toBe(404);
  });
});
