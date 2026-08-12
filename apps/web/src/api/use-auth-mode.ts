import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { authModeResponseSchema, type AuthModeResponse } from '@app/shared';
import { apiClient, createApiClient, noContent, type ApiClient } from './client.js';

/**
 * Chế độ xác thực đang hiệu lực — `GET /api/auth/mode` (CÔNG KHAI, gọi được
 * trước khi đăng nhập).
 *
 *   HEADER — mô hình cổng/proxy cũ: web giữ nguyên hành vi hiện tại.
 *   OIDC   — app tự đăng nhập: 401 sẽ dẫn tới màn hình "Đăng nhập bằng SSO"
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
 * Đăng xuất phiên OIDC: `POST /auth/logout` (204, xoá cookie `ptb_sess`) rồi
 * nạp lại trang từ `/` — mọi state trong bộ nhớ (cache query, form dở) thuộc về
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
