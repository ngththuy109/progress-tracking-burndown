import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  logworkByPicResponseSchema,
  logworkResponseSchema,
  logworkSettingsResponseSchema,
  type LogworkByPicResponse,
  type LogworkResponse,
  type LogworkSettingsResponse,
} from '@app/shared';
import { apiClient, noContent, type ApiClient } from './client.js';

/**
 * Theo dõi việc log work của member — TOÀN ĐỘI.
 *
 * MỘT lần gọi cho cả kỳ; màn hình lọc member trong bộ nhớ. Đổi kỳ (from/to) là
 * đổi queryKey nên TanStack Query tự tải lại. `from/to` rỗng → server mặc định
 * về tuần chứa hôm nay.
 */
export const logworkKeys = {
  all: ['logwork'] as const,
  report: (from: string, to: string) => ['logwork', 'report', from, to] as const,
  byPic: (from: string, to: string) => ['logwork', 'by-pic', from, to] as const,
  settings: ['logwork', 'settings'] as const,
};

export function useLogwork(
  from: string | null,
  to: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<LogworkResponse, Error> {
  return useQuery({
    queryKey: logworkKeys.report(from ?? '', to ?? ''),
    queryFn: ({ signal }) =>
      client.get('/logwork', logworkResponseSchema, { query: { from, to }, signal }),
    // Đổi kỳ (from/to) là đổi queryKey. Không có placeholder thì query mới CHƯA có
    // cache → `isPending` = true → cả màn hình (kể cả bộ chọn kỳ) bị thay bằng
    // khung "đang tải", làm ô ngày Custom biến mất giữa lúc đang chọn. Giữ dữ liệu
    // kỳ trước trong lúc tải kỳ mới để bộ chọn ở nguyên chỗ; `isFetching` báo "đang
    // cập nhật".
    placeholderData: keepPreviousData,
  });
}

/**
 * Báo cáo LƯỚI: PIC × ngày. Cùng bộ chọn kỳ với `useLogwork` (một endpoint riêng
 * vì gom worklog theo NGÀY, khác cách gộp của báo cáo theo member). Giữ dữ liệu
 * kỳ trước trong lúc tải kỳ mới để bộ chọn kỳ không nhấp nháy — như `useLogwork`.
 */
export function useLogworkByPic(
  from: string | null,
  to: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<LogworkByPicResponse, Error> {
  return useQuery({
    queryKey: logworkKeys.byPic(from ?? '', to ?? ''),
    queryFn: ({ signal }) =>
      client.get('/logwork/by-pic', logworkByPicResponseSchema, { query: { from, to }, signal }),
    placeholderData: keepPreviousData,
  });
}

export function useLogworkSettings(
  client: ApiClient = apiClient,
): UseQueryResult<LogworkSettingsResponse, Error> {
  return useQuery({
    queryKey: logworkKeys.settings,
    queryFn: ({ signal }) => client.get('/logwork/settings', logworkSettingsResponseSchema, { signal }),
  });
}

export interface ExemptionInput {
  readonly accountId: string;
  readonly issueKey: string;
}

/** PM "verify — thôi theo dõi". Thành công thì tải lại báo cáo (cờ exempt đổi). */
export function useVerifyExemption(
  client: ApiClient = apiClient,
): UseMutationResult<null, Error, ExemptionInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ExemptionInput) =>
      client.post('/logwork/exemptions', { accountId: input.accountId, issueKey: input.issueKey }, noContent),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: logworkKeys.all }),
  });
}

/** Gỡ đánh dấu verify. */
export function useUnverifyExemption(
  client: ApiClient = apiClient,
): UseMutationResult<null, Error, ExemptionInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ExemptionInput) =>
      client.delete('/logwork/exemptions', noContent, {
        query: { accountId: input.accountId, issueKey: input.issueKey },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: logworkKeys.all }),
  });
}

export interface SetHoursInput {
  readonly projectKey: string;
  readonly expectedHoursPerDay: number | null;
}

/** Đổi giờ/ngày kỳ vọng của một project — tải lại cả settings lẫn báo cáo. */
export function useSetProjectHours(
  client: ApiClient = apiClient,
): UseMutationResult<null, Error, SetHoursInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetHoursInput) =>
      client.put(
        `/logwork/settings/${encodeURIComponent(input.projectKey)}`,
        { expectedHoursPerDay: input.expectedHoursPerDay },
        noContent,
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: logworkKeys.all }),
  });
}
