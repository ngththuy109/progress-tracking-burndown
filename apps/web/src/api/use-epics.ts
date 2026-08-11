import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  addEpicsResponseSchema,
  browseEpicsResponseSchema,
  listEpicsResponseSchema,
  missingDatesResponseSchema,
  validateEpicsResponseSchema,
  type AddEpicsRequest,
  type PatchEpicRequest,
} from '@app/shared';
import { useProjectKey } from '../project/project-context.js';
import { apiClient, noContent, projectApiPath, type ApiClient } from './client.js';

/**
 * Hook của màn hình danh sách Epic — nay THEO PHẠM VI DỰ ÁN.
 *
 * `projectKey` lấy từ `ProjectProvider` (URL `/p/:projectKey/...`), KHÔNG truyền
 * tay từng nơi — truyền tay là sẽ có chỗ quên và gọi nhầm dự án khác. Mọi query
 * key có tiền tố `[projectKey, ...]` để đổi dự án không dính cache của nhau.
 */

export const epicKeys = {
  all: (projectKey: string) => [projectKey, 'epics'] as const,
  list: (projectKey: string) => [projectKey, 'epics', 'list'] as const,
  browse: (projectKey: string) => [projectKey, 'epics', 'browse'] as const,
  missingDates: (projectKey: string, epicKey: string) =>
    [projectKey, 'epics', 'missing-dates', epicKey] as const,
};

/**
 * Có Epic nào đang dựng lịch sử thì hỏi lại mỗi 5 giây, không thì thôi hẳn.
 *
 * Hỏi lại liên tục kể cả khi mọi Epic đã xong là tự tạo tải cho chính mình;
 * không hỏi lại lần nào thì PM phải tự bấm F5 để biết đã xong chưa.
 */
export const SYNCING_POLL_MS = 5000;
const BUSY_STATUSES = new Set(['PENDING', 'BACKFILLING']);

export function useEpicList(client: ApiClient = apiClient) {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: epicKeys.list(projectKey),
    queryFn: ({ signal }) =>
      client
        .get(projectApiPath(projectKey, '/epics'), listEpicsResponseSchema, { signal })
        .then((r) => r.epics),
    refetchInterval: (query) => {
      const epics = query.state.data;
      if (epics === undefined) return false;
      return epics.some((e) => BUSY_STATUSES.has(e.status)) ? SYNCING_POLL_MS : false;
    },
  });
}

export function useValidateEpics(client: ApiClient = apiClient) {
  const projectKey = useProjectKey();
  return useMutation({
    mutationFn: (keys: readonly string[]) =>
      client.post(projectApiPath(projectKey, '/epics/validate'), { keys }, validateEpicsResponseSchema),
  });
}

export function useAddEpics(client: ApiClient = apiClient) {
  const projectKey = useProjectKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AddEpicsRequest) =>
      client.post(projectApiPath(projectKey, '/epics'), body, addEpicsResponseSchema),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: epicKeys.all(projectKey) });
    },
  });
}

export interface PatchVars {
  readonly epicKey: string;
  readonly patch: PatchEpicRequest;
}

export function usePatchEpic(client: ApiClient = apiClient): UseMutationResult<null, Error, PatchVars> {
  const projectKey = useProjectKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: PatchVars) =>
      client.patch(projectApiPath(projectKey, `/epics/${vars.epicKey}`), vars.patch, noContent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: epicKeys.all(projectKey) });
    },
  });
}

export interface RemoveVars {
  readonly epicKey: string;
  /** `true` = xoá sạch dữ liệu lịch sử, không hoàn tác được. */
  readonly purge: boolean;
  /** Người dùng phải GÕ LẠI mã Epic khi `purge = true` (PRD §2.6.4). */
  readonly confirmKey: string | null;
}

export function useRemoveEpic(client: ApiClient = apiClient): UseMutationResult<null, Error, RemoveVars> {
  const projectKey = useProjectKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: RemoveVars) =>
      client.request(projectApiPath(projectKey, `/epics/${vars.epicKey}`), {
        method: 'DELETE',
        body: { purge: vars.purge, confirmKey: vars.confirmKey },
        parser: noContent,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: epicKeys.all(projectKey) });
    },
  });
}

export function useMissingDates(epicKey: string | null, client: ApiClient = apiClient) {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: epicKeys.missingDates(projectKey, epicKey ?? ''),
    // Chỉ gọi khi PM thật sự mở khu đó — mỗi Epic là một truy vấn riêng.
    enabled: epicKey !== null,
    queryFn: ({ signal }) =>
      client.get(
        projectApiPath(projectKey, `/epics/${epicKey ?? ''}/missing-dates`),
        missingDatesResponseSchema,
        { signal },
      ),
  });
}

/**
 * Duyệt các Epic của dự án trên Jira. Phạm vi Jira project đi theo tenant
 * (`/p/:projectKey`) nên KHÔNG còn tham số `?project=` như bản đơn-tenant.
 */
export function useBrowseEpics(
  enabled: boolean,
  client: ApiClient = apiClient,
): UseQueryResult<{ epics: readonly { key: string; displayName: string; alreadyTracked: boolean }[] }, Error> {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: epicKeys.browse(projectKey),
    enabled,
    queryFn: ({ signal }) =>
      client.get(projectApiPath(projectKey, '/epics/browse'), browseEpicsResponseSchema, { signal }),
  });
}
