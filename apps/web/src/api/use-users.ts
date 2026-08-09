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
import { projectKeys } from './use-projects.js';

/**
 * Hook cho màn hình quản lý người dùng (chỉ ADMIN dùng tới).
 *
 * Mọi schema lấy từ `@app/shared`; kiểm dữ liệu ngay tại biên như mọi hook khác.
 */
export const userKeys = { all: ['users'] as const };

/** Đổi PM/gán project cũng làm `pmCount` của danh mục Project đổi theo. */
function invalidateUsersAndProjects(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: userKeys.all });
  void queryClient.invalidateQueries({ queryKey: projectKeys.all });
}

export function useUsers(client: ApiClient = apiClient): UseQueryResult<readonly AppUserView[], Error> {
  return useQuery({
    queryKey: userKeys.all,
    queryFn: ({ signal }) =>
      client.get('/users', listUsersResponseSchema, { signal }).then((r) => r.users),
  });
}

export function useUpsertUser(
  client: ApiClient = apiClient,
): UseMutationResult<AppUserView, Error, UpsertUserRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertUserRequest) => client.post('/users', body, appUserSchema),
    onSuccess: () => invalidateUsersAndProjects(queryClient),
  });
}

export function useDeleteUser(
  client: ApiClient = apiClient,
): UseMutationResult<null, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      client.delete(`/users/${encodeURIComponent(userId)}`, noContent),
    onSuccess: () => invalidateUsersAndProjects(queryClient),
  });
}
