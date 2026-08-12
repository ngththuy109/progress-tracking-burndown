import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  jiraTestResponseSchema,
  listMembersResponseSchema,
  listProjectsResponseSchema,
  projectSchema,
  type JiraTestResponse,
  type ProjectMemberView,
  type ProjectView,
  type UpdateProjectJiraRequest,
  type UpsertMemberRequest,
  type UpsertProjectRequest,
} from '@app/shared';
import { meKey } from './use-me.js';
import { apiClient, noContent, type ApiClient } from './client.js';

/**
 * Hook cho danh mục Project (tenant) — `/api/admin/projects`, chỉ ADMIN.
 *
 * Gồm ba nhóm: thông tin chung, kết nối Jira (token write-only) và thành viên.
 * Đổi tên/status/thành viên đều ảnh hưởng dữ liệu `/api/me` (project switcher)
 * nên các mutation ở đây làm mới cả `meKey`.
 */
export const adminProjectKeys = {
  all: ['admin', 'projects'] as const,
  members: (projectKey: string) => ['admin', 'projects', projectKey, 'members'] as const,
};

export function useProjects(client: ApiClient = apiClient): UseQueryResult<readonly ProjectView[], Error> {
  return useQuery({
    queryKey: adminProjectKeys.all,
    queryFn: ({ signal }) =>
      client.get('/admin/projects', listProjectsResponseSchema, { signal }).then((r) => r.projects),
  });
}

export function useUpsertProject(
  client: ApiClient = apiClient,
): UseMutationResult<ProjectView, Error, UpsertProjectRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertProjectRequest) => client.post('/admin/projects', body, projectSchema),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminProjectKeys.all });
      void queryClient.invalidateQueries({ queryKey: meKey });
    },
  });
}

// ---------------------------------------------------------------------------
// Kết nối Jira của tenant — PUT /api/admin/projects/:key/jira (+ /jira/test)
// ---------------------------------------------------------------------------

export interface UpdateProjectJiraVars {
  readonly projectKey: string;
  readonly body: UpdateProjectJiraRequest;
}

export function useUpdateProjectJira(
  client: ApiClient = apiClient,
): UseMutationResult<null, Error, UpdateProjectJiraVars> {
  const queryClient = useQueryClient();
  return useMutation({
    // Phản hồi (nếu có) không cần đọc — danh sách project được tải lại ngay
    // sau đó nên `hasJiraToken`/URL mới đến từ nguồn chuẩn.
    mutationFn: (vars: UpdateProjectJiraVars) =>
      client.put(`/admin/projects/${encodeURIComponent(vars.projectKey)}/jira`, vars.body, noContent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminProjectKeys.all });
    },
  });
}

/** "Test connection" — chạy AUTH → FIELDS → PROJECT_ACCESS, trả kết quả từng bước. */
export function useTestProjectJira(
  client: ApiClient = apiClient,
): UseMutationResult<JiraTestResponse, Error, string> {
  return useMutation({
    mutationFn: (projectKey: string) =>
      client.post(
        `/admin/projects/${encodeURIComponent(projectKey)}/jira/test`,
        undefined,
        jiraTestResponseSchema,
      ),
  });
}

// ---------------------------------------------------------------------------
// Thành viên dự án — /api/admin/projects/:key/members
// ---------------------------------------------------------------------------

export function useProjectMembers(
  projectKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<readonly ProjectMemberView[], Error> {
  return useQuery({
    queryKey: adminProjectKeys.members(projectKey ?? ''),
    enabled: projectKey !== null && projectKey !== '',
    queryFn: ({ signal }) =>
      client
        .get(`/admin/projects/${encodeURIComponent(projectKey ?? '')}/members`, listMembersResponseSchema, {
          signal,
        })
        .then((r) => r.members),
  });
}

/** Đổi thành viên làm lệch `memberCount`, `membershipCount` và cả `/api/me`. */
function invalidateMembership(
  queryClient: ReturnType<typeof useQueryClient>,
  projectKey: string,
): void {
  void queryClient.invalidateQueries({ queryKey: adminProjectKeys.members(projectKey) });
  void queryClient.invalidateQueries({ queryKey: adminProjectKeys.all });
  void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  void queryClient.invalidateQueries({ queryKey: meKey });
}

export interface UpsertMemberVars {
  readonly projectKey: string;
  readonly body: UpsertMemberRequest;
}

export function useUpsertMember(
  client: ApiClient = apiClient,
): UseMutationResult<null, Error, UpsertMemberVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: UpsertMemberVars) =>
      client.put(`/admin/projects/${encodeURIComponent(vars.projectKey)}/members`, vars.body, noContent),
    onSuccess: (_data, vars) => invalidateMembership(queryClient, vars.projectKey),
  });
}

export interface RemoveMemberVars {
  readonly projectKey: string;
  readonly userId: string;
}

export function useRemoveMember(
  client: ApiClient = apiClient,
): UseMutationResult<null, Error, RemoveMemberVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: RemoveMemberVars) =>
      client.delete(
        `/admin/projects/${encodeURIComponent(vars.projectKey)}/members/${encodeURIComponent(vars.userId)}`,
        noContent,
      ),
    onSuccess: (_data, vars) => invalidateMembership(queryClient, vars.projectKey),
  });
}
