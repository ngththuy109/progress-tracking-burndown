import { describe, expect, it } from 'vitest';
import { ApiError } from './client.js';
import {
  createQueryClient,
  funnelExpiredLdapSession,
  shouldRetry,
  STALE_TIME_MS,
} from './query-client.js';
import { authModeKey } from './use-auth-mode.js';
import { meKey } from './use-me.js';

const apiError = (status: number | null) =>
  new ApiError({ code: 'X', message: 'lỗi', status });

describe('shouldRetry', () => {
  it('KHÔNG thử lại lỗi do người dùng nhập sai (4xx)', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(shouldRetry(0, apiError(status)), `HTTP ${status}`).toBe(false);
    }
  });

  it('CÓ thử lại khi máy chủ bận hoặc lỗi tạm', () => {
    for (const status of [429, 500, 502, 503]) {
      expect(shouldRetry(0, apiError(status)), `HTTP ${status}`).toBe(true);
    }
  });

  it('CÓ thử lại khi chưa tới được máy chủ', () => {
    expect(shouldRetry(0, apiError(null))).toBe(true);
  });

  it('chỉ thử lại đúng MỘT lần', () => {
    expect(shouldRetry(1, apiError(500))).toBe(false);
  });

  it('lỗi lạ không phải ApiError vẫn được thử lại một lần', () => {
    expect(shouldRetry(0, new Error('gì đó'))).toBe(true);
  });
});

describe('createQueryClient', () => {
  it('tắt refetchOnWindowFocus — số liệu chốt theo ngày, chuyển tab không đổi gì', () => {
    const options = createQueryClient().getDefaultOptions();
    expect(options.queries?.refetchOnWindowFocus).toBe(false);
  });

  it('KHÔNG bao giờ tự gửi lại thao tác ghi', () => {
    // Một PUT có thể đã thành công rồi mới đứt mạng ở đường về. Gửi lại là ghi
    // đè lần thứ hai — tệ hơn nhiều so với hiện lỗi.
    const options = createQueryClient().getDefaultOptions();
    expect(options.mutations?.retry).toBe(false);
  });

  it('staleTime là 30 giây', () => {
    expect(createQueryClient().getDefaultOptions().queries?.staleTime).toBe(STALE_TIME_MS);
    expect(STALE_TIME_MS).toBe(30_000);
  });
});

describe('funnelExpiredLdapSession — 401 giữa phiên đổ về form đăng nhập', () => {
  const ME = { userId: 'pm@example.com', isAdmin: false, projects: [] };

  it('mode LDAP + 401 → cache /api/me về null (AuthGate tự hiện form)', () => {
    const client = createQueryClient();
    client.setQueryData(authModeKey, { mode: 'LDAP' });
    client.setQueryData(meKey, ME);

    funnelExpiredLdapSession(client, apiError(401));
    expect(client.getQueryData(meKey)).toBeNull();
  });

  it('mode HEADER thì KHÔNG đụng vào cache — 401 đi đường cũ', () => {
    const client = createQueryClient();
    client.setQueryData(authModeKey, { mode: 'HEADER' });
    client.setQueryData(meKey, ME);

    funnelExpiredLdapSession(client, apiError(401));
    expect(client.getQueryData(meKey)).toEqual(ME);
  });

  it('lỗi khác 401 (kể cả không phải ApiError) thì bỏ qua', () => {
    const client = createQueryClient();
    client.setQueryData(authModeKey, { mode: 'LDAP' });
    client.setQueryData(meKey, ME);

    funnelExpiredLdapSession(client, apiError(500));
    funnelExpiredLdapSession(client, new Error('lạ'));
    expect(client.getQueryData(meKey)).toEqual(ME);
  });
});
