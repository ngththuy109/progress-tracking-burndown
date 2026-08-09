import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  signboardPhasesResponseSchema,
  signboardResponseSchema,
  unparsedResponseSchema,
  type SignboardPhasesResponse,
  type SignboardResponse,
  type UnparsedResponse,
} from '@app/shared';
import { apiClient, type ApiClient } from './client.js';

/**
 * Dữ liệu bảng Signboard.
 *
 * `staleTime: 0` — trạng thái ô phụ thuộc "hôm nay là ngày nào". Dữ liệu cũ giữ
 * qua nửa đêm sẽ hiện trạng thái của hôm qua và KHÔNG AI NHẬN RA: bảng vẫn hiện,
 * chỉ là sai.
 */

export const signboardKeys = {
  phases: (epicKey: string) => ['signboard', epicKey, 'phases'] as const,
  board: (epicKey: string, phaseCode: string) => ['signboard', epicKey, phaseCode] as const,
  unparsed: (epicKey: string, phaseCode: string) => ['signboard', epicKey, phaseCode, 'unparsed'] as const,
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
  return useQuery({
    queryKey: signboardKeys.phases(epicKey ?? ''),
    enabled: epicKey !== null && epicKey !== '',
    queryFn: ({ signal }) =>
      client.get(`/signboard/epic/${epicKey ?? ''}/phases`, signboardPhasesResponseSchema, {
        signal,
      }) as Promise<SignboardPhasesResponse>,
  });
}

export function useSignboard(
  epicKey: string | null,
  phaseCode: string | null,
  client: ApiClient = apiClient,
): UseQueryResult<SignboardResponse, Error> {
  return useQuery({
    queryKey: signboardKeys.board(epicKey ?? '', phaseCode ?? ''),
    enabled: epicKey !== null && phaseCode !== null && epicKey !== '' && phaseCode !== '',
    staleTime: 0,
    queryFn: ({ signal }) =>
      client.get(
        `/signboard/epic/${epicKey ?? ''}/phase/${phaseCode ?? ''}`,
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
  return useQuery({
    queryKey: signboardKeys.unparsed(epicKey ?? '', phaseCode ?? ''),
    enabled: epicKey !== null && phaseCode !== null && epicKey !== '' && phaseCode !== '',
    queryFn: ({ signal }) =>
      client.get(
        `/signboard/epic/${epicKey ?? ''}/phase/${phaseCode ?? ''}/unparsed`,
        unparsedResponseSchema,
        { signal },
      ),
  });
}
