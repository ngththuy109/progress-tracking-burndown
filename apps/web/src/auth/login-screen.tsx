import { useState, type FormEvent } from 'react';
import { ApiError, type ApiClient } from '../api/client.js';
import { useLogin } from '../api/use-auth-mode.js';

/**
 * Form đăng nhập LDAP — hiện khi mode = LDAP và `/api/me` trả 401.
 *
 * KHÔNG có chuyển hướng nào: `POST /auth/login` trả 204 + Set-Cookie, sau đó
 * `useLogin` invalidate toàn bộ cache query. `/api/me` được nạp lại, `AuthGate`
 * thấy đã đăng nhập và render app — người dùng vẫn đứng nguyên URL đang xem.
 */

/**
 * Dịch lỗi đăng nhập thành câu tiếng Việt hiện NGAY TRÊN FORM.
 *
 * 401 cố ý nói CHUNG CHUNG ("sai tên hoặc mật khẩu") — API không phân biệt
 * user-không-tồn-tại với sai-mật-khẩu để khỏi thành công cụ dò tài khoản, nên
 * UI cũng không được đoán thêm.
 */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Incorrect username or password.';
    if (error.status === 429) return 'Too many failed attempts — try again in a few minutes.';
    if (error.status === 502) {
      return 'Could not reach the LDAP server — contact your administrator.';
    }
  }
  return 'Sign-in failed. Try again; if it keeps failing, contact your administrator.';
}

export interface LoginScreenProps {
  /** Test truyền client giả; mặc định dùng client gốc trang của `useLogin`. */
  readonly client?: ApiClient | undefined;
}

export function LoginScreen({ client }: LoginScreenProps = {}) {
  const login = useLogin(client);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const canSubmit = username.trim() !== '' && password !== '' && !login.isPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    login.mutate({ username: username.trim(), password });
  };

  return (
    <main className="login">
      <form className="login__card panel" onSubmit={submit}>
        <div className="login__brand">
          <span className="login__brand-mark" aria-hidden="true">
            📊
          </span>
          <span>Burndown Engine</span>
        </div>

        <p className="muted">Sign in with your company account (LDAP) to continue.</p>

        <label className="field">
          <span>Username</span>
          <input
            className="input input--wide"
            value={username}
            autoComplete="username"
            // Cả trang chỉ có mỗi form này — focus sẵn để gõ được ngay.
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            className="input input--wide"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {login.isError && (
          <p className="notice notice--error" role="alert">
            {loginErrorMessage(login.error)}
          </p>
        )}

        <div className="actions">
          <button type="submit" className="button button--primary" disabled={!canSubmit}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </main>
  );
}
