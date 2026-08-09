import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './client.js';
import { maybeRedirectToSignIn } from './auth-redirect.js';

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

export function createQueryClient(): QueryClient {
  return new QueryClient({
    // Một chỗ DUY NHẤT bắt lỗi 401 cho mọi query lẫn mutation: chưa đăng nhập
    // thì đá qua trang đăng nhập của cổng SSO (nếu đã cấu hình VITE_SIGN_IN_PATH).
    queryCache: new QueryCache({ onError: maybeRedirectToSignIn }),
    mutationCache: new MutationCache({ onError: maybeRedirectToSignIn }),
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
}
