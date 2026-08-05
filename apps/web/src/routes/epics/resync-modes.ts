import type { ResyncRequest } from '@app/shared';

/**
 * Ba mức đồng bộ lại — RUNBOOK mục "Dựng lại lịch sử một Epic".
 *
 * Tách khỏi React vì đây là phần dễ sai nhất và cũng dễ kiểm nhất: đổi một dòng
 * ở đây là đổi lượng công việc hệ thống phải làm, từ ~15 lần gọi Jira lên ~135.
 */

export type ResyncMode = 'QUICK' | 'FULL' | 'RANGE';

export interface ResyncDraft {
  readonly mode: ResyncMode;
  /** Chuỗi từ ô `<input type="date">`, luôn ở dạng `YYYY-MM-DD` hoặc rỗng. */
  readonly from: string;
  readonly to: string;
}

/**
 * Mặc định là mức RẺ NHẤT.
 *
 * Mặc định "Toàn bộ" thì người vội bấm Enter sẽ vô tình ngốn hạn mức gọi Jira
 * của cả hệ thống (R-04). Mức đắt phải là lựa chọn có ý thức.
 */
export const EMPTY_DRAFT: ResyncDraft = { mode: 'QUICK', from: '', to: '' };

export interface ResyncModeInfo {
  readonly mode: ResyncMode;
  readonly label: string;
  /** Câu nói rõ nó làm gì, đủ để chọn mà không cần mở runbook. */
  readonly detail: string;
}

/**
 * Thứ tự CỐ Ý: rẻ trước, đắt sau.
 *
 * Người đọc từ trên xuống sẽ gặp mức đủ dùng trước khi gặp mức tốn kém.
 */
export const RESYNC_MODES: readonly ResyncModeInfo[] = [
  {
    mode: 'QUICK',
    label: 'Quick — last 7 days',
    detail:
      'Reads only what changed since the last sync. Reaches further back on its own if older ' +
      'snapshots are missing. Right for almost every case.',
  },
  {
    mode: 'FULL',
    label: 'Full — from the first day until today',
    detail:
      'Re-reads EVERYTHING from Jira and recomputes from scratch. Takes about 40 seconds per ' +
      'Epic and uses the shared Jira rate limit. Only when Quick did not fix it.',
  },
  {
    mode: 'RANGE',
    label: 'A specific date range',
    detail:
      'For when you know exactly which period is wrong — say last month looks off. ' +
      'Much cheaper than Full.',
  },
];

/**
 * Điều gì đang ngăn không cho gửi. `null` = gửi được.
 *
 * Trả về CÂU HOÀN CHỈNH chứ không phải mã lỗi: chuỗi này hiện thẳng lên màn hình.
 */
export function draftError(draft: ResyncDraft): string | null {
  if (draft.mode !== 'RANGE') return null;

  if (draft.from === '' || draft.to === '') {
    return 'Pick both a start and an end date, or switch to Quick.';
  }
  if (draft.from > draft.to) {
    // Không tự đảo hai đầu: đảo ngầm sẽ giấu mất chuyện người dùng chọn nhầm.
    return `Start date ${draft.from} comes after end date ${draft.to}.`;
  }
  return null;
}

/**
 * Đổi lựa chọn trên màn hình thành thân yêu cầu gửi lên API.
 *
 * Mức RANGE cố ý KHÔNG gửi kèm `full: true`: dải ngày đã nói rõ cần dựng lại
 * khoảng nào rồi, thêm `full` chỉ làm hệ thống đọc lại toàn bộ Jira một cách
 * thừa thãi.
 */
export function draftToPayload(draft: ResyncDraft): ResyncRequest {
  if (draft.mode === 'FULL') return { from: null, to: null, full: true };
  if (draft.mode === 'RANGE') return { from: draft.from, to: draft.to, full: false };
  return { from: null, to: null, full: false };
}
