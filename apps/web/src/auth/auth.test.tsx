import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@app/shared';
import { ApiError } from '../api/client.js';
import { createQueryClient } from '../api/query-client.js';
import { AuthGate } from './auth-gate.js';
import { loginErrorMessage } from './login-screen.js';

/**
 * Cửa đăng nhập LDAP: mode = LDAP + `/api/me` 401 → thay app bằng form
 * tên/mật khẩu; mode = HEADER → app render như cũ, không form nào cả.
 *
 * Test dựng bằng `createQueryClient()` THẬT (không phải QueryClient trần) để
 * đi qua đúng đường ống 401 của production — kể cả funnel trong query-client.
 */

const ME: MeResponse = {
  userId: 'pm@example.com',
  role: 'PM',
  projects: ['PAY'],
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

/** Chặn `fetch` toàn cục, ghi lại từng lời gọi để soi payload. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Promise.resolve(handler(url, init));
    }),
  );
  return calls;
}

function renderGate(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AuthGate>
        <div>APP_OK</div>
      </AuthGate>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthGate — mode LDAP', () => {
  it('chưa đăng nhập (401) thì hiện form, không hiện app', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/mode')) return json({ mode: 'LDAP' });
      if (url.startsWith('/api/me')) return json({ error: 'UNAUTHENTICATED', message: 'x' }, 401);
      throw new Error(`fetch bất ngờ: ${url}`);
    });
    renderGate();

    expect(await screen.findByLabelText('Tên đăng nhập')).toBeTruthy();
    expect(screen.getByLabelText('Mật khẩu')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Đăng nhập' })).toBeTruthy();
    expect(screen.queryByText('APP_OK')).toBeNull();
  });

  it('submit gửi đúng payload POST /auth/login; 204 thì vào app không cần reload', async () => {
    let loggedIn = false;
    const calls = stubFetch((url) => {
      if (url.startsWith('/api/auth/mode')) return json({ mode: 'LDAP' });
      if (url.startsWith('/api/me')) {
        return loggedIn ? json(ME) : json({ error: 'UNAUTHENTICATED', message: 'x' }, 401);
      }
      if (url.startsWith('/auth/login')) {
        loggedIn = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`fetch bất ngờ: ${url}`);
    });
    renderGate();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Tên đăng nhập'), 'thuy.nguyen');
    await user.type(screen.getByLabelText('Mật khẩu'), 's3cret!');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    const login = calls.find((c) => c.url.startsWith('/auth/login'));
    expect(login?.method).toBe('POST');
    expect(login?.body).toEqual({ username: 'thuy.nguyen', password: 's3cret!' });

    // 204 → invalidate cache → /api/me nạp lại → gate tự mở app.
    expect(await screen.findByText('APP_OK')).toBeTruthy();
  });

  it('sai mật khẩu (401 LOGIN_FAILED) thì báo CHUNG CHUNG bằng tiếng Việt ngay trên form', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/auth/mode')) return json({ mode: 'LDAP' });
      if (url.startsWith('/api/me')) return json({ error: 'UNAUTHENTICATED', message: 'x' }, 401);
      if (url.startsWith('/auth/login')) {
        return json({ error: 'LOGIN_FAILED', message: 'Invalid credentials' }, 401);
      }
      throw new Error(`fetch bất ngờ: ${url}`);
    });
    renderGate();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Tên đăng nhập'), 'ai-do');
    await user.type(screen.getByLabelText('Mật khẩu'), 'sai-roi');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Sai tên đăng nhập hoặc mật khẩu.');
    // Vẫn đứng ở form để thử lại.
    expect(screen.queryByText('APP_OK')).toBeNull();
  });
});

describe('AuthGate — mode HEADER giữ nguyên hành vi cũ', () => {
  it('401 KHÔNG sinh form đăng nhập; app render bình thường', async () => {
    const calls = stubFetch((url) => {
      if (url.startsWith('/api/auth/mode')) return json({ mode: 'HEADER' });
      if (url.startsWith('/api/me')) return json({ error: 'UNAUTHENTICATED', message: 'x' }, 401);
      throw new Error(`fetch bất ngờ: ${url}`);
    });
    renderGate();

    expect(screen.getByText('APP_OK')).toBeTruthy();
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith('/api/auth/mode'))).toBe(true),
    );
    expect(screen.queryByLabelText('Tên đăng nhập')).toBeNull();
    expect(screen.getByText('APP_OK')).toBeTruthy();
  });
});

describe('loginErrorMessage', () => {
  const err = (status: number | null, code = 'X'): ApiError =>
    new ApiError({ code, message: 'server nói gì đó', status });

  it('dịch đúng ba mã lỗi của /auth/login', () => {
    expect(loginErrorMessage(err(401, 'LOGIN_FAILED'))).toBe('Sai tên đăng nhập hoặc mật khẩu.');
    expect(loginErrorMessage(err(429, 'TOO_MANY_ATTEMPTS'))).toBe(
      'Quá nhiều lần đăng nhập sai — thử lại sau ít phút.',
    );
    expect(loginErrorMessage(err(502, 'LDAP_UNREACHABLE'))).toBe(
      'Không kết nối được máy chủ LDAP — liên hệ quản trị viên.',
    );
  });

  it('lỗi lạ (mất mạng, 500…) rơi về câu chung', () => {
    expect(loginErrorMessage(err(null, 'NETWORK'))).toContain('Đăng nhập thất bại');
    expect(loginErrorMessage(err(500))).toContain('Đăng nhập thất bại');
    expect(loginErrorMessage(new Error('lạ'))).toContain('Đăng nhập thất bại');
  });
});
