import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LdapConfigView, LdapTestResponse, MeResponse } from '@app/shared';
import { AdminLdapScreen, buildLdapBody, ldapSaveHint, type LdapFormState } from './index.js';
import { ApiError } from '../../api/client.js';

/**
 * Màn hình cấu hình LDAP (chỉ ADMIN): hai cách xác định user loại trừ nhau,
 * bind password ba trạng thái (giữ/xóa/thay), nút Test render từng bước, và
 * công tắc bật phải kèm cảnh báo lối thoát AUTH_FORCE_HEADER.
 */

const ADMIN: MeResponse = { userId: 'admin@example.com', role: 'ADMIN', projects: [] };

/** Bản đã lưu kiểu SEARCH-BIND (Active Directory) — có mật khẩu dịch vụ. */
const CONFIG: LdapConfigView = {
  enabled: false,
  serverUrl: 'ldaps://ldap.congty.vn:636',
  bindDn: 'cn=svc,ou=service,dc=congty,dc=vn',
  hasBindPassword: true,
  userDnTemplate: null,
  searchBase: 'ou=users,dc=congty,dc=vn',
  userFilter: '(sAMAccountName={username})',
  emailAttribute: 'mail',
  allowSelfSigned: false,
  sessionTtlHours: 12,
  updatedBy: 'admin@example.com',
  updatedAt: '2026-08-01T03:00:00.000Z',
};

const TEST_RESULT: LdapTestResponse = {
  ok: false,
  steps: [
    { step: 'CONNECT', ok: true, detail: 'TLS OK (ldaps 636)' },
    { step: 'BIND', ok: false, detail: 'invalid credentials (49)' },
  ],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function stubApi(config: LdapConfigView = CONFIG): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });

      if (url.startsWith('/api/me')) return Promise.resolve(json(ADMIN));
      if (url.startsWith('/api/admin/auth/ldap/test')) return Promise.resolve(json(TEST_RESULT));
      if (url.startsWith('/api/admin/auth/ldap')) {
        if (method === 'PUT') return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(json(config));
      }
      throw new Error(`fetch bất ngờ: ${method} ${url}`);
    }),
  );
  return calls;
}

function renderScreen(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AdminLdapScreen />
    </QueryClientProvider>,
  );
}

const putBodies = (calls: RecordedCall[]): unknown[] =>
  calls.filter((c) => c.method === 'PUT').map((c) => c.body);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AdminLdapScreen — hai cách xác định user', () => {
  it('bản lưu kiểu search-bind → radio AD được chọn, đủ 4 ô search; đổi radio là đổi bộ ô', async () => {
    stubApi();
    renderScreen();

    // Config có searchBase (không template) → radio "Search rồi bind" chọn sẵn.
    const searchRadio = await screen.findByLabelText('Search rồi bind (Active Directory)');
    expect((searchRadio as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Search base') as HTMLInputElement).value).toBe(
      'ou=users,dc=congty,dc=vn',
    );
    expect(screen.getByLabelText('User filter (chứa {username})')).toBeTruthy();
    expect(screen.getByLabelText('Bind DN (tài khoản dịch vụ)')).toBeTruthy();
    expect(screen.queryByLabelText('Template DN (chứa {username})')).toBeNull();

    // Đổi sang direct bind → bộ ô search biến mất, ô template hiện ra.
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Direct bind (template DN)'));
    expect(screen.getByLabelText('Template DN (chứa {username})')).toBeTruthy();
    expect(screen.queryByLabelText('Search base')).toBeNull();
    expect(screen.queryByLabelText('Bind password (chỉ ghi — không bao giờ hiển thị lại)')).toBeNull();
  });

  it('lưu ở mode direct bind chỉ gửi trường liên quan — các trường search là null', async () => {
    const calls = stubApi();
    renderScreen();
    const user = userEvent.setup();

    await user.click(await screen.findByLabelText('Direct bind (template DN)'));
    await user.type(
      screen.getByLabelText('Template DN (chứa {username})'),
      // `{{` là cách user-event gõ dấu `{` theo nghĩa đen; `}` thì gõ thẳng.
      'uid={{username},ou=users,dc=congty,dc=vn',
    );
    await user.click(screen.getByRole('button', { name: 'Lưu' }));

    await waitFor(() => expect(putBodies(calls)).toHaveLength(1));
    expect(putBodies(calls)[0]).toMatchObject({
      userDnTemplate: 'uid={username},ou=users,dc=congty,dc=vn',
      searchBase: null,
      bindDn: null,
      bindPassword: null,
    });
  });
});

describe('AdminLdapScreen — bind password ba trạng thái', () => {
  it('đã có mật khẩu thì ô hiện "•••• (đã lưu)"; không đụng tới thì PUT KHÔNG gửi trường bindPassword', async () => {
    const calls = stubApi();
    renderScreen();
    const user = userEvent.setup();

    const pw = (await screen.findByLabelText(
      'Bind password (chỉ ghi — không bao giờ hiển thị lại)',
    )) as HTMLInputElement;
    expect(pw.placeholder).toBe('•••• (đã lưu)');

    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(putBodies(calls)).toHaveLength(1));
    const body = putBodies(calls)[0] as Record<string, unknown>;
    expect('bindPassword' in body).toBe(false); // không gửi = GIỮ mật khẩu cũ
    expect(body['searchBase']).toBe('ou=users,dc=congty,dc=vn');
  });

  it('tick "Xóa bind password đã lưu" → gửi null; gõ mật khẩu mới → gửi chuỗi', async () => {
    const calls = stubApi();
    renderScreen();
    const user = userEvent.setup();

    const clearBox = await screen.findByLabelText('Xóa bind password đã lưu');
    await user.click(clearBox);
    // Đang xóa thì ô nhập bị khóa — hai ý định không chồng lên nhau được.
    expect(
      (screen.getByLabelText('Bind password (chỉ ghi — không bao giờ hiển thị lại)') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(putBodies(calls)).toHaveLength(1));
    expect(putBodies(calls)[0]).toMatchObject({ bindPassword: null });

    await user.click(clearBox); // bỏ tick
    await user.type(
      screen.getByLabelText('Bind password (chỉ ghi — không bao giờ hiển thị lại)'),
      'matkhau-moi',
    );
    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(putBodies(calls)).toHaveLength(2));
    expect(putBodies(calls)[1]).toMatchObject({ bindPassword: 'matkhau-moi' });
  });
});

describe('AdminLdapScreen — Test và công tắc bật', () => {
  it('nút Test gửi giá trị form và render kết quả TỪNG BƯỚC nguyên văn', async () => {
    const calls = stubApi();
    renderScreen();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '🔌 Test' }));

    const steps = await screen.findByRole('list', { name: 'Kết quả test LDAP' });
    expect(steps.textContent).toContain('CONNECT');
    expect(steps.textContent).toContain('TLS OK (ldaps 636)');
    expect(steps.textContent).toContain('BIND');
    expect(steps.textContent).toContain('invalid credentials (49)');
    expect(screen.getByText(/Test CHƯA pass/)).toBeTruthy();

    const testCall = calls.find((c) => c.url.startsWith('/api/admin/auth/ldap/test'));
    expect(testCall?.method).toBe('POST');
    expect(testCall?.body).toMatchObject({
      serverUrl: 'ldaps://ldap.congty.vn:636',
      searchBase: 'ou=users,dc=congty,dc=vn',
      userFilter: '(sAMAccountName={username})',
    });
  });

  it('tick "Bật đăng nhập LDAP" là hiện ngay cảnh báo kèm lối thoát AUTH_FORCE_HEADER', async () => {
    stubApi();
    renderScreen();
    const user = userEvent.setup();

    expect(await screen.findByLabelText('Bật đăng nhập LDAP')).toBeTruthy();
    expect(screen.queryByText(/AUTH_FORCE_HEADER/)).toBeNull();

    await user.click(screen.getByLabelText('Bật đăng nhập LDAP'));
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toContain('TẮT đăng nhập qua header/cổng');
    expect(warning.textContent).toContain('AUTH_FORCE_HEADER=1');
  });
});

describe('buildLdapBody', () => {
  const FORM: LdapFormState = {
    enabled: false,
    serverUrl: ' ldaps://ldap.congty.vn:636 ',
    bindMode: 'SEARCH',
    userDnTemplate: 'uid={username},dc=x',
    searchBase: 'ou=users,dc=x',
    userFilter: '(mail={username})',
    bindDn: 'cn=svc,dc=x',
    bindPassword: '',
    clearBindPassword: false,
    emailAttribute: 'mail',
    sessionTtlHours: 12,
    allowSelfSigned: false,
  };

  it('mode SEARCH: template = null, ô mật khẩu rỗng thì KHÔNG có key bindPassword', () => {
    const body = buildLdapBody(FORM);
    expect(body.userDnTemplate).toBeNull();
    expect(body.searchBase).toBe('ou=users,dc=x');
    expect(body.serverUrl).toBe('ldaps://ldap.congty.vn:636'); // đã trim
    expect('bindPassword' in body).toBe(false);
  });

  it('mode TEMPLATE: mọi trường search về null (kể cả bindPassword — xóa mật khẩu dịch vụ)', () => {
    const body = buildLdapBody({ ...FORM, bindMode: 'TEMPLATE' });
    expect(body).toMatchObject({
      userDnTemplate: 'uid={username},dc=x',
      searchBase: null,
      bindDn: null,
      bindPassword: null,
    });
  });
});

describe('ldapSaveHint', () => {
  const err = (status: number, code: string): ApiError =>
    new ApiError({ code, message: 'msg', status });

  it('ba lỗi lưu đặc thù đều có câu hướng dẫn riêng', () => {
    expect(ldapSaveHint(err(400, 'LDAP_TEST_FAILED'))).toContain('bài test chưa pass');
    expect(ldapSaveHint(err(400, 'ENCRYPTION_KEY_MISSING'))).toContain('ENCRYPTION_KEY');
    expect(ldapSaveHint(err(400, 'BAD_REQUEST'))).toContain('MỘT trong hai cách');
  });

  it('lỗi khác không thêm gì — ErrorState tự hiện message của server', () => {
    expect(ldapSaveHint(err(500, 'SERVER_ERROR'))).toBeNull();
    expect(ldapSaveHint(new Error('lạ'))).toBeNull();
  });
});
