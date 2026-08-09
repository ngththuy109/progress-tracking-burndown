import { ApiError } from './client.js';

/**
 * Khi API trả 401, đá người dùng qua trang đăng nhập của cổng SSO.
 *
 * Đường dẫn đăng nhập do cổng quyết định (oauth2-proxy dùng `/oauth2/sign_in`)
 * nên lấy từ biến môi trường Vite `VITE_SIGN_IN_PATH`.
 *
 * MẶC ĐỊNH RỖNG = TẮT: ở local dev/test không có cổng SSO, tự chuyển hướng sẽ
 * nhảy vào một URL không tồn tại. Khi deploy sau proxy thì đặt
 * `VITE_SIGN_IN_PATH=/oauth2/sign_in`.
 */
export function signInPath(): string {
  const env: unknown = import.meta.env;
  if (env === null || typeof env !== 'object') return '';
  const value = (env as Record<string, unknown>)['VITE_SIGN_IN_PATH'];
  return typeof value === 'string' ? value.trim() : '';
}

/** Chặn nhảy hai lần khi nhiều query cùng hỏng 401 một lúc. */
let redirecting = false;

/**
 * Chuyển hướng đăng nhập nếu lỗi là 401 VÀ có cấu hình đường dẫn.
 *
 * Mang theo `?rd=` để cổng đưa người dùng về đúng chỗ họ đang đứng sau khi
 * đăng nhập xong. Không phải 401, hoặc chưa cấu hình đường dẫn, thì không làm gì
 * — để `ErrorState` hiện lỗi như thường.
 */
export function maybeRedirectToSignIn(error: unknown): void {
  if (redirecting) return;
  if (!(error instanceof ApiError) || error.status !== 401) return;

  const path = signInPath();
  if (path === '') return;
  if (typeof window === 'undefined') return;

  redirecting = true;
  const here = window.location.pathname + window.location.search;
  window.location.assign(`${path}?rd=${encodeURIComponent(here)}`);
}
