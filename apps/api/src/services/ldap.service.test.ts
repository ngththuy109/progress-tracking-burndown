import { describe, it, expect } from 'vitest';
import { InvalidCredentialsError, NoSuchObjectError } from 'ldapts';
import {
  authenticate,
  escapeLdapDnValue,
  escapeLdapFilterValue,
  testConnection,
  TEST_PROBE_USERNAME,
  type LdapEffectiveConfig,
} from './ldap.service.js';
import { FakeLdapClient, fakeLdapFactory } from '../test-fakes.js';

/** Direct bind: DN dựng từ template. */
function directCfg(over: Partial<LdapEffectiveConfig> = {}): LdapEffectiveConfig {
  return {
    serverUrl: 'ldap://ldap.x.vn:389',
    bindDn: null,
    bindPassword: null,
    userDnTemplate: 'uid={username},ou=users,dc=x,dc=vn',
    searchBase: null,
    userFilter: '(mail={username})',
    emailAttribute: 'mail',
    allowSelfSigned: false,
    ...over,
  };
}

/** Search-then-bind: tài khoản dịch vụ + search base. */
function stbCfg(over: Partial<LdapEffectiveConfig> = {}): LdapEffectiveConfig {
  return directCfg({
    userDnTemplate: null,
    searchBase: 'ou=users,dc=x,dc=vn',
    bindDn: 'cn=svc,dc=x,dc=vn',
    bindPassword: 'svc-pass',
    ...over,
  });
}

/** AD direct-bind + tự tra email: template (bind mật khẩu user) + search base, KHÔNG tài khoản dịch vụ. */
function directSearchCfg(over: Partial<LdapEffectiveConfig> = {}): LdapEffectiveConfig {
  return directCfg({
    userDnTemplate: 'fst.com.vn\\{username}',
    searchBase: 'DC=fst,DC=vn',
    userFilter: '(cn={username})',
    ...over,
  });
}

describe('escapeLdapFilterValue (RFC 4515)', () => {
  it('escape đủ 4 ký tự đặc biệt + NUL thành mã hex', () => {
    expect(escapeLdapFilterValue('a*b(c)d\\e\0f')).toBe('a\\2ab\\28c\\29d\\5ce\\00f');
  });

  it('vô hiệu hoá payload injection kinh điển "a)(uid=*"', () => {
    expect(escapeLdapFilterValue('a)(uid=*')).toBe('a\\29\\28uid=\\2a');
  });

  it('chuỗi lành để nguyên', () => {
    expect(escapeLdapFilterValue('alice.nguyen@x.vn')).toBe('alice.nguyen@x.vn');
  });
});

describe('escapeLdapDnValue (RFC 4514)', () => {
  it('escape ký tự đặc biệt của DN bằng backslash', () => {
    expect(escapeLdapDnValue('a,ou=admins')).toBe('a\\,ou\\=admins');
    expect(escapeLdapDnValue('a+b;c<d>e"f\\g')).toBe('a\\+b\\;c\\<d\\>e\\"f\\\\g');
  });

  it('khoảng trắng ở mép và # ở đầu bị escape, ở giữa thì không', () => {
    expect(escapeLdapDnValue(' a b ')).toBe('\\ a b\\ ');
    expect(escapeLdapDnValue('#tag')).toBe('\\#tag');
    expect(escapeLdapDnValue('a#b')).toBe('a#b');
  });

  it('NUL thành \\00', () => {
    expect(escapeLdapDnValue('a\0b')).toBe('a\\00b');
  });
});

describe('authenticate — chốt an toàn mật khẩu rỗng', () => {
  it('mật khẩu rỗng bị từ chối TRƯỚC khi tạo bất kỳ kết nối nào (chặn anonymous bind)', async () => {
    const { factory, clients } = fakeLdapFactory(() => new FakeLdapClient());
    for (const password of ['', '   ', '\t']) {
      const result = await authenticate({
        config: directCfg(),
        username: 'alice',
        password,
        clientFactory: factory,
      });
      expect(result).toEqual({ error: 'LOGIN_FAILED' });
    }
    // Không một client nào được dựng — nghĩa là không có lượt bind nào cả.
    expect(clients).toHaveLength(0);
  });

  it('username rỗng cũng không tạo kết nối', async () => {
    const { factory, clients } = fakeLdapFactory(() => new FakeLdapClient());
    const result = await authenticate({
      config: directCfg(),
      username: '   ',
      password: 'x',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
    expect(clients).toHaveLength(0);
  });
});

describe('authenticate — direct bind', () => {
  it('bind đúng → đọc email từ entry (lowercase), unbind sạch', async () => {
    const { factory, clients } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onSearch: (base) => [{ dn: base, mail: 'Alice.Nguyen@X.vn' }],
        }),
    );
    const result = await authenticate({
      config: directCfg(),
      username: 'alice',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ email: 'alice.nguyen@x.vn' });

    const client = clients[0]!;
    expect(client.bindCalls).toEqual([{ dn: 'uid=alice,ou=users,dc=x,dc=vn', password: 'pw' }]);
    // Đọc email: search base = chính DN vừa bind, scope 'base'.
    expect(client.searchCalls).toEqual([
      {
        base: 'uid=alice,ou=users,dc=x,dc=vn',
        options: { scope: 'base', attributes: ['mail'] },
      },
    ]);
    expect(client.unbindCount).toBe(1);
  });

  it('username chứa ký tự DN đặc biệt được escape trước khi thế vào template', async () => {
    const { factory, clients } = fakeLdapFactory(
      () => new FakeLdapClient({ onSearch: () => [{ dn: 'x', mail: 'a@x.vn' }] }),
    );
    await authenticate({
      config: directCfg(),
      username: 'a,ou=admins',
      password: 'pw',
      clientFactory: factory,
    });
    expect(clients[0]!.bindCalls[0]!.dn).toBe('uid=a\\,ou\\=admins,ou=users,dc=x,dc=vn');
  });

  it('sai mật khẩu (InvalidCredentialsError) → LOGIN_FAILED', async () => {
    const { factory, clients } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onBind: () => {
            throw new InvalidCredentialsError();
          },
        }),
    );
    const result = await authenticate({
      config: directCfg(),
      username: 'alice',
      password: 'sai',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
    expect(clients[0]!.unbindCount).toBe(1); // vẫn đóng kết nối
  });

  it('entry không có attribute email → LOGIN_FAILED kèm chi tiết log server-side', async () => {
    const logs: string[] = [];
    const { factory } = fakeLdapFactory(
      () => new FakeLdapClient({ onSearch: (base) => [{ dn: base }] }),
    );
    const result = await authenticate({
      config: directCfg(),
      username: 'alice',
      password: 'pw',
      clientFactory: factory,
      log: (d) => logs.push(d),
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
    expect(logs.join(' ')).toContain('mail');
  });

  it('server không tới được → SERVER_UNREACHABLE', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onBind: () => {
            throw new Error('connect ECONNREFUSED 10.0.0.9:389');
          },
        }),
    );
    const result = await authenticate({
      config: directCfg(),
      username: 'alice',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'SERVER_UNREACHABLE' });
  });

  it('attribute email đọc không phân biệt hoa thường và nhận cả Buffer', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onSearch: (base) => [{ dn: base, MAIL: [Buffer.from('Bob@X.vn')] }],
        }),
    );
    const result = await authenticate({
      config: directCfg(),
      username: 'bob',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ email: 'bob@x.vn' });
  });
});

describe('authenticate — search-then-bind', () => {
  const USER_ENTRY = { dn: 'uid=alice,ou=users,dc=x,dc=vn', mail: 'Alice@X.vn' };

  it('happy path: bind dịch vụ → search → bind user trên KẾT NỐI MỚI', async () => {
    const { factory, clients } = fakeLdapFactory((index) =>
      index === 0 ? new FakeLdapClient({ onSearch: () => [USER_ENTRY] }) : new FakeLdapClient(),
    );
    const result = await authenticate({
      config: stbCfg(),
      username: 'alice',
      password: 'user-pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ email: 'alice@x.vn' });

    // Hai kết nối riêng biệt: dịch vụ rồi người dùng.
    expect(clients).toHaveLength(2);
    const [service, user] = [clients[0]!, clients[1]!];
    expect(service.bindCalls).toEqual([{ dn: 'cn=svc,dc=x,dc=vn', password: 'svc-pass' }]);
    expect(service.searchCalls).toEqual([
      {
        base: 'ou=users,dc=x,dc=vn',
        options: { scope: 'sub', filter: '(mail=alice)', attributes: ['mail'] },
      },
    ]);
    expect(user.bindCalls).toEqual([{ dn: USER_ENTRY.dn, password: 'user-pw' }]);
    expect(service.unbindCount).toBe(1);
    expect(user.unbindCount).toBe(1);
  });

  it('username độc trong filter được escape (chặn LDAP injection)', async () => {
    const { factory, clients } = fakeLdapFactory(() => new FakeLdapClient({ onSearch: () => [] }));
    await authenticate({
      config: stbCfg(),
      username: 'a)(uid=*',
      password: 'pw',
      clientFactory: factory,
    });
    expect(clients[0]!.searchCalls[0]!.options.filter).toBe('(mail=a\\29\\28uid=\\2a)');
  });

  it('0 kết quả → LOGIN_FAILED, không bind user', async () => {
    const { factory, clients } = fakeLdapFactory(() => new FakeLdapClient({ onSearch: () => [] }));
    const result = await authenticate({
      config: stbCfg(),
      username: 'ghost',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
    expect(clients).toHaveLength(1); // không có kết nối thứ hai
  });

  it('2 kết quả (filter nhập nhằng) → LOGIN_FAILED', async () => {
    const { factory, clients } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onSearch: () => [USER_ENTRY, { dn: 'uid=alice2,dc=x', mail: 'a2@x.vn' }],
        }),
    );
    const result = await authenticate({
      config: stbCfg(),
      username: 'alice',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
    expect(clients).toHaveLength(1);
  });

  it('user bind sai mật khẩu → LOGIN_FAILED', async () => {
    const { factory } = fakeLdapFactory((index) =>
      index === 0
        ? new FakeLdapClient({ onSearch: () => [USER_ENTRY] })
        : new FakeLdapClient({
            onBind: () => {
              throw new InvalidCredentialsError();
            },
          }),
    );
    const result = await authenticate({
      config: stbCfg(),
      username: 'alice',
      password: 'sai',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
  });

  it('entry thiếu attribute email → LOGIN_FAILED (trước cả bind user)', async () => {
    const { factory, clients } = fakeLdapFactory(
      () => new FakeLdapClient({ onSearch: () => [{ dn: USER_ENTRY.dn }] }),
    );
    const result = await authenticate({
      config: stbCfg(),
      username: 'alice',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
    expect(clients).toHaveLength(1);
  });

  it('thiếu bindDn/bindPassword của tài khoản dịch vụ → CONFIG_INVALID, không chạm mạng', async () => {
    const { factory, clients } = fakeLdapFactory(() => new FakeLdapClient());
    for (const over of [{ bindDn: null }, { bindPassword: null }] as const) {
      const result = await authenticate({
        config: stbCfg(over),
        username: 'alice',
        password: 'pw',
        clientFactory: factory,
      });
      expect(result).toEqual({ error: 'CONFIG_INVALID' });
    }
    expect(clients).toHaveLength(0);
  });

  it('tài khoản dịch vụ bị từ chối → CONFIG_INVALID (lỗi cấu hình, không phải của người dùng)', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onBind: () => {
            throw new InvalidCredentialsError();
          },
        }),
    );
    const result = await authenticate({
      config: stbCfg(),
      username: 'alice',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'CONFIG_INVALID' });
  });

  it('đứt mạng khi search → SERVER_UNREACHABLE', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onSearch: () => {
            throw new Error('socket hang up');
          },
        }),
    );
    const result = await authenticate({
      config: stbCfg(),
      username: 'alice',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'SERVER_UNREACHABLE' });
  });
});

describe('authenticate — direct bind + tự tra email (Active Directory)', () => {
  it('bind bằng mật khẩu user (template DOMAIN\\user) → tự tra email TRÊN CÙNG kết nối', async () => {
    const { factory, clients } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onSearch: () => [{ dn: 'CN=Alice,OU=NV,DC=fst,DC=vn', mail: 'Alice@FST.vn' }],
        }),
    );
    const result = await authenticate({
      config: directSearchCfg(),
      username: 'alice',
      password: 'user-pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ email: 'alice@fst.vn' });

    // MỘT kết nối duy nhất, KHÔNG có tài khoản dịch vụ: bind bằng mật khẩu user.
    expect(clients).toHaveLength(1);
    const client = clients[0]!;
    expect(client.bindCalls).toEqual([{ dn: 'fst.com.vn\\alice', password: 'user-pw' }]);
    // Đọc email bằng subtree search theo filter, trong search base, TRÊN chính
    // kết nối vừa xác thực (không mở kết nối thứ hai).
    expect(client.searchCalls).toEqual([
      {
        base: 'DC=fst,DC=vn',
        options: { scope: 'sub', filter: '(cn=alice)', attributes: ['mail'] },
      },
    ]);
    expect(client.unbindCount).toBe(1);
  });

  it('username độc trong filter được escape (chặn LDAP injection)', async () => {
    const { factory, clients } = fakeLdapFactory(
      () => new FakeLdapClient({ onSearch: () => [{ dn: 'x', mail: 'a@fst.vn' }] }),
    );
    await authenticate({
      config: directSearchCfg(),
      username: 'a)(uid=*',
      password: 'pw',
      clientFactory: factory,
    });
    expect(clients[0]!.searchCalls[0]!.options.filter).toBe('(cn=a\\29\\28uid=\\2a)');
  });

  it('0 kết quả (không tra được email) → LOGIN_FAILED, dù đã bind thành công', async () => {
    const { factory, clients } = fakeLdapFactory(() => new FakeLdapClient({ onSearch: () => [] }));
    const result = await authenticate({
      config: directSearchCfg(),
      username: 'ghost',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
    expect(clients[0]!.bindCalls).toHaveLength(1);
  });

  it('>1 kết quả (filter nhập nhằng) → LOGIN_FAILED', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onSearch: () => [
            { dn: 'CN=A1,DC=fst,DC=vn', mail: 'a1@fst.vn' },
            { dn: 'CN=A2,DC=fst,DC=vn', mail: 'a2@fst.vn' },
          ],
        }),
    );
    const result = await authenticate({
      config: directSearchCfg(),
      username: 'alice',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
  });

  it('sai mật khẩu (bind bị từ chối) → LOGIN_FAILED, KHÔNG tra email', async () => {
    const { factory, clients } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onBind: () => {
            throw new InvalidCredentialsError();
          },
        }),
    );
    const result = await authenticate({
      config: directSearchCfg(),
      username: 'alice',
      password: 'sai',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
    expect(clients[0]!.searchCalls).toHaveLength(0);
    expect(clients[0]!.unbindCount).toBe(1);
  });

  it('tra được entry nhưng thiếu attribute email → LOGIN_FAILED', async () => {
    const { factory } = fakeLdapFactory(
      () => new FakeLdapClient({ onSearch: () => [{ dn: 'CN=Alice,DC=fst,DC=vn' }] }),
    );
    const result = await authenticate({
      config: directSearchCfg(),
      username: 'alice',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'LOGIN_FAILED' });
  });

  it('đứt mạng khi tra email → SERVER_UNREACHABLE', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onSearch: () => {
            throw new Error('socket hang up');
          },
        }),
    );
    const result = await authenticate({
      config: directSearchCfg(),
      username: 'alice',
      password: 'pw',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'SERVER_UNREACHABLE' });
  });
});

describe('authenticate — cấu hình hỏng', () => {
  it('thiếu serverUrl → CONFIG_INVALID', async () => {
    const { factory } = fakeLdapFactory(() => new FakeLdapClient());
    const result = await authenticate({
      config: directCfg({ serverUrl: null }),
      username: 'a',
      password: 'p',
      clientFactory: factory,
    });
    expect(result).toEqual({ error: 'CONFIG_INVALID' });
  });

  it('KHÔNG khai userDnTemplate lẫn searchBase → CONFIG_INVALID', async () => {
    const { factory } = fakeLdapFactory(() => new FakeLdapClient());
    const neither = await authenticate({
      config: directCfg({ userDnTemplate: null }),
      username: 'a',
      password: 'p',
      clientFactory: factory,
    });
    expect(neither).toEqual({ error: 'CONFIG_INVALID' });
  });
});

describe('testConnection — tính đầy đủ của cấu hình (chưa chạm mạng)', () => {
  const noNetwork = fakeLdapFactory(() => {
    throw new Error('testConnection không được chạm mạng ở bước kiểm đầy đủ');
  });

  it('thiếu serverUrl → CONNECT fail', async () => {
    const res = await testConnection({
      config: directCfg({ serverUrl: null }),
      clientFactory: noNetwork.factory,
    });
    expect(res.ok).toBe(false);
    expect(res.steps).toEqual([
      { step: 'CONNECT', ok: false, detail: expect.stringContaining('Server URL') },
    ]);
  });

  it('không khai chế độ nào → BIND fail', async () => {
    const res = await testConnection({
      config: directCfg({ userDnTemplate: null }),
      clientFactory: noNetwork.factory,
    });
    expect(res.ok).toBe(false);
    expect(res.steps[0]).toMatchObject({ step: 'BIND', ok: false });
  });

  it('search-then-bind thiếu tài khoản dịch vụ → BIND fail', async () => {
    for (const over of [{ bindDn: null }, { bindPassword: null }] as const) {
      const res = await testConnection({
        config: stbCfg(over),
        clientFactory: noNetwork.factory,
      });
      expect(res.ok).toBe(false);
      expect(res.steps[0]).toMatchObject({ step: 'BIND', ok: false });
      expect(res.steps[0]!.detail).toContain('service account');
    }
  });
});

describe('testConnection — direct bind', () => {
  it('kết nối được → 3 bước ok, BIND ghi rõ "direct bind", SEARCH được bỏ qua', async () => {
    const { factory, clients } = fakeLdapFactory(() => new FakeLdapClient());
    const res = await testConnection({ config: directCfg(), clientFactory: factory });
    expect(res.ok).toBe(true);
    expect(res.steps.map((s) => [s.step, s.ok])).toEqual([
      ['CONNECT', true],
      ['BIND', true],
      ['SEARCH', true],
    ]);
    expect(res.steps[1]!.detail).toBe(
      'direct bind — no service account used, connection check only',
    );
    // Kiểm kết nối bằng một lượt đọc root DSE nặc danh, không bind gì.
    expect(clients[0]!.searchCalls[0]!.base).toBe('');
    expect(clients[0]!.bindCalls).toHaveLength(0);
    expect(clients[0]!.unbindCount).toBe(1);
  });

  it('AD direct-bind (template + search base): 3 bước ok, không dùng tài khoản dịch vụ', async () => {
    const { factory, clients } = fakeLdapFactory(() => new FakeLdapClient());
    const res = await testConnection({ config: directSearchCfg(), clientFactory: factory });
    expect(res.ok).toBe(true);
    expect(res.steps.map((s) => [s.step, s.ok])).toEqual([
      ['CONNECT', true],
      ['BIND', true],
      ['SEARCH', true],
    ]);
    // Chỉ đọc root DSE nặc danh để kiểm kết nối — KHÔNG bind tài khoản dịch vụ.
    expect(clients[0]!.bindCalls).toHaveLength(0);
    expect(clients[0]!.searchCalls[0]!.base).toBe('');
    // SEARCH nói rõ email sẽ được tra bằng kết nối của user khi đăng nhập thật.
    expect(res.steps[2]!.detail).toContain("user's own connection");
  });

  it('server từ chối đọc nặc danh (mã LDAP) vẫn tính là NỐI ĐƯỢC', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onSearch: () => {
            throw new NoSuchObjectError();
          },
        }),
    );
    const res = await testConnection({ config: directCfg(), clientFactory: factory });
    expect(res.ok).toBe(true);
  });

  it('không nối được → CONNECT fail, dừng ngay', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onSearch: () => {
            throw new Error('connect ETIMEDOUT');
          },
        }),
    );
    const res = await testConnection({ config: directCfg(), clientFactory: factory });
    expect(res.ok).toBe(false);
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0]).toMatchObject({ step: 'CONNECT', ok: false });
  });
});

describe('testConnection — search-then-bind', () => {
  it('bind dịch vụ ok + filter chạy được (0 kết quả) → cả 3 bước ok', async () => {
    const { factory, clients } = fakeLdapFactory(() => new FakeLdapClient({ onSearch: () => [] }));
    const res = await testConnection({ config: stbCfg(), clientFactory: factory });
    expect(res.ok).toBe(true);
    expect(res.steps.map((s) => [s.step, s.ok])).toEqual([
      ['CONNECT', true],
      ['BIND', true],
      ['SEARCH', true],
    ]);
    // Bước SEARCH dùng username thử cố ý không tồn tại, đã escape vào filter.
    expect(clients[0]!.searchCalls[0]!.options.filter).toBe(`(mail=${TEST_PROBE_USERNAME})`);
    expect(clients[0]!.searchCalls[0]!.base).toBe('ou=users,dc=x,dc=vn');
  });

  it('bind dịch vụ bị từ chối → CONNECT ok, BIND fail, KHÔNG chạy SEARCH', async () => {
    const { factory, clients } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onBind: () => {
            throw new InvalidCredentialsError();
          },
        }),
    );
    const res = await testConnection({ config: stbCfg(), clientFactory: factory });
    expect(res.ok).toBe(false);
    expect(res.steps.map((s) => [s.step, s.ok])).toEqual([
      ['CONNECT', true],
      ['BIND', false],
    ]);
    expect(clients[0]!.searchCalls).toHaveLength(0);
  });

  it('không nối được → CONNECT fail duy nhất', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onBind: () => {
            throw new Error('connect ECONNREFUSED');
          },
        }),
    );
    const res = await testConnection({ config: stbCfg(), clientFactory: factory });
    expect(res.steps).toEqual([{ step: 'CONNECT', ok: false, detail: expect.any(String) }]);
  });

  it('search base hỏng → SEARCH fail (CONNECT/BIND vẫn ok)', async () => {
    const { factory } = fakeLdapFactory(
      () =>
        new FakeLdapClient({
          onSearch: () => {
            throw new NoSuchObjectError();
          },
        }),
    );
    const res = await testConnection({ config: stbCfg(), clientFactory: factory });
    expect(res.ok).toBe(false);
    expect(res.steps.map((s) => [s.step, s.ok])).toEqual([
      ['CONNECT', true],
      ['BIND', true],
      ['SEARCH', false],
    ]);
  });
});
