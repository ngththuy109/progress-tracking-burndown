import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  listProjectsResponseSchema,
  projectSchema,
  type ProjectView,
  type UpsertProjectRequest,
} from '@app/shared';
import { apiClient, noContent, type ApiClient } from './client.js';

/**
 * Hook cho danh mục Project (màn hình quản trị, chỉ ADMIN).
 */
export const projectKeys = { all: ['projects'] as const };

export function useProjects(client: ApiClient = apiClient): UseQueryResult<readonly ProjectView[], Error> {
  return useQuery({
    queryKey: projectKeys.all,
    queryFn: ({ signal }) =>
      client.get('/projects', listProjectsResponseSchema, { signal }).then((r) => r.projects),
  });
}

export function useUpsertProject(
  client: ApiClient = apiClient,
): UseMutationResult<ProjectView, Error, UpsertProjectRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertProjectRequest) => client.post('/projects', body, projectSchema),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useDeleteProject(
  client: ApiClient = apiClient,
): UseMutationResult<null, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectKey: string) =>
      client.delete(`/projects/${encodeURIComponent(projectKey)}`, noContent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}
