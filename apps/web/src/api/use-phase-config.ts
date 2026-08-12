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
  unmatchedResponseSchema,
  versionsResponseSchema,
  type ConfigPayload,
  type ConfigVersion,
  type EffectiveConfigResponse,
  type PreviewResponse,
  type SaveConfigResponse,
  type UnmatchedLabel,
} from '@app/shared';
import { apiClient, projectApiPath, type ApiClient } from './client.js';

/**
 * Sáu hook của màn hình cấu hình Phase — PRD Phụ lục B, bản multi-tenant.
 *
 * KHÁC các hook nghiệp vụ khác, `projectKey` ở đây là THAM SỐ TƯỜNG MINH kiểu
 * `string | null` thay vì lấy từ `ProjectProvider`:
 *   - chuỗi   → cấu hình CỦA DỰ ÁN đó, endpoint `/api/projects/:key/config/phase...`;
 *   - `null`  → bộ Mặc định (GLOBAL), endpoint quản trị `/api/admin/config/phase...`
 *               (chỉ ADMIN — API tự chặn).
 * Màn hình cấu hình cho phép ADMIN chuyển qua lại hai phạm vi ngay tại chỗ, nên
 * hook phải nhận được cả hai.
 */

/** Ghép đường dẫn nhóm config theo phạm vi: dự án hay bộ Mặc định (admin). */
export function phaseConfigPath(projectKey: string | null, suffix = ''): string {
  return projectKey === null
    ? `/admin/config/phase${suffix}`
    : projectApiPath(projectKey, `/config/phase${suffix}`);
}

/** Tiền tố query key: dự án nào, hay 'GLOBAL' cho bộ Mặc định. */
const scopeKey = (projectKey: string | null): string => projectKey ?? 'GLOBAL';

export const phaseConfigKeys = {
  all: (projectKey: string | null) => [scopeKey(projectKey), 'config', 'phase'] as const,
  effective: (projectKey: string | null) =>
    [scopeKey(projectKey), 'config', 'phase', 'effective'] as const,
  versions: (projectKey: string | null) =>
    [scopeKey(projectKey), 'config', 'phase', 'versions'] as const,
  unmatched: (projectKey: string | null) =>
    [scopeKey(projectKey), 'config', 'phase', 'unmatched'] as const,
};

export function useEffectiveConfig(
  projectKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<EffectiveConfigResponse, Error> {
  return useQuery({
    queryKey: phaseConfigKeys.effective(projectKey),
    queryFn: ({ signal }) =>
      client.get(phaseConfigPath(projectKey), effectiveConfigSchema, { signal }),
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
        .get(phaseConfigPath(projectKey, '/versions'), versionsResponseSchema, { signal })
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
        .get(phaseConfigPath(projectKey, '/unmatched'), unmatchedResponseSchema, { signal })
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
        phaseConfigPath(vars.projectKey, '/preview'),
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
        phaseConfigPath(vars.projectKey),
        { projectKey: vars.projectKey, payload: vars.payload, note: vars.note },
        saveConfigResponseSchema,
      ),
    onSuccess: (_data, vars) => {
      // Xoá cache CẢ NHÁNH `config.phase` của phạm vi vừa lưu: cấu hình hiệu
      // lực, danh sách version và danh sách nhãn chưa nhận diện đều đổi cùng lúc.
      void queryClient.invalidateQueries({ queryKey: phaseConfigKeys.all(vars.projectKey) });
      // Sửa bộ Mặc định lan sang MỌI dự án đang kế thừa — không biết dự án nào
      // nên xoá hết cache config của các phạm vi khác cho chắc.
      if (vars.projectKey === null) {
        void queryClient.invalidateQueries({
          predicate: (q) => q.queryKey[1] === 'config' && q.queryKey[2] === 'phase',
        });
      }
    },
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
        phaseConfigPath(vars.projectKey, `/rollback/${vars.version}`),
        undefined,
        saveConfigResponseSchema,
      ),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: phaseConfigKeys.all(vars.projectKey) });
    },
  });
}
