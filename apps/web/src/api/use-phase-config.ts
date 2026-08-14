import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  effectiveConfigSchema,
  previewResponseSchema,
  saveConfigResponseSchema,
  tiersPreviewResponseSchema,
  unmatchedResponseSchema,
  versionsResponseSchema,
  type ConfigPayload,
  type ConfigVersion,
  type EffectiveConfigResponse,
  type GroupTier,
  type PreviewResponse,
  type SaveConfigResponse,
  type TiersPreviewResponse,
  type UnmatchedLabel,
} from '@app/shared';
import { apiClient, type ApiClient } from './client.js';

/**
 * Sáu hook của màn hình cấu hình Phase — PRD Phụ lục B.
 *
 * Mọi schema đều lấy từ `@app/shared`. Không khai lại kiểu ở đây: T-09 đã đặc
 * tả xong hợp đồng, khai lại là hai bên lệch nhau lúc nào không ai biết.
 *
 * `client` truyền vào được để test dựng được mọi tình huống mà không đụng tới
 * `globalThis.fetch`.
 */

export const phaseConfigKeys = {
  all: ['config', 'phase'] as const,
  effective: (projectKey: string | null) => ['config', 'phase', 'effective', projectKey] as const,
  versions: (projectKey: string | null) => ['config', 'phase', 'versions', projectKey] as const,
  unmatched: (projectKey: string | null) => ['config', 'phase', 'unmatched', projectKey] as const,
};

/** `?project=` chỉ gửi khi đang làm việc trên một project cụ thể. */
function scopeQuery(projectKey: string | null): { query: { project: string } } | Record<string, never> {
  return projectKey === null ? {} : { query: { project: projectKey } };
}

export function useEffectiveConfig(
  projectKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<EffectiveConfigResponse, Error> {
  return useQuery({
    queryKey: phaseConfigKeys.effective(projectKey),
    queryFn: ({ signal }) =>
      client.get('/config/phase', effectiveConfigSchema, { signal, ...scopeQuery(projectKey) }),
  });
}

export function useVersions(
  projectKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<readonly ConfigVersion[], Error> {
  return useQuery({
    queryKey: phaseConfigKeys.versions(projectKey),
    queryFn: ({ signal }) =>
      client
        .get('/config/phase/versions', versionsResponseSchema, { signal, ...scopeQuery(projectKey) })
        .then((r) => r.versions),
  });
}

export function useUnmatched(
  projectKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<readonly UnmatchedLabel[], Error> {
  return useQuery({
    queryKey: phaseConfigKeys.unmatched(projectKey),
    queryFn: ({ signal }) =>
      client
        .get('/config/phase/unmatched', unmatchedResponseSchema, { signal, ...scopeQuery(projectKey) })
        .then((r) => r.labels),
  });
}

export interface PreviewVars {
  readonly projectKey: string | null;
  readonly draft: ConfigPayload;
}

/**
 * Xem thử — là MUTATION chứ không phải query.
 *
 * Không phải vì nó ghi gì (nó không ghi gì cả), mà vì nó chỉ được chạy KHI PM
 * BẤM NÚT. Làm thành `useQuery` thì TanStack Query sẽ tự gọi lại theo vòng đời
 * cache, và mỗi lần gõ một ký tự vào ô từ khoá là một request lên máy chủ.
 */
export function usePreview(
  client: ApiClient = apiClient,
): UseMutationResult<PreviewResponse, Error, PreviewVars> {
  return useMutation({
    mutationFn: (vars: PreviewVars) =>
      client.post(
        '/config/phase/preview',
        { projectKey: vars.projectKey, draft: vars.draft, limit: 200 },
        previewResponseSchema,
      ),
  });
}

export interface SaveVars {
  readonly projectKey: string | null;
  readonly payload: ConfigPayload;
  readonly note: string | null;
}

export function useSaveConfig(
  client: ApiClient = apiClient,
): UseMutationResult<SaveConfigResponse, Error, SaveVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: SaveVars) =>
      client.put(
        '/config/phase',
        { projectKey: vars.projectKey, payload: vars.payload, note: vars.note },
        saveConfigResponseSchema,
      ),
    onSuccess: () => {
      // Xoá cache CẢ NHÁNH `config.phase`: lưu xong thì cấu hình hiệu lực, danh
      // sách version và danh sách nhãn chưa nhận diện được đều đổi cùng lúc.
      void queryClient.invalidateQueries({ queryKey: phaseConfigKeys.all });
    },
  });
}

export interface TiersPreviewVars {
  /** Mỗi phần tử một tiêu đề Task (bảng ticket mẫu của demo — tối đa 50). */
  readonly taskTitles: readonly string[];
  readonly tiers: readonly GroupTier[];
}

/**
 * Xem thử cấu trúc tầng: dán các tiêu đề Task → từng tầng (bản NHÁP đang sửa)
 * bóc ra mã gì. Mutation chứ không phải query — thân mang cả state nháp.
 */
export function useTiersPreview(
  client: ApiClient = apiClient,
): UseMutationResult<TiersPreviewResponse, Error, TiersPreviewVars> {
  return useMutation({
    mutationFn: (vars: TiersPreviewVars) =>
      client.post(
        '/config/phase/tiers-preview',
        { taskTitles: [...vars.taskTitles], tiers: [...vars.tiers] },
        tiersPreviewResponseSchema,
      ),
  });
}

export interface RollbackVars {
  readonly projectKey: string | null;
  readonly version: number;
}

export function useRollback(
  client: ApiClient = apiClient,
): UseMutationResult<SaveConfigResponse, Error, RollbackVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: RollbackVars) =>
      client.post(
        `/config/phase/rollback/${vars.version}`,
        undefined,
        saveConfigResponseSchema,
        scopeQuery(vars.projectKey),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: phaseConfigKeys.all });
    },
  });
}
