import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { GlobalRole, ProjectRole } from '@app/shared';
import {
  authConfigFromEnv,
  createAuthResolver,
  createPrincipalResolver,
  normalizeIdentity,
  type AppUserStore,
  type AuthConfig,
  type AuthResolverSources,
} from './principal.js';

/** Chỉ cần `headers` để phân giải; phần còn lại của request không dùng tới. */
function req(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function storeOf(
  map: Record<string, { role: GlobalRole; memberships: Record<string, ProjectRole> }>,
): AppUserStore {
  return { find: async (userId) => map[userId] ?? null };
}

const BASE: AuthConfig = {
  identityHeader: 'x-user-id',
  bootstrapAdmins: new Set(),
  defaultGrant: 'MEMBER',
};

describe('createPrincipalResolver', () => {
  it('không có header danh tính → null', async () => {
    const resolve = createPrincipalResolver(storeOf({}), BASE);
    expect(await resolve(req({}))).toBeNull();
    expect(await resolve(req({ 'x-user-id': '   ' }))).toBeNull();
  });

  it('lấy quyền hai tầng từ app_user và BỎ QUA role giả trong header', async () => {
    const resolve = createPrincipalResolver(
      storeOf({ 'pm@x.com': { role: 'MEMBER', memberships: { PAY: 'PM', CRM: 'VIEWER' } } }),
      BASE,
    );
    // Kẻ tấn công cố gắn `x-user-role: ADMIN` — phải vô hiệu.
    const p = await resolve(
      req({ 'x-user-id': 'pm@x.com', 'x-user-role': 'ADMIN', 'x-user-projects': 'ALL' }),
    );
    expect(p).toEqual({
      userId: 'pm@x.com',
      isAdmin: false,
      memberships: { PAY: 'PM', CRM: 'VIEWER' },
    });
  });

  it('role toàn cục ADMIN → isAdmin=true', async () => {
    const resolve = createPrincipalResolver(
      storeOf({ 'boss@x.com': { role: 'ADMIN', memberships: {} } }),
      BASE,
    );
    expect(await resolve(req({ 'x-user-id': 'boss@x.com' }))).toMatchObject({ isAdmin: true });
  });

  it('chuẩn hoá email về chữ thường trước khi tra', async () => {
    const resolve = createPrincipalResolver(
      storeOf({ 'pm@x.com': { role: 'MEMBER', memberships: { PAY: 'PM' } } }),
      BASE,
    );
    const p = await resolve(req({ 'x-user-id': '  PM@X.com ' }));
    expect(p).toMatchObject({ userId: 'pm@x.com', memberships: { PAY: 'PM' } });
  });

  it('đã đăng nhập nhưng chưa cấp quyền → MEMBER trắng tay (không thấy dự án nào)', async () => {
    const resolve = createPrincipalResolver(storeOf({}), BASE);
    expect(await resolve(req({ 'x-user-id': 'new@x.com' }))).toEqual({
      userId: 'new@x.com',
      isAdmin: false,
      memberships: {},
    });
  });

  it('defaultGrant null → chưa cấp quyền thì không có principal', async () => {
    const resolve = createPrincipalResolver(storeOf({}), { ...BASE, defaultGrant: null });
    expect(await resolve(req({ 'x-user-id': 'new@x.com' }))).toBeNull();
  });

  it('defaultGrant ADMIN (chỉ dùng cho dev) → ai đăng nhập cũng là admin', async () => {
    const resolve = createPrincipalResolver(storeOf({}), { ...BASE, defaultGrant: 'ADMIN' });
    expect(await resolve(req({ 'x-user-id': 'dev@x.com' }))).toMatchObject({ isAdmin: true });
  });

  it('bootstrap admin luôn là ADMIN, kể cả khi chưa có trong app_user', async () => {
    const resolve = createPrincipalResolver(storeOf({}), {
      ...BASE,
      bootstrapAdmins: new Set(['boss@x.com']),
    });
    expect(await resolve(req({ 'x-user-id': 'Boss@x.com' }))).toEqual({
      userId: 'boss@x.com',
      isAdmin: true,
      memberships: {},
    });
  });

  it('tên header danh tính cấu hình được', async () => {
    const resolve = createPrincipalResolver(
      storeOf({ 'a@x.com': { role: 'ADMIN', memberships: {} } }),
      { ...BASE, identityHeader: 'x-forwarded-email' },
    );
    expect(await resolve(req({ 'x-forwarded-email': 'a@x.com' }))).toMatchObject({ isAdmin: true });
  });
});

describe('createAuthResolver (phiên LDAP + header)', () => {
  const STORE = storeOf({
    'alice@x.vn': { role: 'MEMBER', memberships: { PAY: 'PM' } },
    'header@x.com': { role: 'ADMIN', memberships: {} },
  });

  function sources(over: Partial<AuthResolverSources> = {}): AuthResolverSources {
    return {
      sessionUserId: () => Promise.resolve(null),
      ldapEnabled: () => Promise.resolve(false),
      forceHeader: false,
      ...over,
    };
  }

  it('cookie phiên hợp lệ THẮNG header — quyền vẫn tra app_user', async () => {
    const resolve = createAuthResolver(
      STORE,
      BASE,
      sources({
        sessionUserId: () => Promise.resolve('Alice@X.vn'), // chuẩn hoá lowercase
        ldapEnabled: () => Promise.resolve(true),
      }),
    );
    // Header trỏ sang ADMIN nhưng phiên mới là danh tính thật.
    const p = await resolve(req({ 'x-user-id': 'header@x.com' }));
    expect(p).toEqual({ userId: 'alice@x.vn', isAdmin: false, memberships: { PAY: 'PM' } });
  });

  it('LDAP đang bật + không có phiên → header BỊ BỎ QUA (không giả danh được)', async () => {
    const resolve = createAuthResolver(
      STORE,
      BASE,
      sources({ ldapEnabled: () => Promise.resolve(true) }),
    );
    expect(await resolve(req({ 'x-user-id': 'header@x.com' }))).toBeNull();
  });

  it('LDAP tắt → đường header cũ nguyên vẹn (luồng dev VITE_DEV_USER)', async () => {
    const resolve = createAuthResolver(STORE, BASE, sources());
    expect(await resolve(req({ 'x-user-id': 'header@x.com' }))).toMatchObject({
      userId: 'header@x.com',
      isAdmin: true,
    });
  });

  it('AUTH_FORCE_HEADER=1 → header được tin dù LDAP bật (van thoát hiểm)', async () => {
    const resolve = createAuthResolver(
      STORE,
      BASE,
      sources({ ldapEnabled: () => Promise.resolve(true), forceHeader: true }),
    );
    expect(await resolve(req({ 'x-user-id': 'header@x.com' }))).toMatchObject({
      userId: 'header@x.com',
      isAdmin: true,
    });
  });

  it('không phiên, không header → null', async () => {
    const resolve = createAuthResolver(STORE, BASE, sources());
    expect(await resolve(req({}))).toBeNull();
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
  it('mặc định: header x-user-id, defaultGrant MEMBER, không có admin mồi', () => {
    const c = authConfigFromEnv({});
    expect(c.identityHeader).toBe('x-user-id');
    expect(c.defaultGrant).toBe('MEMBER');
    expect(c.bootstrapAdmins.size).toBe(0);
  });

  it('đọc và chuẩn hoá danh sách admin mồi (bỏ mục rỗng)', () => {
    const c = authConfigFromEnv({ AUTH_BOOTSTRAP_ADMINS: 'Boss@X.com, second@x.com ,' });
    expect([...c.bootstrapAdmins].sort()).toEqual(['boss@x.com', 'second@x.com']);
  });

  it('AUTH_DEFAULT_ROLE=NONE → null (từ chối người chưa cấp quyền)', () => {
    expect(authConfigFromEnv({ AUTH_DEFAULT_ROLE: 'none' }).defaultGrant).toBeNull();
  });

  it('giá trị CŨ VIEWER/PM được hiểu như MEMBER (breaking change có chủ đích)', () => {
    // Trước multi-tenant VIEWER nghĩa là "xem tất cả"; giờ chỉ còn nghĩa
    // "đăng nhập được nhưng chưa thuộc dự án nào".
    expect(authConfigFromEnv({ AUTH_DEFAULT_ROLE: 'VIEWER' }).defaultGrant).toBe('MEMBER');
    expect(authConfigFromEnv({ AUTH_DEFAULT_ROLE: 'pm' }).defaultGrant).toBe('MEMBER');
  });

  it('AUTH_DEFAULT_ROLE=ADMIN vẫn cho admin (môi trường dev)', () => {
    expect(authConfigFromEnv({ AUTH_DEFAULT_ROLE: 'admin' }).defaultGrant).toBe('ADMIN');
  });

  it('AUTH_DEFAULT_ROLE lạ → ném lỗi ngay khi khởi động', () => {
    expect(() => authConfigFromEnv({ AUTH_DEFAULT_ROLE: 'ROOT' })).toThrow(/AUTH_DEFAULT_ROLE/);
  });
});
