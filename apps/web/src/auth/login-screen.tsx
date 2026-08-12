/**
 * Màn hình đăng nhập tối giản cho chế độ OIDC.
 *
 * KHÔNG có form tên/mật khẩu: đăng nhập là MỘT CÚ ĐIỀU HƯỚNG NGUYÊN TRANG tới
 * `/auth/login` (endpoint này trả 302 sang IdP nên gọi bằng `fetch` là hỏng —
 * trình duyệt phải tự đi theo redirect). Sau vòng IdP, người dùng quay về đúng
 * chỗ đang đứng nhờ `?redirectTo=`.
 */

/** Phần `window.location` mà màn hình cần — tách interface để test không phải giả cả window. */
export interface LocationLike {
  readonly pathname: string;
  readonly search: string;
  assign(url: string): void;
}

/** Query param mà API gắn vào `/` khi vòng đăng nhập thất bại. */
export const AUTH_ERROR_PARAM = 'authError';

/**
 * Ghép URL đăng nhập kèm `redirectTo` = chỗ đang đứng.
 *
 * `authError` bị LỌC KHỎI redirectTo: giữ nó thì đăng nhập lại THÀNH CÔNG xong
 * vẫn đáp xuống `/?authError=...` và màn hình chào người dùng bằng lỗi cũ.
 */
export function loginHref(
  loginUrl: string,
  location: Pick<LocationLike, 'pathname' | 'search'>,
): string {
  const params = new URLSearchParams(location.search);
  params.delete(AUTH_ERROR_PARAM);
  const qs = params.toString();
  const redirectTo = location.pathname + (qs === '' ? '' : `?${qs}`);
  return `${loginUrl}?redirectTo=${encodeURIComponent(redirectTo)}`;
}

/**
 * Câu lỗi thân thiện, GỘP CHUNG mọi mã: mã lỗi (`state_mismatch`,
 * `token_exchange_failed`…) chỉ có ích cho quản trị viên nên hiện nguyên văn
 * trong ngoặc, còn người dùng thường chỉ cần biết "thử lại hoặc gọi ai".
 */
export function authErrorMessage(code: string): string {
  return `Đăng nhập thất bại (${code}). Thử lại hoặc liên hệ quản trị viên.`;
}

export interface LoginScreenProps {
  /** `loginUrl` từ `GET /api/auth/mode` — thường là `/auth/login`. */
  readonly loginUrl: string;
  /** Mặc định là `window.location`; test truyền bản giả. */
  readonly currentLocation?: LocationLike;
}

export function LoginScreen({ loginUrl, currentLocation = window.location }: LoginScreenProps) {
  const errorCode = new URLSearchParams(currentLocation.search).get(AUTH_ERROR_PARAM);

  return (
    <main className="login">
      <div className="login__card panel">
        <div className="login__brand">
          <span className="login__brand-mark" aria-hidden="true">
            📊
          </span>
          <span>Burndown Engine</span>
        </div>

        <p className="muted">Đăng nhập bằng tài khoản công ty để tiếp tục.</p>

        {errorCode !== null && (
          <p className="notice notice--error" role="alert">
            {authErrorMessage(errorCode)}
          </p>
        )}

        <button
          type="button"
          className="button button--primary"
          onClick={() => currentLocation.assign(loginHref(loginUrl, currentLocation))}
        >
          Đăng nhập bằng SSO
        </button>
      </div>
    </main>
  );
}
