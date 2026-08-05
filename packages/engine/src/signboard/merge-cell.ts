import {
  SIGNBOARD_STATUS_RANK,
  type CellTicket,
  type DateOnly,
  type SignboardCell,
  type SignboardStatus,
} from '@app/shared';

/**
 * Gộp nhiều Sub-task rơi vào cùng một ô — PRD §6.5.
 *
 * `COMPLETED` xếp hạng **0**, nghĩa là nó THUA mọi trạng thái khác khi gộp.
 * Trực giác dễ nghĩ ngược lại ("xong rồi thì tốt nhất"), nhưng ô có 1 ticket
 * xong và 1 ticket chưa bắt đầu thì ô đó **chưa xong** — hiện màu xanh là nói
 * dối với PM.
 */

/** Trạng thái XẤU NHẤT trong danh sách. Danh sách rỗng trả `null`. */
export function mergeCellStatus(
  statuses: readonly SignboardStatus[],
): SignboardStatus | null {
  let worst: SignboardStatus | null = null;
  for (const s of statuses) {
    if (worst === null || SIGNBOARD_STATUS_RANK[s] > SIGNBOARD_STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

/**
 * Nhỏ nhất / lớn nhất trong các giá trị KHÔNG null.
 *
 * Toàn `null` phải trả `null`, không trả `Infinity`: `Math.min()` trên mảng
 * rỗng cho `Infinity`, và giá trị đó lọt xuống dưới sẽ thành một ngày vô nghĩa.
 */
export function minDate(dates: readonly (DateOnly | null)[]): DateOnly | null {
  let best: DateOnly | null = null;
  for (const d of dates) {
    if (d === null) continue;
    if (best === null || d < best) best = d;
  }
  return best;
}

export function maxDate(dates: readonly (DateOnly | null)[]): DateOnly | null {
  let best: DateOnly | null = null;
  for (const d of dates) {
    if (d === null) continue;
    if (best === null || d > best) best = d;
  }
  return best;
}

/**
 * Dựng một ô từ danh sách ticket đã có trạng thái riêng.
 *
 * Danh sách rỗng → ô TRỐNG (`present: false`), không phải `NO_PLAN`. Ô trống
 * nghĩa là Function này vốn không cần khâu đó — bình thường, không tính vào
 * thống kê. `NO_PLAN` là *có* ticket nhưng thiếu ngày, tức một vấn đề cần sửa
 * (PRD §6.6).
 */
export function mergeCell(tickets: readonly CellTicket[]): SignboardCell {
  if (tickets.length === 0) return { present: false };

  const status = mergeCellStatus(tickets.map((t) => t.status));
  // `tickets` không rỗng nên `mergeCellStatus` chắc chắn có giá trị.
  if (status === null) return { present: false };

  return {
    present: true,
    planStart: minDate(tickets.map((t) => t.planStart)),
    planEnd: maxDate(tickets.map((t) => t.planEnd)),
    actualStart: minDate(tickets.map((t) => t.actualStart)),
    // Ô chỉ thật sự "kết thúc" khi ticket muộn nhất kết thúc.
    actualEnd: maxDate(tickets.map((t) => t.actualEnd)),
    status,
    ticketCount: tickets.length,
    tickets,
  };
}
