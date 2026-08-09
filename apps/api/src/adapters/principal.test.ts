import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { UserRole } from '@app/shared';
import {
  authConfigFromEnv,
  createPrincipalResolver,
  normalizeIdentity,
  type AppUserStore,
  type AuthConfig,
} from './principal.js';

/** Chỉ cần `headers` để phân giải; phần còn lại của request không dùng tới. */
function req(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function storeOf(map: Record<string, { role: UserRole; projects: string[] }>): AppUserStore {
  return { find: async (userId) => map[userId] ?? null };
}

const BASE: AuthConfig = {
  identityHeader: 'x-user-id',
  bootstrapAdmins: new Set(),
  defaultRole: 'VIEWER',
};

describe('createPrincipalResolver', () => {
  it('không có header danh tính → null', async () => {
    const resolve = createPrincipalResolver(storeOf({}), BASE);
    expect(await resolve(req({}))).toBeNull();
    expect(await resolve(req({ 'x-user-id': '   ' }))).toBeNull();
  });

  it('lấy role/projects từ app_user và BỎ QUA role giả trong header', async () => {
    const resolve = createPrincipalResolver(
      storeOf({ 'pm@x.com': { role: 'PM', projects: ['PAY'] } }),
      BASE,
    );
    // Kẻ tấn công cố gắn `x-user-role: ADMIN` — phải vô hiệu.
    const p = await resolve(
      req({ 'x-user-id': 'pm@x.com', 'x-user-role': 'ADMIN', 'x-user-projects': 'ALL' }),
    );
    expect(p).toEqual({ userId: 'pm@x.com', role: 'PM', projects: ['PAY'] });
  });

  it('chuẩn hoá email về chữ thường trước khi tra', async () => {
    const resolve = createPrincipalResolver(
      storeOf({ 'pm@x.com': { role: 'PM', projects: [] } }),
      BASE,
    );
    const p = await resolve(req({ 'x-user-id': '  PM@X.com ' }));
    expect(p).toMatchObject({ userId: 'pm@x.com', role: 'PM' });
  });

  it('đã đăng nhập nhưng chưa cấp quyền → defaultRole VIEWER', async () => {
    const resolve = createPrincipalResolver(storeOf({}), BASE);
    expect(await resolve(req({ 'x-user-id': 'new@x.com' }))).toEqual({
      userId: 'new@x.com',
      role: 'VIEWER',
      projects: [],
    });
  });

  it('defaultRole null → chưa cấp quyền thì không có principal', async () => {
    const resolve = createPrincipalResolver(storeOf({}), { ...BASE, defaultRole: null });
    expect(await resolve(req({ 'x-user-id': 'new@x.com' }))).toBeNull();
  });

  it('bootstrap admin luôn là ADMIN, kể cả khi chưa có trong app_user', async () => {
    const resolve = createPrincipalResolver(storeOf({}), {
      ...BASE,
      bootstrapAdmins: new Set(['boss@x.com']),
    });
    expect(await resolve(req({ 'x-user-id': 'Boss@x.com' }))).toEqual({
      userId: 'boss@x.com',
      role: 'ADMIN',
      projects: [],
    });
  });

  it('tên header danh tính cấu hình được', async () => {
    const resolve = createPrincipalResolver(
      storeOf({ 'a@x.com': { role: 'ADMIN', projects: [] } }),
      { ...BASE, identityHeader: 'x-forwarded-email' },
    );
    expect(await resolve(req({ 'x-forwarded-email': 'a@x.com' }))).toMatchObject({ role: 'ADMIN' });
  });
});

describe('normalizeIdentity', () => {
  it('trim + lowercase; rỗng/không có → null', () => {
    expect(normalizeIdentity('  A@B.com ')).toBe('a@b.com');
    expect(normalizeIdentity('')).toBeNull();
    expect(normalizeIdentity('   ')).toBeNull();
    expect(normalizeIdentity(undefined)).toBeNull();
  });
});

describe('authConfigFromEnv', () => {
  it('mặc định: header x-user-id, defaultRole VIEWER, không có admin mồi', () => {
    const c = authConfigFromEnv({});
    expect(c.identityHeader).toBe('x-user-id');
    expect(c.defaultRole).toBe('VIEWER');
    expect(c.bootstrapAdmins.size).toBe(0);
  });

  it('đọc và chuẩn hoá danh sách admin mồi (bỏ mục rỗng)', () => {
    const c = authConfigFromEnv({ AUTH_BOOTSTRAP_ADMINS: 'Boss@X.com, second@x.com ,' });
    expect([...c.bootstrapAdmins].sort()).toEqual(['boss@x.com', 'second@x.com']);
  });

  it('AUTH_DEFAULT_ROLE=NONE → null (từ chối người chưa cấp quyền)', () => {
    expect(authConfigFromEnv({ AUTH_DEFAULT_ROLE: 'none' }).defaultRole).toBeNull();
  });

  it('AUTH_DEFAULT_ROLE lạ → ném lỗi ngay khi khởi động', () => {
    expect(() => authConfigFromEnv({ AUTH_DEFAULT_ROLE: 'ROOT' })).toThrow(/AUTH_DEFAULT_ROLE/);
  });
});
