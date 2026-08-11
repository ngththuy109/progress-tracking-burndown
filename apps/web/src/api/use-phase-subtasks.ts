import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { phaseSubtaskResponseSchema, type PhaseSubtaskResponse } from '@app/shared';
import { useProjectKey } from '../project/project-context.js';
import { apiClient, projectApiPath, type ApiClient } from './client.js';

/**
 * Danh sách Sub-task nhóm theo Phase, cho một Epic — theo phạm vi dự án.
 *
 * MỘT lần gọi cho cả Epic; màn hình tự nhóm và lọc trong bộ nhớ. Không cache
 * riêng ở server nên `staleTime` mặc định của TanStack Query là đủ — sau khi
 * resync, quay lại màn hình là thấy dữ liệu mới.
 */

export const phaseSubtaskKeys = {
  epic: (projectKey: string, epicKey: string) => [projectKey, 'phase-subtasks', epicKey] as const,
};

export function usePhaseSubtasks(
  epicKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<PhaseSubtaskResponse, Error> {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: phaseSubtaskKeys.epic(projectKey, epicKey ?? ''),
    enabled: epicKey !== null && epicKey !== '',
    queryFn: ({ signal }) =>
      client.get(
        projectApiPath(projectKey, `/epics/${epicKey ?? ''}/phase-subtasks`),
        phaseSubtaskResponseSchema,
        { signal },
      ),
  });
}
