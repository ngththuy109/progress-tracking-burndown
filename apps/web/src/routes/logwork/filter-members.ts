import type { LogworkMember } from '@app/shared';

/**
 * Điều kiện lọc phía trình duyệt cho báo cáo Log work.
 *
 * MỘT lần gọi API tải cả kỳ; lọc diễn ra trong bộ nhớ nên gõ tới đâu thấy tới đó,
 * không request lại. Tách thành hàm THUẦN để test không cần DOM (CONVENTIONS.md:
 * logic ở hàm thuần, component chỉ nối dây).
 */
export interface LogworkFilter {
  /**
   * Từ khoá tìm kiếm, KHÔNG phân biệt hoa thường. Khớp trên tên hiển thị member,
   * MÃ ticket, và TIÊU ĐỀ ticket — nên gõ "PAY-11" hay "payout" đều ra. Rỗng =
   * không lọc theo từ khoá.
   */
  readonly term: string;
  /** Chỉ giữ member còn ticket chưa log (`notLoggedCount > 0`). */
  readonly notLoggedOnly: boolean;
}

export const EMPTY_FILTER: LogworkFilter = { term: '', notLoggedOnly: false };

/** Bộ lọc có đang thu hẹp gì không — để chọn đúng câu empty-state. */
export function isFilterActive(filter: LogworkFilter): boolean {
  return filter.term.trim() !== '' || filter.notLoggedOnly;
}

/**
 * Lọc danh sách member theo điều kiện tìm kiếm.
 *
 * - `notLoggedOnly` lọc ở MỨC member (bỏ ai đã log đủ), KHÔNG đụng vào danh sách
 *   ticket để các con số huy hiệu (máy chủ tính trên toàn bộ ticket) vẫn khớp.
 * - `term` khớp tên member → giữ NGUYÊN mọi ticket của họ (cần cả bối cảnh); nếu
 *   chỉ khớp ở ticket thì THU HẸP bảng còn đúng ticket khớp (tìm "PAY-11" thì chỉ
 *   thấy "PAY-11", không phải cả chục dòng khác).
 *
 * Member được thu hẹp ticket trả về dưới dạng object MỚI; member không đổi giữ
 * nguyên tham chiếu cũ (để React không dựng lại card, `open` không bị reset).
 */
export function filterMembers(
  members: readonly LogworkMember[],
  filter: LogworkFilter,
): LogworkMember[] {
  const term = filter.term.trim().toLowerCase();
  const out: LogworkMember[] = [];
  for (const m of members) {
    if (filter.notLoggedOnly && m.notLoggedCount === 0) continue;
    if (term === '') {
      out.push(m);
      continue;
    }
    const name = (m.displayName ?? m.accountId).toLowerCase();
    if (name.includes(term)) {
      out.push(m);
      continue;
    }
    const tickets = m.tickets.filter(
      (t) => t.issueKey.toLowerCase().includes(term) || t.summary.toLowerCase().includes(term),
    );
    if (tickets.length > 0) out.push({ ...m, tickets });
  }
  return out;
}
