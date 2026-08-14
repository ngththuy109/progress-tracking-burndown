import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
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
  phases: (epicKey: string, stage: string | null) => ['signboard', epicKey, 'phases', stage ?? ''] as const,
  board: (epicKey: string, phaseCode: string, stage: string | null) =>
    ['signboard', epicKey, phaseCode, stage ?? ''] as const,
  unparsed: (epicKey: string, phaseCode: string, stage: string | null) =>
    ['signboard', epicKey, phaseCode, stage ?? '', 'unparsed'] as const,
};

/** `?stage=` chỉ gửi khi có chọn nhóm (buildUrl bỏ qua undefined). */
const stageQuery = (stage: string | null) => ({ stage: stage ?? undefined });

/**
 * Các Phase CÓ Sub-task trong Epic — nguồn cho bộ chọn Phase.
 *
 * PM không phải nhớ và gõ tay mã Phase nữa: mở màn hình là thấy ngay Phase nào
 * có dữ liệu, và chuyển qua lại được. Không phụ thuộc "hôm nay" nên KHÔNG cần
 * `staleTime: 0` như bảng — danh sách chỉ đổi khi đồng bộ Jira.
 */
export function useSignboardPhases(
  epicKey: string | null,
  stage: string | null = null,
  client: ApiClient = apiClient,
): UseQueryResult<SignboardPhasesResponse, Error> {
  return useQuery({
    queryKey: signboardKeys.phases(epicKey ?? '', stage),
    enabled: epicKey !== null && epicKey !== '',
    // Đổi bộ lọc Giai đoạn = đổi query key. Giữ dữ liệu cũ trong lúc tải để thanh
    // chọn nhóm/Phase không biến mất chớp nhoáng (mất luôn nút vừa bấm).
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      client.get(`/signboard/epic/${epicKey ?? ''}/phases`, signboardPhasesResponseSchema, {
        signal,
        query: stageQuery(stage),
      }) as Promise<SignboardPhasesResponse>,
  });
}

export function useSignboard(
  epicKey: string | null,
  phaseCode: string | null,
  stage: string | null = null,
  client: ApiClient = apiClient,
): UseQueryResult<SignboardResponse, Error> {
  return useQuery({
    queryKey: signboardKeys.board(epicKey ?? '', phaseCode ?? '', stage),
    enabled: epicKey !== null && phaseCode !== null && epicKey !== '' && phaseCode !== '',
    staleTime: 0,
    queryFn: ({ signal }) =>
      client.get(
        `/signboard/epic/${epicKey ?? ''}/phase/${phaseCode ?? ''}`,
        signboardResponseSchema,
        { signal, query: stageQuery(stage) },
      ) as Promise<SignboardResponse>,
  });
}

export function useUnparsedSubtasks(
  epicKey: string | null,
  phaseCode: string | null,
  stage: string | null = null,
  client: ApiClient = apiClient,
): UseQueryResult<UnparsedResponse, Error> {
  return useQuery({
    queryKey: signboardKeys.unparsed(epicKey ?? '', phaseCode ?? '', stage),
    enabled: epicKey !== null && phaseCode !== null && epicKey !== '' && phaseCode !== '',
    queryFn: ({ signal }) =>
      client.get(
        `/signboard/epic/${epicKey ?? ''}/phase/${phaseCode ?? ''}/unparsed`,
        unparsedResponseSchema,
        { signal, query: stageQuery(stage) },
      ),
  });
}
