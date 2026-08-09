import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { meResponseSchema, type MeResponse } from '@app/shared';
import { apiClient, ApiError, type ApiClient } from './client.js';

/**
 * Ai đang đăng nhập — để hiện tên và ẩn/hiện nút theo vai trò.
 *
 * 401 (chưa đăng nhập) KHÔNG coi là lỗi: trả `null` thay vì ném, để khung layout
 * hiện trạng thái "chưa đăng nhập" gọn gàng thay vì một dải đỏ. Việc đá qua trang
 * đăng nhập là của cổng SSO (và `maybeRedirectToSignIn`), không phải hook này.
 */
export const meKey = ['me'] as const;

export function useMe(client: ApiClient = apiClient): UseQueryResult<MeResponse | null, Error> {
  return useQuery<MeResponse | null>({
    queryKey: meKey,
    queryFn: async ({ signal }) => {
      try {
        return await client.get('/me', meResponseSchema, { signal });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    // Vai trò gần như không đổi trong một phiên; hỏi lại mỗi request là phí.
    staleTime: 5 * 60_000,
    retry: false,
  });
}
