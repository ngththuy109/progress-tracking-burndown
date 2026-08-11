import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  appUserSchema,
  listUsersResponseSchema,
  type AppUserView,
  type UpsertUserRequest,
} from '@app/shared';
import { apiClient, noContent, type ApiClient } from './client.js';
import { adminProjectKeys } from './use-projects.js';

/**
 * Hook cho màn hình quản lý người dùng — `/api/admin/users`, chỉ ADMIN.
 *
 * Mô hình mới: user chỉ còn role TOÀN CỤC (ADMIN/MEMBER) kèm `membershipCount`.
 * Gán user vào từng dự án (PM/VIEWER) nằm ở màn Projects — mục Thành viên,
 * KHÔNG còn ở đây.
 */
export const userKeys = { all: ['admin', 'users'] as const };

/** Xoá user cũng gỡ membership → `memberCount` của danh mục Project đổi theo. */
function invalidateUsersAndProjects(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: userKeys.all });
  void queryClient.invalidateQueries({ queryKey: adminProjectKeys.all });
}

export function useUsers(client: ApiClient = apiClient): UseQueryResult<readonly AppUserView[], Error> {
  return useQuery({
    queryKey: userKeys.all,
    queryFn: ({ signal }) =>
      client.get('/admin/users', listUsersResponseSchema, { signal }).then((r) => r.users),
  });
}

export function useUpsertUser(
  client: ApiClient = apiClient,
): UseMutationResult<AppUserView, Error, UpsertUserRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertUserRequest) => client.post('/admin/users', body, appUserSchema),
    onSuccess: () => invalidateUsersAndProjects(queryClient),
  });
}

export function useDeleteUser(
  client: ApiClient = apiClient,
): UseMutationResult<null, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      client.delete(`/admin/users/${encodeURIComponent(userId)}`, noContent),
    onSuccess: () => invalidateUsersAndProjects(queryClient),
  });
}
