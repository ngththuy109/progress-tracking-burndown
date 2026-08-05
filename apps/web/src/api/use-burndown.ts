import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { burndownResponseSchema, explainResponseSchema, type BurndownResponse, type ExplainResponse } from '@app/shared';
import { apiClient, type ApiClient } from './client.js';

/**
 * Dữ liệu biểu đồ Burndown.
 *
 * MỘT lần gọi cho cả Epic; ba chế độ xem dùng chung tập số đó. T-17 đã tính sẵn
 * đường Kế hoạch của từng Phase vào `per_phase` chính vì lý do này — đổi Phase
 * KHÔNG được tải lại dữ liệu.
 */

export const burndownKeys = {
  epic: (epicKey: string) => ['burndown', epicKey] as const,
  explain: (epicKey: string, date: string) => ['burndown', epicKey, 'explain', date] as const,
};

export function useBurndown(
  epicKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<BurndownResponse, Error> {
  return useQuery({
    queryKey: burndownKeys.epic(epicKey ?? ''),
    enabled: epicKey !== null && epicKey !== '',
    queryFn: ({ signal }) =>
      client.get(`/burndown/epic/${epicKey ?? ''}`, burndownResponseSchema, { signal }),
  });
}

/**
 * Giải thích một điểm dữ liệu — chỉ gọi KHI người dùng bấm vào điểm đó.
 *
 * Nạp sẵn cho mọi ngày là gọi thừa hàng chục request cho một thứ hiếm khi mở.
 */
export function useExplainDay(
  epicKey: string | null,
  date: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<ExplainResponse, Error> {
  return useQuery({
    queryKey: burndownKeys.explain(epicKey ?? '', date ?? ''),
    enabled: epicKey !== null && date !== null,
    queryFn: ({ signal }) =>
      client.get(`/burndown/epic/${epicKey ?? ''}/day/${date ?? ''}/explain`, explainResponseSchema, {
        signal,
      }),
  });
}
