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
import { apiClient, noContent, type ApiClient } from './client.js';

/**
 * Bảy hook của màn hình danh sách Epic — API đã có đủ từ T-10.
 *
 * Mọi schema lấy từ `@app/shared`. Card này KHÔNG sửa API.
 */

export const epicKeys = {
  all: ['epics'] as const,
  list: () => ['epics', 'list'] as const,
  browse: (project: string) => ['epics', 'browse', project] as const,
  missingDates: (epicKey: string) => ['epics', 'missing-dates', epicKey] as const,
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
  return useQuery({
    queryKey: epicKeys.list(),
    queryFn: ({ signal }) => client.get('/epics', listEpicsResponseSchema, { signal }).then((r) => r.epics),
    refetchInterval: (query) => {
      const epics = query.state.data;
      if (epics === undefined) return false;
      return epics.some((e) => BUSY_STATUSES.has(e.status)) ? SYNCING_POLL_MS : false;
    },
  });
}

export function useValidateEpics(client: ApiClient = apiClient) {
  return useMutation({
    mutationFn: (keys: readonly string[]) =>
      client.post('/epics/validate', { keys }, validateEpicsResponseSchema),
  });
}

export function useAddEpics(client: ApiClient = apiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AddEpicsRequest) => client.post('/epics', body, addEpicsResponseSchema),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: epicKeys.all });
    },
  });
}

export interface PatchVars {
  readonly epicKey: string;
  readonly patch: PatchEpicRequest;
}

export function usePatchEpic(client: ApiClient = apiClient): UseMutationResult<null, Error, PatchVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: PatchVars) => client.patch(`/epics/${vars.epicKey}`, vars.patch, noContent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: epicKeys.all });
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: RemoveVars) =>
      client.request(`/epics/${vars.epicKey}`, {
        method: 'DELETE',
        body: { purge: vars.purge, confirmKey: vars.confirmKey },
        parser: noContent,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: epicKeys.all });
    },
  });
}

export function useMissingDates(epicKey: string | null, client: ApiClient = apiClient) {
  return useQuery({
    queryKey: epicKeys.missingDates(epicKey ?? ''),
    // Chỉ gọi khi PM thật sự mở khu đó — mỗi Epic là một truy vấn riêng.
    enabled: epicKey !== null,
    queryFn: ({ signal }) =>
      client.get(`/epics/${epicKey ?? ''}/missing-dates`, missingDatesResponseSchema, { signal }),
  });
}

export function useBrowseEpics(
  project: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<{ epics: readonly { key: string; displayName: string; alreadyTracked: boolean }[] }, Error> {
  return useQuery({
    queryKey: epicKeys.browse(project ?? ''),
    enabled: project !== null && project !== '',
    queryFn: ({ signal }) =>
      client.get('/epics/browse', browseEpicsResponseSchema, {
        signal,
        query: { project: project ?? '' },
      }),
  });
}
