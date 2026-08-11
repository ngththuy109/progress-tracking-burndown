import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  planConflictCountsResponseSchema,
  planConflictsResponseSchema,
  type PlanConflictCountsResponse,
  type PlanConflictsResponse,
} from '@app/shared';
import { apiClient, type ApiClient } from './client.js';

/**
 * Kiểm tra plan rơi vào ngày nghỉ — T-37.
 *
 * Chi tiết theo Epic cho màn Phase sub-tasks; bản tổng hợp (chỉ số đếm) cho màn
 * Epics — một lần gọi cho cả danh sách thay vì N lần.
 */

export const planConflictKeys = {
  epic: (epicKey: string) => ['plan-conflicts', epicKey] as const,
  summary: ['plan-conflicts', 'summary'] as const,
};

export function usePlanConflicts(
  epicKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<PlanConflictsResponse, Error> {
  return useQuery({
    queryKey: planConflictKeys.epic(epicKey ?? ''),
    enabled: epicKey !== null && epicKey !== '',
    queryFn: ({ signal }) =>
      client.get(`/epics/${epicKey ?? ''}/plan-conflicts`, planConflictsResponseSchema, { signal }),
  });
}

export function usePlanConflictSummary(
  client: ApiClient = apiClient,
): UseQueryResult<PlanConflictCountsResponse, Error> {
  return useQuery({
    queryKey: planConflictKeys.summary,
    queryFn: ({ signal }) =>
      client.get('/plan-conflicts/summary', planConflictCountsResponseSchema, { signal }),
  });
}
