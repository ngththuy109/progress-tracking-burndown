import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { phaseSubtaskResponseSchema, type PhaseSubtaskResponse } from '@app/shared';
import { apiClient, type ApiClient } from './client.js';

/**
 * Danh sách Sub-task nhóm theo Phase, cho một Epic.
 *
 * MỘT lần gọi cho cả Epic; màn hình tự nhóm và lọc trong bộ nhớ. Không cache
 * riêng ở server nên `staleTime` mặc định của TanStack Query là đủ — sau khi
 * resync, quay lại màn hình là thấy dữ liệu mới.
 */

export const phaseSubtaskKeys = {
  epic: (epicKey: string) => ['phase-subtasks', epicKey] as const,
};

export function usePhaseSubtasks(
  epicKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<PhaseSubtaskResponse, Error> {
  return useQuery({
    queryKey: phaseSubtaskKeys.epic(epicKey ?? ''),
    enabled: epicKey !== null && epicKey !== '',
    queryFn: ({ signal }) =>
      client.get(`/epic/${epicKey ?? ''}/phase-subtasks`, phaseSubtaskResponseSchema, { signal }),
  });
}
