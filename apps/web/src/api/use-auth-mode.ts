import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { authModeResponseSchema, type AuthModeResponse, type LoginRequest } from '@app/shared';
import { apiClient, createApiClient, noContent, type ApiClient } from './client.js';

/**
 * Chế độ xác thực đang hiệu lực — `GET /api/auth/mode` (CÔNG KHAI, gọi được
 * trước khi đăng nhập).
 *
 *   HEADER — mô hình cổng/proxy cũ: web giữ nguyên hành vi hiện tại.
 *   LDAP   — app tự đăng nhập: 401 sẽ dẫn tới form "Tên đăng nhập / Mật khẩu"
 *            (`auth/auth-gate.tsx`) thay vì trông chờ cổng bên ngoài.
 */
export const authModeKey = ['auth', 'mode'] as const;

export function useAuthMode(
  client: ApiClient = apiClient,
): UseQueryResult<AuthModeResponse, Error> {
  return useQuery({
    queryKey: authModeKey,
    queryFn: ({ signal }) => client.get('/auth/mode', authModeResponseSchema, { signal }),
    // Chế độ xác thực gần như không đổi trong một phiên; hỏi lại liên tục là phí.
    staleTime: 5 * 60_000,
  });
}

/**
 * `/auth/login` và `/auth/logout` nằm NGOÀI tiền tố `/api` (chúng là điểm vào
 * của trình duyệt, không phải endpoint dữ liệu). Client riêng cùng gốc trang —
 * mọi `fetch` vẫn đi qua `api/client.ts` đúng quy ước.
 */
const authRootClient = createApiClient({ baseUrl: '' });

/**
 * Đăng nhập LDAP: `POST /auth/login` với `{username, password}`.
 *
 * Thành công là 204 + Set-Cookie — KHÔNG có chuyển hướng nào cả. Việc còn lại
 * chỉ là làm mới toàn bộ cache query: `/api/me` được nạp lại, `AuthGate` thấy
 * đã đăng nhập và tự thay màn hình đăng nhập bằng app — người dùng vẫn đứng
 * nguyên ở URL đang xem (quan trọng cho ca hết hạn giữa phiên).
 *
 * Lỗi giữ NGUYÊN `ApiError` (401 LOGIN_FAILED / 429 / 502...) cho màn hình
 * đăng nhập tự dịch thành câu tiếng Việt — xem `loginErrorMessage`.
 */
export function useLogin(
  client: ApiClient = authRootClient,
): UseMutationResult<null, Error, LoginRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => client.post('/auth/login', body, noContent),
    // Làm mới TẤT CẢ: mọi dữ liệu trong cache đều được tải dưới danh nghĩa
    // "chưa đăng nhập" hoặc của phiên cũ — không cái nào đáng tin nữa.
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

/**
 * Đăng xuất phiên LDAP: `POST /auth/logout` (204, xoá cookie phiên) rồi nạp
 * lại trang từ `/` — mọi state trong bộ nhớ (cache query, form dở) thuộc về
 * người vừa đăng xuất nên phải bỏ hết, không được giữ lại cho người kế tiếp.
 */
export function useLogout(
  client: ApiClient = authRootClient,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): UseMutationResult<null, Error, void> {
  return useMutation({
    mutationFn: () => client.post('/auth/logout', undefined, noContent),
    onSuccess: () => navigate('/'),
  });
}
