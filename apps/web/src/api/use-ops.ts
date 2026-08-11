import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  dataQualityIssuesResponseSchema,
  dqExemptResponseSchema,
  opsHealthResponseSchema,
  OPS_REFRESH_MS,
  resyncResponseSchema,
  syncRunDetailSchema,
  type DataQualityIssuesResponse,
  type OpsHealthResponse,
  type ResyncRequest,
  type SyncRunDetail,
} from '@app/shared';
import { apiClient, type ApiClient } from './client.js';

/**
 * Số liệu vận hành.
 *
 * MỘT lần gọi cho cả bốn nhóm. Gọi sáu endpoint sẽ làm dashboard tự góp phần
 * vào tải của hệ thống đang tải nặng — đúng lúc không nên.
 */

export const opsKeys = {
  health: ['ops', 'health'] as const,
  runDetail: (runId: string) => ['ops', 'run', runId] as const,
  dqIssues: ['ops', 'data-quality', 'issues'] as const,
};

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

/**
 * Chi tiết MỘT lần chạy job — bước lỗi, nguyên nhân, stack.
 *
 * Chỉ gọi khi người dùng bấm vào một dòng FAILED (`runId` khác null): mở sẵn
 * cho cả 20 dòng là 20 request mà 19 cái không ai đọc.
 */
export function useRunDetail(
  runId: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<SyncRunDetail, Error> {
  return useQuery({
    queryKey: opsKeys.runDetail(runId ?? 'none'),
    enabled: runId !== null,
    queryFn: ({ signal }) => client.get(`/ops/runs/${runId}`, syncRunDetailSchema, { signal }),
  });
}

/**
 * Danh sách TỪNG ticket lỗi dữ liệu — nguồn của bảng chi tiết và file CSV.
 *
 * `enabled` đi theo nút "Show details": danh sách này có thể dài hàng trăm
 * dòng, không tải khi người dùng chỉ nhìn số tổng.
 */
export function useDataQualityIssues(
  enabled: boolean,
  client: ApiClient = apiClient,
): UseQueryResult<DataQualityIssuesResponse, Error> {
  return useQuery({
    queryKey: opsKeys.dqIssues,
    enabled,
    staleTime: 0,
    queryFn: ({ signal }) =>
      client.get('/ops/data-quality/issues', dataQualityIssuesResponseSchema, { signal }),
  });
}

export interface DqExemptVariables {
  readonly issueKey: string;
  readonly exempt: boolean;
}

/**
 * Đánh dấu/gỡ đánh dấu "không cần sửa dữ liệu" cho một Sub-task.
 *
 * Làm mới CẢ danh sách chi tiết LẪN số tổng: ticket vừa được bỏ qua phải biến
 * mất khỏi các tỉ lệ ngay, không đợi vòng auto-refresh 60 giây.
 */
export function useSetDqExempt(client: ApiClient = apiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ issueKey, exempt }: DqExemptVariables) =>
      client.put(`/ops/data-quality/issues/${issueKey}/exempt`, { exempt }, dqExemptResponseSchema),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: opsKeys.dqIssues });
      void queryClient.invalidateQueries({ queryKey: opsKeys.health });
    },
  });
}
