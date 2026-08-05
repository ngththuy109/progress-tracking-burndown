import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  opsHealthResponseSchema,
  OPS_REFRESH_MS,
  resyncResponseSchema,
  type OpsHealthResponse,
  type ResyncRequest,
} from '@app/shared';
import { apiClient, type ApiClient } from './client.js';

/**
 * Số liệu vận hành.
 *
 * MỘT lần gọi cho cả bốn nhóm. Gọi sáu endpoint sẽ làm dashboard tự góp phần
 * vào tải của hệ thống đang tải nặng — đúng lúc không nên.
 */

export const opsKeys = { health: ['ops', 'health'] as const };

export function useOpsHealth(
  autoRefresh: boolean,
  client: ApiClient = apiClient,
): UseQueryResult<OpsHealthResponse, Error> {
  return useQuery({
    queryKey: opsKeys.health,
    // Số liệu vận hành phải là số MỚI: giữ lại bản cũ ở màn hình này là để
    // người trực ra quyết định trên dữ liệu quá hạn.
    staleTime: 0,
    refetchInterval: autoRefresh ? OPS_REFRESH_MS : false,
    queryFn: ({ signal }) => client.get('/ops/health', opsHealthResponseSchema, { signal }),
  });
}

/**
 * Đồng bộ lại một Epic.
 *
 * Nhận CẢ thân yêu cầu, không chỉ mã Epic. Bản trước cố định `{ full: false }`
 * ngay trong hàm, nên hai trong ba mức mà runbook mô tả không có đường vào từ
 * giao diện — muốn dùng phải mở dòng lệnh.
 */
export interface ResyncVariables {
  readonly epicKey: string;
  readonly body: ResyncRequest;
}

export function useResyncEpic(client: ApiClient = apiClient) {
  return useMutation({
    mutationFn: ({ epicKey, body }: ResyncVariables) =>
      client.post(`/epic/${epicKey}/resync`, body, resyncResponseSchema),
  });
}
