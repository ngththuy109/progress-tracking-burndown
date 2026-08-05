import type { ChangelogEvent, StatusIdMap, StatusCategory } from '@app/shared';

/**
 * Nhóm trạng thái của một issue TẠI MỘT MỐC THỜI GIAN trong quá khứ.
 *
 * Cách làm: bắt đầu từ trạng thái lúc issue mới tạo (luôn là `new`), rồi "tua"
 * lần lượt các sự kiện đổi trạng thái cho tới mốc `tMs`.
 *
 * HAI ĐIỀU BẮT BUỘC (CONVENTIONS.md C-4):
 *
 * 1. Chỉ dùng `statusCategory`. TUYỆT ĐỐI CẤM so sánh `status.name` — tên hiển
 *    thị là tiếng Nhật (完了, 対応中) và admin đổi được bất cứ lúc nào.
 *
 * 2. Trong changelog, Jira ghi `from`/`to` là **status ID dạng số** (ví dụ
 *    "10001"), KHÔNG phải statusCategory. Phải tra qua `statusIdMap`.
 *
 * KHÔNG cache "đã done thì mãi mãi done": ca mở lại (PRD E-13) sẽ mất trắng
 * khối lượng công việc, và lỗi đó im lặng — biểu đồ vẫn vẽ, chỉ là sai.
 */
export function resolveStatusCategoryAt(
  changelog: readonly ChangelogEvent[],
  statusIdMap: StatusIdMap,
  tMs: number,
  onWarning?: (code: string, detail: string) => void,
): StatusCategory {
  let current: StatusCategory = 'new';

  for (const ev of changelog) {
    if (ev.field !== 'status') continue;
    if (ev.createdAtMs > tMs) break; // đã vượt qua mốc T, dừng

    if (ev.toValue === null) continue;

    const next = statusIdMap.get(ev.toValue);
    if (next === undefined) {
      // Trạng thái vừa bị admin xoá khỏi Jira. Giữ nguyên trạng thái trước đó
      // và ghi cảnh báo — KHÔNG ném lỗi làm sập cả job (C-9).
      onWarning?.('UNKNOWN_STATUS_ID', `Không tra được status ID "${ev.toValue}"`);
      continue;
    }
    current = next;
  }

  return current;
}

/**
 * Lần ĐẦU TIÊN issue chuyển sang nhóm `indeterminate` (In Progress).
 * Trả về mốc mili-giây, hoặc null nếu chưa từng.
 */
export function findFirstInProgressMs(
  changelog: readonly ChangelogEvent[],
  statusIdMap: StatusIdMap,
): number | null {
  for (const ev of changelog) {
    if (ev.field !== 'status' || ev.toValue === null) continue;
    if (statusIdMap.get(ev.toValue) === 'indeterminate') return ev.createdAtMs;
  }
  return null;
}

/**
 * Lần CUỐI CÙNG issue chuyển sang nhóm `done`.
 *
 * Phải là lần cuối, không phải lần đầu: task Done ngày 12/03, mở lại 13/03, Done
 * lại 16/03 thì ngày kết thúc thật là 16/03. Lấy lần đầu sẽ mất trắng 4 ngày làm
 * lại — và đó là lỗi im lặng (PRD E-13, §2.7.2).
 */
export function findLastDoneMs(
  changelog: readonly ChangelogEvent[],
  statusIdMap: StatusIdMap,
): number | null {
  let last: number | null = null;
  for (const ev of changelog) {
    if (ev.field !== 'status' || ev.toValue === null) continue;
    if (statusIdMap.get(ev.toValue) === 'done') last = ev.createdAtMs;
  }
  return last;
}
