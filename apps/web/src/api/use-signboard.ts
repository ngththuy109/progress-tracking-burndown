import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  signboardPhasesResponseSchema,
  signboardResponseSchema,
  unparsedResponseSchema,
  type SignboardPhasesResponse,
  type SignboardResponse,
  type UnparsedResponse,
} from '@app/shared';
import { useProjectKey } from '../project/project-context.js';
import { apiClient, projectApiPath, type ApiClient } from './client.js';

/**
 * Dữ liệu bảng Signboard — theo phạm vi dự án (`/p/:projectKey`).
 *
 * `staleTime: 0` — trạng thái ô phụ thuộc "hôm nay là ngày nào". Dữ liệu cũ giữ
 * qua nửa đêm sẽ hiện trạng thái của hôm qua và KHÔNG AI NHẬN RA: bảng vẫn hiện,
 * chỉ là sai.
 */

export const signboardKeys = {
  phases: (projectKey: string, epicKey: string) => [projectKey, 'signboard', epicKey, 'phases'] as const,
  board: (projectKey: string, epicKey: string, phaseCode: string) =>
    [projectKey, 'signboard', epicKey, phaseCode] as const,
  unparsed: (projectKey: string, epicKey: string, phaseCode: string) =>
    [projectKey, 'signboard', epicKey, phaseCode, 'unparsed'] as const,
};

/**
 * Các Phase CÓ Sub-task trong Epic — nguồn cho bộ chọn Phase.
 *
 * PM không phải nhớ và gõ tay mã Phase nữa: mở màn hình là thấy ngay Phase nào
 * có dữ liệu, và chuyển qua lại được. Không phụ thuộc "hôm nay" nên KHÔNG cần
 * `staleTime: 0` như bảng — danh sách chỉ đổi khi đồng bộ Jira.
 */
export function useSignboardPhases(
  epicKey: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<SignboardPhasesResponse, Error> {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: signboardKeys.phases(projectKey, epicKey ?? ''),
    enabled: epicKey !== null && epicKey !== '',
    queryFn: ({ signal }) =>
      client.get(
        projectApiPath(projectKey, `/epics/${epicKey ?? ''}/signboard/phases`),
        signboardPhasesResponseSchema,
        { signal },
      ) as Promise<SignboardPhasesResponse>,
  });
}

export function useSignboard(
  epicKey: string | null,
  phaseCode: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<SignboardResponse, Error> {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: signboardKeys.board(projectKey, epicKey ?? '', phaseCode ?? ''),
    enabled: epicKey !== null && phaseCode !== null && epicKey !== '' && phaseCode !== '',
    staleTime: 0,
    queryFn: ({ signal }) =>
      client.get(
        projectApiPath(projectKey, `/epics/${epicKey ?? ''}/signboard/phase/${phaseCode ?? ''}`),
        signboardResponseSchema,
        { signal },
      ) as Promise<SignboardResponse>,
  });
}

export function useUnparsedSubtasks(
  epicKey: string | null,
  phaseCode: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<UnparsedResponse, Error> {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: signboardKeys.unparsed(projectKey, epicKey ?? '', phaseCode ?? ''),
    enabled: epicKey !== null && phaseCode !== null && epicKey !== '' && phaseCode !== '',
    queryFn: ({ signal }) =>
      client.get(
        projectApiPath(projectKey, `/epics/${epicKey ?? ''}/signboard/phase/${phaseCode ?? ''}/unparsed`),
        unparsedResponseSchema,
        { signal },
      ),
  });
}
