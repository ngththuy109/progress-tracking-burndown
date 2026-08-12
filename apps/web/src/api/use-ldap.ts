import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  ldapConfigSchema,
  ldapTestResponseSchema,
  type LdapConfigView,
  type LdapTestResponse,
  type UpdateLdapConfigRequest,
} from '@app/shared';
import { apiClient, noContent, type ApiClient } from './client.js';
import { authModeKey } from './use-auth-mode.js';

/**
 * Hook cho cấu hình LDAP — `/api/admin/auth/ldap`, chỉ ADMIN.
 *
 * Bind password là WRITE-ONLY (cùng quy ước với token Jira của tenant): API chỉ
 * trả `hasBindPassword`, còn request cập nhật phân ba trạng thái —
 * không gửi trường = GIỮ mật khẩu cũ; `null` = XÓA; chuỗi = thay mới.
 */
export const ldapConfigKey = ['admin', 'auth', 'ldap'] as const;

export function useLdapConfig(
  client: ApiClient = apiClient,
): UseQueryResult<LdapConfigView, Error> {
  return useQuery({
    queryKey: ldapConfigKey,
    queryFn: ({ signal }) => client.get('/admin/auth/ldap', ldapConfigSchema, { signal }),
  });
}

export function useUpdateLdapConfig(
  client: ApiClient = apiClient,
): UseMutationResult<null, Error, UpdateLdapConfigRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateLdapConfigRequest) => client.put('/admin/auth/ldap', body, noContent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ldapConfigKey });
      // Bật/tắt LDAP đổi luôn kết quả /api/auth/mode — làm mới để nút "Đăng
      // xuất" và màn hình đăng nhập phản ánh đúng chế độ mới.
      void queryClient.invalidateQueries({ queryKey: authModeKey });
    },
  });
}

/**
 * "Test LDAP" — chạy CONNECT → BIND → SEARCH với GIÁ TRỊ ĐANG GÕ TRÊN FORM
 * (không phải bản đã lưu), trả kết quả từng bước để Admin sửa trước khi lưu.
 */
export function useTestLdap(
  client: ApiClient = apiClient,
): UseMutationResult<LdapTestResponse, Error, UpdateLdapConfigRequest> {
  return useMutation({
    mutationFn: (body: UpdateLdapConfigRequest) =>
      client.post('/admin/auth/ldap/test', body, ldapTestResponseSchema),
  });
}
