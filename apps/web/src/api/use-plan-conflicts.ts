import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  planConflictCountsResponseSchema,
  planConflictsResponseSchema,
  type PlanConflictCountsResponse,
  type PlanConflictsResponse,
} from '@app/shared';
import { useProjectKey } from '../project/project-context.js';
import { apiClient, projectApiPath, type ApiClient } from './client.js';

/**
 * Kiểm tra plan rơi vào ngày nghỉ — T-37, theo phạm vi dự án.
 *
 * Chi tiết theo Epic cho màn Phase sub-tasks; bản tổng hợp (chỉ số đếm) cho màn
 * Epics — một lần gọi cho cả danh sách thay vì N lần.
 */

export const planConflictKeys = {
  epic: (projectKey: string, epicKey: string) => [projectKey, 'plan-conflicts', epicKey] as const,
  summary: (projectKey: string) => [projectKey, 'plan-conflicts', 'summary'] as const,
};

export function usePlanConflicts(
  epicKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<PlanConflictsResponse, Error> {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: planConflictKeys.epic(projectKey, epicKey ?? ''),
    enabled: epicKey !== null && epicKey !== '',
    queryFn: ({ signal }) =>
      client.get(
        projectApiPath(projectKey, `/epics/${epicKey ?? ''}/plan-conflicts`),
        planConflictsResponseSchema,
        { signal },
      ),
  });
}

export function usePlanConflictSummary(
  client: ApiClient = apiClient,
): UseQueryResult<PlanConflictCountsResponse, Error> {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: planConflictKeys.summary(projectKey),
    queryFn: ({ signal }) =>
      client.get(
        projectApiPath(projectKey, '/plan-conflicts/summary'),
        planConflictCountsResponseSchema,
        { signal },
      ),
  });
}
