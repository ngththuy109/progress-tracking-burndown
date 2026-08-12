import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import type { AuthModeResponse } from '@app/shared';
import { ApiError } from './client.js';
import { maybeRedirectToSignIn } from './auth-redirect.js';
import { authModeKey } from './use-auth-mode.js';
import { meKey } from './use-me.js';

/**
 * Cấu hình TanStack Query dùng chung.
 *
 * Ba lựa chọn ở đây đều xuất phát từ đặc điểm dữ liệu của hệ thống này: số liệu
 * Burndown được CHỐT THEO NGÀY, không phải dòng dữ liệu chảy liên tục.
 */

/**
 * Trong 30 giây thì dữ liệu vẫn coi là mới.
 *
 * Ngắn hơn thì mỗi lần đổi qua đổi lại giữa hai màn hình là một loạt request;
 * dài hơn thì người dùng vừa lưu cấu hình xong vẫn thấy số cũ.
 */
export const STALE_TIME_MS = 30_000;

/** Giữ trong bộ nhớ 5 phút sau khi màn hình đóng, để quay lại là có ngay. */
export const GC_TIME_MS = 5 * 60_000;

/**
 * Có nên thử lại không.
 *
 * Thử lại một lỗi 400/403/404 là phí thời gian của cả máy chủ lẫn người dùng —
 * gửi y hệt lần nữa thì câu trả lời cũng y hệt. Chỉ thử lại những lỗi CÓ THỂ tự
 * hết: mất mạng, máy chủ đang bận (429), máy chủ lỗi tạm (5xx).
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (!(error instanceof ApiError)) return true;
  if (error.status === null) return true; // chưa tới được máy chủ
  if (error.status === 429) return true;
  if (error.status >= 500) return true;
  return false;
}

/**
 * Phiên LDAP hết hạn GIỮA CHỪNG: một query/mutation bất kỳ trả 401.
 *
 * Cách đưa người dùng về màn hình đăng nhập: đặt cache của `/api/me` về `null`
 * — đúng giá trị `useMe` trả khi chưa đăng nhập — và `AuthGate` (đang render
 * theo cache đó) tự thay cả app bằng form đăng nhập. KHÔNG chuyển hướng cứng
 * ở đây: URL hiện tại được giữ nguyên nên đăng nhập lại xong người dùng vẫn
 * đứng đúng trang đang xem (form chỉ invalidate cache, không reload).
 *
 * Chỉ làm vậy khi mode = LDAP (đọc từ cache của `/api/auth/mode`): ở mode
 * HEADER, 401 vẫn theo đường cũ — `maybeRedirectToSignIn` + `ErrorState`.
 */
export function funnelExpiredLdapSession(client: QueryClient, error: unknown): void {
  if (!(error instanceof ApiError) || error.status !== 401) return;
  const mode = client.getQueryData<AuthModeResponse>(authModeKey);
  if (mode?.mode !== 'LDAP') return;
  client.setQueryData(meKey, null);
}

export function createQueryClient(): QueryClient {
  // Một chỗ DUY NHẤT bắt lỗi 401 cho mọi query lẫn mutation. Hai nhánh theo
  // chế độ xác thực: HEADER → đá qua cổng SSO ngoài (nếu có VITE_SIGN_IN_PATH);
  // LDAP → đổ về form đăng nhập trong app (xem `funnelExpiredLdapSession`).
  const onError = (error: unknown): void => {
    maybeRedirectToSignIn(error);
    funnelExpiredLdapSession(client, error);
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        gcTime: GC_TIME_MS,
        retry: shouldRetry,

        // CẠM BẪY: mặc định của TanStack Query là BẬT. Người dùng chuyển sang
        // tab khác rồi quay lại là gọi lại toàn bộ API — trong khi số liệu chốt
        // theo ngày, chuyển tab xong nó vẫn y nguyên.
        refetchOnWindowFocus: false,
      },
      mutations: {
        // KHÔNG bao giờ tự gửi lại một thao tác ghi. Một `PUT` có thể đã thành
        // công rồi mới đứt mạng ở đường về; gửi lại là ghi đè lần thứ hai.
        // Thà hiện lỗi để người dùng tự quyết định.
        retry: false,
      },
    },
  });
  return client;
}
