import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Principal } from '@app/shared';
import { registerUsersRoutes } from './users.routes.js';
import type { AdminUserRow, AppUserAdminStore } from '../adapters/app-user.adapters.js';
import { asAdmin, asNobody, asPm, testGuards } from '../test-fakes.js';

class FakeAdminStore implements AppUserAdminStore {
  readonly rows = new Map<string, AdminUserRow>();
  constructor(seed: AdminUserRow[] = []) {
    for (const r of seed) this.rows.set(r.userId, r);
  }
  list(): Promise<readonly AdminUserRow[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  upsert(row: { userId: string; role: AdminUserRow['role']; displayName: string | null }): Promise<void> {
    const existing = this.rows.get(row.userId);
    this.rows.set(row.userId, {
      userId: row.userId,
      role: row.role,
      displayName: row.displayName,
      // Upsert role KHÔNG đụng membership — membership quản ở bảng khác.
      membershipCount: existing?.membershipCount ?? 0,
    });
    return Promise.resolve();
  }
  remove(userId: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(userId));
  }
}

let principal: Principal | null;
let store: FakeAdminStore;
let app: FastifyInstance;

function build(seed: AdminUserRow[] = [], bootstrap: string[] = []): FastifyInstance {
  store = new FakeAdminStore(seed);
  const instance = Fastify({ logger: false });
  registerUsersRoutes(instance, {
    resolvePrincipal: () => principal,
    store,
    guards: testGuards({ principal: () => principal }),
    bootstrapAdmins: new Set(bootstrap),
  });
  return instance;
}

const member = (userId: string, over: Partial<AdminUserRow> = {}): AdminUserRow => ({
  userId,
  role: 'MEMBER',
  displayName: null,
  membershipCount: 0,
  ...over,
});

beforeEach(() => {
  principal = asAdmin();
  app = build([member('pm@x.com', { membershipCount: 1 })]);
});

describe('phân quyền nhóm /api/admin/users', () => {
  it('không đăng nhập → 401', async () => {
    principal = null;
    for (const r of [
      { method: 'GET' as const, url: '/api/admin/users' },
      { method: 'POST' as const, url: '/api/admin/users', payload: { userId: 'a@x.com', role: 'MEMBER' } },
      { method: 'DELETE' as const, url: '/api/admin/users/a@x.com' },
    ]) {
      expect((await app.inject(r)).statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('không phải ADMIN → 403 (kể cả PM của một dự án)', async () => {
    for (const p of [asPm('PAY'), asNobody()]) {
      principal = p;
      const res = await app.inject({ method: 'GET', url: '/api/admin/users' });
      expect(res.statusCode, p.userId).toBe(403);
      expect(res.json().error).toBe('FORBIDDEN');
    }
  });
});

describe('GET /api/admin/users', () => {
  it('liệt kê người dùng DB (kèm membershipCount), gộp admin mồi từ env (chỉ đọc), sắp theo vai trò', async () => {
    app = build(
      [member('pm@x.com', { displayName: 'PM', membershipCount: 2 })],
      ['admin@x.com'],
    );
    const res = await app.inject({ method: 'GET', url: '/api/admin/users' });
    expect(res.statusCode).toBe(200);
    expect(res.json().users).toEqual([
      { userId: 'admin@x.com', role: 'ADMIN', displayName: null, source: 'ENV', membershipCount: 0 },
      { userId: 'pm@x.com', role: 'MEMBER', displayName: 'PM', source: 'DB', membershipCount: 2 },
    ]);
  });

  it('không nhân đôi khi admin mồi cũng có trong DB (DB thắng nhãn nguồn)', async () => {
    app = build([member('admin2@x.com', { role: 'ADMIN' })], ['admin2@x.com']);
    const users = (await app.inject({ method: 'GET', url: '/api/admin/users' })).json().users;
    expect(users).toHaveLength(1);
    expect(users[0].source).toBe('DB');
  });
});

describe('POST /api/admin/users', () => {
  it('cấp MEMBER; chuẩn hoá email về chữ thường; KHÔNG nhận projects nữa', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: { userId: '  NewGuy@X.com ', role: 'MEMBER', displayName: 'B' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: 'newguy@x.com',
      role: 'MEMBER',
      displayName: 'B',
      source: 'DB',
      membershipCount: 0,
    });
    expect(store.rows.get('newguy@x.com')?.role).toBe('MEMBER');
  });

  it('role cũ PM/VIEWER không còn là role toàn cục hợp lệ → 400', async () => {
    for (const role of ['PM', 'VIEWER']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        payload: { userId: 'x@x.com', role },
      });
      expect(res.statusCode, role).toBe(400);
    }
  });

  it('đổi role KHÔNG làm mất membershipCount hiện có', async () => {
    principal = asAdmin('root@x.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: { userId: 'pm@x.com', role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().membershipCount).toBe(1);
  });

  it('tự sửa quyền của chính mình → 400 CANNOT_MODIFY_SELF', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: { userId: 'admin@x.com', role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CANNOT_MODIFY_SELF');
  });

  it('sửa admin mồi từ env → 400 BOOTSTRAP_ADMIN', async () => {
    app = build([], ['boss@x.com']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: { userId: 'boss@x.com', role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BOOTSTRAP_ADMIN');
  });

  it('body thiếu role → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/users', payload: { userId: 'a@x.com' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/admin/users/:userId', () => {
  it('xoá người dùng có thật → ok', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/users/pm@x.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(store.rows.has('pm@x.com')).toBe(false);
  });

  it('xoá người không tồn tại → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/users/ghost@x.com' });
    expect(res.statusCode).toBe(404);
  });

  it('tự xoá chính mình → 400', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/users/admin@x.com' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CANNOT_MODIFY_SELF');
  });

  it('xoá admin mồi từ env → 400', async () => {
    app = build([], ['boss@x.com']);
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/users/boss@x.com' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BOOTSTRAP_ADMIN');
  });
});
