import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Principal } from '@app/shared';
import { registerUsersRoutes } from './users.routes.js';
import type { AdminUserRow, AppUserAdminStore } from '../adapters/app-user.adapters.js';

const ADMIN: Principal = { userId: 'admin@x.com', role: 'ADMIN', projects: [] };
const PM: Principal = { userId: 'pm@x.com', role: 'PM', projects: ['PAY'] };
const VIEWER: Principal = { userId: 'v@x.com', role: 'VIEWER', projects: [] };

class FakeAdminStore implements AppUserAdminStore {
  readonly rows = new Map<string, AdminUserRow>();
  constructor(seed: AdminUserRow[] = []) {
    for (const r of seed) this.rows.set(r.userId, r);
  }
  list(): Promise<readonly AdminUserRow[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  upsert(row: { userId: string; role: AdminUserRow['role']; projects: readonly string[]; displayName: string | null }): Promise<void> {
    this.rows.set(row.userId, { userId: row.userId, role: row.role, projects: [...row.projects], displayName: row.displayName });
    return Promise.resolve();
  }
  remove(userId: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(userId));
  }
}

let principal: Principal | null;
let store: FakeAdminStore;
let app: FastifyInstance;

function build(
  seed: AdminUserRow[] = [],
  bootstrap: string[] = [],
  known: string[] = ['PAY', 'CRM'],
): FastifyInstance {
  store = new FakeAdminStore(seed);
  const instance = Fastify({ logger: false });
  registerUsersRoutes(instance, {
    resolvePrincipal: () => principal,
    store,
    bootstrapAdmins: new Set(bootstrap),
    knownProjectKeys: () => Promise.resolve(new Set(known)),
  });
  return instance;
}

beforeEach(() => {
  principal = ADMIN;
  app = build([{ userId: 'pm@x.com', role: 'PM', projects: ['PAY'], displayName: null }]);
});

describe('phân quyền nhóm /api/users', () => {
  it('không đăng nhập → 401', async () => {
    principal = null;
    for (const r of [
      { method: 'GET' as const, url: '/api/users' },
      { method: 'POST' as const, url: '/api/users', payload: { userId: 'a@x.com', role: 'PM' } },
      { method: 'DELETE' as const, url: '/api/users/a@x.com' },
    ]) {
      expect((await app.inject(r)).statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('không phải ADMIN → 403', async () => {
    for (const p of [PM, VIEWER]) {
      principal = p;
      const res = await app.inject({ method: 'GET', url: '/api/users' });
      expect(res.statusCode, p.role).toBe(403);
      expect(res.json().error).toBe('FORBIDDEN');
    }
  });
});

describe('GET /api/users', () => {
  it('liệt kê người dùng DB, gộp admin mồi từ env (chỉ đọc), sắp theo vai trò', async () => {
    app = build(
      [{ userId: 'pm@x.com', role: 'PM', projects: ['PAY'], displayName: 'PM' }],
      ['admin@x.com'],
    );
    const res = await app.inject({ method: 'GET', url: '/api/users' });
    expect(res.statusCode).toBe(200);
    const users = res.json().users as Array<{ userId: string; role: string; source: string }>;
    expect(users).toEqual([
      { userId: 'admin@x.com', role: 'ADMIN', projects: [], displayName: null, source: 'ENV' },
      { userId: 'pm@x.com', role: 'PM', projects: ['PAY'], displayName: 'PM', source: 'DB' },
    ]);
  });

  it('không nhân đôi khi admin mồi cũng có trong DB (DB thắng nhãn nguồn)', async () => {
    app = build(
      [{ userId: 'admin@x.com', role: 'ADMIN', projects: [], displayName: null }],
      ['admin@x.com'],
    );
    const users = (await app.inject({ method: 'GET', url: '/api/users' })).json().users;
    expect(users).toHaveLength(1);
    expect(users[0].source).toBe('DB');
  });
});

describe('POST /api/users', () => {
  it('cấp PM kèm projects; chuẩn hoá email về chữ thường', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { userId: '  NewPM@X.com ', role: 'PM', projects: ['CRM'], displayName: 'B' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: 'newpm@x.com',
      role: 'PM',
      projects: ['CRM'],
      displayName: 'B',
      source: 'DB',
    });
    expect(store.rows.get('newpm@x.com')?.role).toBe('PM');
  });

  it('gán projects cho ADMIN/VIEWER → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { userId: 'x@x.com', role: 'ADMIN', projects: ['PAY'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PM chỉ nhận project ĐÃ ĐĂNG KÝ; key lạ → 400 UNKNOWN_PROJECT', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { userId: 'pm2@x.com', role: 'PM', projects: ['pay'] },
    });
    expect(ok.statusCode, 'pay → PAY đã đăng ký').toBe(200);
    expect(ok.json().projects).toEqual(['PAY']); // chuẩn hoá về chữ HOA

    const bad = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { userId: 'pm3@x.com', role: 'PM', projects: ['PAY', 'NOPE'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('UNKNOWN_PROJECT');
  });

  it('tự sửa quyền của chính mình → 400 CANNOT_MODIFY_SELF', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { userId: 'admin@x.com', role: 'VIEWER' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CANNOT_MODIFY_SELF');
  });

  it('sửa admin mồi từ env → 400 BOOTSTRAP_ADMIN', async () => {
    app = build([], ['boss@x.com']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { userId: 'boss@x.com', role: 'VIEWER' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BOOTSTRAP_ADMIN');
  });

  it('body thiếu role → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/users', payload: { userId: 'a@x.com' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/users/:userId', () => {
  it('xoá người dùng có thật → ok', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/users/pm@x.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(store.rows.has('pm@x.com')).toBe(false);
  });

  it('xoá người không tồn tại → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/users/ghost@x.com' });
    expect(res.statusCode).toBe(404);
  });

  it('tự xoá chính mình → 400', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/users/admin@x.com' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CANNOT_MODIFY_SELF');
  });

  it('xoá admin mồi từ env → 400', async () => {
    app = build([], ['boss@x.com']);
    const res = await app.inject({ method: 'DELETE', url: '/api/users/boss@x.com' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BOOTSTRAP_ADMIN');
  });
});
