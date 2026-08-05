import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  signboardResponseSchema,
  unparsedResponseSchema,
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
  board: (epicKey: string, phaseCode: string) => ['signboard', epicKey, phaseCode] as const,
  unparsed: (epicKey: string, phaseCode: string) => ['signboard', epicKey, phaseCode, 'unparsed'] as const,
};

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
