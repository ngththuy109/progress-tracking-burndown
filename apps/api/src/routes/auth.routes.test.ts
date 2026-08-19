import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { InvalidCredentialsError } from 'ldapts';
import { ldapConfigSchema, ldapTestResponseSchema, type Principal } from '@app/shared';
import type { LdapConfigRow } from '@app/db';
import { registerAuthRoutes, type AuthRouteDeps, type TokenBox } from './auth.routes.js';
import type { LdapClientFactory } from '../services/ldap.service.js';
import {
  asAdmin,
  asNobody,
  FakeLdapClient,
  fakeLdapFactory,
  FakeLdapConfigStore,
  FakeSessionStore,
  FAKE_TOKEN_BOX,
  ldapConfigRow,
} from '../test-fakes.js';

/** Factory mặc định: mọi bind thành công, search trả entry có email. */
function okLdap() {
  return fakeLdapFactory(
    () =>
      new FakeLdapClient({
        onSearch: (base) => [
          { dn: base === '' ? '' : 'uid=alice,ou=users,dc=x,dc=vn', mail: 'Alice@X.vn' },
        ],
      }),
  );
}

function build(opts: {
  principal?: Principal | null;
  row?: LdapConfigRow | null;
  factory?: LdapClientFactory;
  tokenBox?: TokenBox | null;
  forceHeader?: boolean;
  now?: () => number;
}): {
  app: FastifyInstance;
  store: FakeLdapConfigStore;
  sessions: FakeSessionStore;
  invalidations: () => number;
} {
  const app = Fastify({ logger: false });
  const store = new FakeLdapConfigStore(opts.row ?? null);
  const sessions = new FakeSessionStore();
  const principal = opts.principal ?? null;
  let invalidated = 0;

  const deps: AuthRouteDeps = {
    resolvePrincipal: () => principal,
    configs: store,
    loadConfig: () => store.find(),
    invalidateConfig: () => {
      invalidated += 1;
    },
    sessions,
    clientFactory: opts.factory ?? okLdap().factory,
    tokenBox: opts.tokenBox === undefined ? FAKE_TOKEN_BOX : opts.tokenBox,
    forceHeader: opts.forceHeader ?? false,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
  registerAuthRoutes(app, deps);
  return { app, store, sessions, invalidations: () => invalidated };
}

const LOGIN = { method: 'POST' as const, url: '/auth/login' };

describe('GET /api/auth/mode', () => {
  it('chưa có config → HEADER', async () => {
    const { app } = build({ row: null });
    expect((await app.inject({ method: 'GET', url: '/api/auth/mode' })).json()).toEqual({
      mode: 'HEADER',
    });
  });

  it('config bật → LDAP', async () => {
    const { app } = build({ row: ldapConfigRow({ enabled: true }) });
    expect((await app.inject({ method: 'GET', url: '/api/auth/mode' })).json()).toEqual({
      mode: 'LDAP',
    });
  });

  it('config tắt → HEADER', async () => {
    const { app } = build({ row: ldapConfigRow({ enabled: false }) });
    expect((await app.inject({ method: 'GET', url: '/api/auth/mode' })).json()).toEqual({
      mode: 'HEADER',
    });
  });

  it('AUTH_FORCE_HEADER=1 thắng config bật → HEADER', async () => {
    const { app } = build({ row: ldapConfigRow({ enabled: true }), forceHeader: true });
    expect((await app.inject({ method: 'GET', url: '/api/auth/mode' })).json()).toEqual({
      mode: 'HEADER',
    });
  });
});

describe('POST /auth/login', () => {
  it('đăng nhập đúng → 204 + Set-Cookie ptb_sess + phiên Redis đúng TTL', async () => {
    const { app, sessions } = build({ row: ldapConfigRow({ sessionTtlHours: 8 }) });
    const res = await app.inject({
      ...LOGIN,
      payload: { username: 'alice', password: 'pw' },
    });
    expect(res.statusCode).toBe(204);

    const cookie = res.headers['set-cookie'] as string;
    expect(cookie).toContain('ptb_sess=sess-1');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain(`Max-Age=${8 * 3600}`);

    // Danh tính phiên = email đã chuẩn hoá (lowercase), TTL từ config.
    expect(sessions.sessions.get('sess-1')).toEqual({ userId: 'alice@x.vn', ttlHours: 8 });
  });

  it('sai mật khẩu → 401 LOGIN_FAILED chung chung, không nhắc username', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onBind: () => {
            throw new InvalidCredentialsError();
          },
        }),
    );
    const { app, sessions } = build({ row: ldapConfigRow(), factory });
    const res = await app.inject({
      ...LOGIN,
      payload: { username: 'alice.rat.dai@x.vn', password: 'sai' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('LOGIN_FAILED');
    // Không phân biệt sai-user/sai-password, không echo username.
    expect(res.body).not.toContain('alice.rat.dai');
    expect(sessions.sessions.size).toBe(0);
  });

  it('server LDAP chết → 502 LDAP_UNREACHABLE', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onBind: () => {
            throw new Error('connect ECONNREFUSED');
          },
        }),
    );
    const { app } = build({ row: ldapConfigRow(), factory });
    const res = await app.inject({ ...LOGIN, payload: { username: 'a', password: 'p' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('LDAP_UNREACHABLE');
  });

  it('cấu hình hỏng (không khai template lẫn search base) → 500 với thông điệp an toàn', async () => {
    const { app } = build({
      row: ldapConfigRow({ userDnTemplate: null, searchBase: null }),
    });
    const res = await app.inject({ ...LOGIN, payload: { username: 'a', password: 'p' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('CONFIG_INVALID');
  });

  it('LDAP chưa bật → 404 AUTH_MODE_HEADER', async () => {
    for (const row of [null, ldapConfigRow({ enabled: false })]) {
      const { app } = build({ row });
      const res = await app.inject({ ...LOGIN, payload: { username: 'a', password: 'p' } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('AUTH_MODE_HEADER');
    }
  });

  it('AUTH_FORCE_HEADER=1 → 404 dù config bật', async () => {
    const { app } = build({ row: ldapConfigRow({ enabled: true }), forceHeader: true });
    const res = await app.inject({ ...LOGIN, payload: { username: 'a', password: 'p' } });
    expect(res.statusCode).toBe(404);
  });

  it('thiếu username/password → 400 BAD_REQUEST', async () => {
    const { app } = build({ row: ldapConfigRow() });
    const res = await app.inject({ ...LOGIN, payload: { username: 'a' } });
    expect(res.statusCode).toBe(400);
  });

  it('quá 10 lượt sai trong 5 phút từ một IP → 429, hết cửa sổ thì mở lại', async () => {
    let t = 1_000_000;
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onBind: () => {
            throw new InvalidCredentialsError();
          },
        }),
    );
    const { app } = build({ row: ldapConfigRow(), factory, now: () => t });

    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({ ...LOGIN, payload: { username: 'a', password: 'sai' } });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await app.inject({ ...LOGIN, payload: { username: 'a', password: 'sai' } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('TOO_MANY_ATTEMPTS');

    // Sau 5 phút bộ đếm trượt ra ngoài cửa sổ → được thử lại.
    t += 5 * 60 * 1000 + 1;
    const retry = await app.inject({ ...LOGIN, payload: { username: 'a', password: 'sai' } });
    expect(retry.statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('có cookie → huỷ phiên + xoá cookie, 204', async () => {
    const { app, sessions } = build({ row: ldapConfigRow() });
    await app.inject({ ...LOGIN, payload: { username: 'alice', password: 'pw' } });
    expect(sessions.sessions.size).toBe(1);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: 'ptb_sess=sess-1' },
    });
    expect(res.statusCode).toBe(204);
    expect(sessions.sessions.size).toBe(0);
    expect(res.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('không có cookie vẫn 204 (logout luôn "thành công")', async () => {
    const { app } = build({ row: null });
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(204);
  });
});

describe('GET /api/admin/auth/ldap', () => {
  const GET_CFG = { method: 'GET' as const, url: '/api/admin/auth/ldap' };

  it('trả view đúng schema; password chỉ hiện dưới dạng hasBindPassword', async () => {
    const { app } = build({
      principal: asAdmin(),
      row: ldapConfigRow({
        userDnTemplate: null,
        searchBase: 'ou=users,dc=x',
        bindDn: 'cn=svc,dc=x',
        bindPasswordEnc: 'sealed(bi-mat)',
      }),
    });
    const res = await app.inject(GET_CFG);
    expect(res.statusCode).toBe(200);
    const view = ldapConfigSchema.parse(res.json());
    expect(view.hasBindPassword).toBe(true);
    // Tuyệt đối không lộ password — kể cả bản mã hoá.
    expect(res.body).not.toContain('bi-mat');
    expect(res.body).not.toContain('sealed');
  });

  it('chưa từng cấu hình → view mặc định (enabled=false)', async () => {
    const { app } = build({ principal: asAdmin(), row: null });
    const view = ldapConfigSchema.parse((await app.inject(GET_CFG)).json());
    expect(view).toMatchObject({ enabled: false, hasBindPassword: false, sessionTtlHours: 12 });
  });

  it('401 khi chưa đăng nhập, 403 khi không phải ADMIN', async () => {
    expect((await build({ principal: null }).app.inject(GET_CFG)).statusCode).toBe(401);
    expect((await build({ principal: asNobody() }).app.inject(GET_CFG)).statusCode).toBe(403);
  });
});

describe('PUT /api/admin/auth/ldap', () => {
  const put = (app: FastifyInstance, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/api/admin/auth/ldap', payload });

  const STB_BODY = {
    enabled: false,
    serverUrl: 'ldap://ldap.x.vn:389',
    bindDn: 'cn=svc,dc=x,dc=vn',
    searchBase: 'ou=users,dc=x,dc=vn',
    userFilter: '(mail={username})',
  };

  it('bindPassword là WRITE-ONLY: lưu bản mã hoá, response không bao giờ chứa nó', async () => {
    const ctx = build({ principal: asAdmin('boss@x.com'), row: null });
    const res = await put(ctx.app, { ...STB_BODY, bindPassword: 'svc-secret' });
    expect(res.statusCode).toBe(200);

    const view = ldapConfigSchema.parse(res.json());
    expect(view.hasBindPassword).toBe(true);
    expect(view.updatedBy).toBe('boss@x.com');
    expect(res.body).not.toContain('svc-secret');
    // Lưu bản MÃ HOÁ, không phải plaintext.
    expect(ctx.store.row?.bindPasswordEnc).toBe('sealed(svc-secret)');
    expect(ctx.invalidations()).toBe(1);
  });

  it('không gửi bindPassword → GIỮ password cũ; gửi null → XOÁ', async () => {
    const row = ldapConfigRow({
      enabled: false,
      userDnTemplate: null,
      searchBase: 'ou=users,dc=x',
      bindDn: 'cn=svc,dc=x',
      bindPasswordEnc: 'sealed(cu)',
    });
    const keep = build({ principal: asAdmin(), row });
    await put(keep.app, STB_BODY);
    expect(keep.store.row?.bindPasswordEnc).toBe('sealed(cu)');

    const clear = build({ principal: asAdmin(), row: { ...row } });
    await put(clear.app, { ...STB_BODY, bindPassword: null });
    expect(clear.store.row?.bindPasswordEnc).toBeNull();
  });

  it('KHÔNG khai userDnTemplate lẫn searchBase → 400 BAD_REQUEST, không lưu', async () => {
    const { app, store } = build({ principal: asAdmin(), row: null });
    const neither = await put(app, { ...STB_BODY, searchBase: null });
    expect(neither.statusCode).toBe(400);
    expect(neither.json().error).toBe('BAD_REQUEST');
    expect(store.upserts).toHaveLength(0);
  });

  it('khai CẢ template lẫn searchBase (AD direct-bind + tự tra email, không tài khoản dịch vụ) → lưu', async () => {
    const { app, store } = build({ principal: asAdmin(), row: null });
    const res = await put(app, {
      enabled: false,
      serverUrl: 'ldaps://10.135.62.50:636',
      userDnTemplate: 'fst.com.vn\\{username}',
      searchBase: 'DC=fst,DC=vn',
      userFilter: '(cn={username})',
    });
    expect(res.statusCode).toBe(200);
    // Lưu direct-bind AD: có CẢ template lẫn searchBase, KHÔNG có tài khoản dịch vụ.
    expect(store.row?.userDnTemplate).toBe('fst.com.vn\\{username}');
    expect(store.row?.searchBase).toBe('DC=fst,DC=vn');
    expect(store.row?.bindDn).toBeNull();
    expect(store.row?.bindPasswordEnc).toBeNull();
  });

  it('bindPassword mới mà thiếu APP_ENCRYPTION_KEY → 400 ENCRYPTION_KEY_MISSING', async () => {
    const { app, store } = build({ principal: asAdmin(), row: null, tokenBox: null });
    const res = await put(app, { ...STB_BODY, bindPassword: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ENCRYPTION_KEY_MISSING');
    expect(store.upserts).toHaveLength(0);
  });

  it('CHỐNG TỰ KHÓA: enabled=true mà test kết nối trượt → 400 LDAP_TEST_FAILED, KHÔNG lưu', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onBind: () => {
            throw new Error('connect ECONNREFUSED');
          },
        }),
    );
    const { app, store } = build({ principal: asAdmin(), row: null, factory });
    const res = await put(app, {
      ...STB_BODY,
      enabled: true,
      bindPassword: 'svc-secret',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('LDAP_TEST_FAILED');
    expect(res.json().message).toContain('CONNECT'); // bước trượt + chi tiết
    expect(store.upserts).toHaveLength(0); // tuyệt đối không lưu cấu hình hỏng
  });

  it('enabled=true qua được test (password GIỮ LẠI được giải mã để test) → lưu', async () => {
    const ldap = fakeLdapFactory(() => new FakeLdapClient({ onSearch: () => [] }));
    const { app, store } = build({
      principal: asAdmin(),
      row: ldapConfigRow({
        enabled: false,
        userDnTemplate: null,
        searchBase: 'ou=users,dc=x,dc=vn',
        bindDn: 'cn=svc,dc=x,dc=vn',
        bindPasswordEnc: 'sealed(svc-secret)',
      }),
      factory: ldap.factory,
    });
    const res = await put(app, { ...STB_BODY, enabled: true }); // KHÔNG gửi lại password
    expect(res.statusCode).toBe(200);
    expect(ldapConfigSchema.parse(res.json()).enabled).toBe(true);
    // Bài test chống tự khoá đã bind bằng password ĐÃ GIẢI MÃ từ bản lưu.
    expect(ldap.clients[0]!.bindCalls[0]).toEqual({
      dn: 'cn=svc,dc=x,dc=vn',
      password: 'svc-secret',
    });
    expect(store.row?.enabled).toBe(true);
    expect(store.row?.bindPasswordEnc).toBe('sealed(svc-secret)');
  });

  it('403 với người không phải ADMIN', async () => {
    const { app } = build({ principal: asNobody() });
    expect((await put(app, STB_BODY)).statusCode).toBe(403);
  });
});

describe('POST /api/admin/auth/ldap/test', () => {
  it('chạy test với giá trị CHƯA LƯU; bindPassword không gửi → dùng bản lưu đã giải mã', async () => {
    const ldap = fakeLdapFactory(() => new FakeLdapClient({ onSearch: () => [] }));
    const { app } = build({
      principal: asAdmin(),
      row: ldapConfigRow({
        userDnTemplate: null,
        searchBase: 'ou=cu,dc=x',
        bindDn: 'cn=svc,dc=x',
        bindPasswordEnc: 'sealed(svc-secret)',
      }),
      factory: ldap.factory,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/ldap/test',
      payload: {
        serverUrl: 'ldaps://moi.x.vn:636',
        bindDn: 'cn=svc,dc=x',
        searchBase: 'ou=moi,dc=x', // giá trị form CHƯA lưu
        userFilter: '(uid={username})',
        allowSelfSigned: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = ldapTestResponseSchema.parse(res.json());
    expect(body.ok).toBe(true);

    // Giá trị chưa lưu thắng; password rơi về bản lưu (đã giải mã).
    expect(ldap.factoryArgs[0]).toEqual({ url: 'ldaps://moi.x.vn:636', allowSelfSigned: true });
    expect(ldap.clients[0]!.bindCalls[0]!.password).toBe('svc-secret');
    expect(ldap.clients[0]!.searchCalls[0]!.base).toBe('ou=moi,dc=x');
  });

  it('cấu hình thiếu → ok=false với bước hỏng, vẫn 200 (kết quả test, không phải lỗi HTTP)', async () => {
    const { app } = build({ principal: asAdmin(), row: null });
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/ldap/test',
      payload: { serverUrl: null },
    });
    expect(res.statusCode).toBe(200);
    const body = ldapTestResponseSchema.parse(res.json());
    expect(body.ok).toBe(false);
    expect(body.steps[0]).toMatchObject({ step: 'CONNECT', ok: false });
  });

  it('401/403 theo guard ADMIN', async () => {
    const anon = build({ principal: null });
    const member = build({ principal: asNobody() });
    const req = { method: 'POST' as const, url: '/api/admin/auth/ldap/test', payload: {} };
    expect((await anon.app.inject(req)).statusCode).toBe(401);
    expect((await member.app.inject(req)).statusCode).toBe(403);
  });
});
