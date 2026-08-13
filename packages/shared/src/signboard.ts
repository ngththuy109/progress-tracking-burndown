import type { DateOnly } from './calendar.js';
import type { SignboardStatus } from './enums.js';
import type { StatusCategory } from './enums.js';

/**
 * Bảng Signboard — PRD §6.
 *
 * Trạng thái ô phụ thuộc **hôm nay là ngày nào** (`hôm nay > plan_end` →
 * `Delay End`), nên nó được tính LÚC ĐỌC chứ không chốt sẵn từ đêm hôm trước
 * (PRD §9.1). Đó cũng là lý do mọi hàm ở đây nhận `asOfDate` qua tham số.
 */

export interface CellStatusInput {
  readonly statusCategory: StatusCategory;
  /** `wbs_start_date` — ngày KẾ HOẠCH, do người dùng điền trên Jira. */
  readonly planStart: DateOnly | null;
  readonly planEnd: DateOnly | null;
  /** Ngày THỰC TẾ, suy ra từ lịch sử (T-14). */
  readonly actualStart: DateOnly | null;
}

/**
 * Một người phụ trách (PIC) — gom từ "Request participants" của Jira.
 *
 * `accountId` là khoá bỏ trùng (cùng người trên nhiều Sub-task chỉ hiện MỘT lần).
 * `displayName` tra từ Jira lúc đồng bộ; `null` khi field chỉ có accountId và tra
 * tên chưa được (thiếu quyền/API lỗi) — khi đó giao diện hiện accountId.
 */
export interface SignboardPic {
  readonly accountId: string;
  readonly displayName: string | null;
}

/** Một ticket trong ô, kèm trạng thái riêng — dùng cho tooltip. */
export interface CellTicket {
  readonly issueKey: string;
  readonly planStart: DateOnly | null;
  readonly planEnd: DateOnly | null;
  readonly actualStart: DateOnly | null;
  readonly actualEnd: DateOnly | null;
  readonly status: SignboardStatus;
}

/**
 * Một ô của bảng.
 *
 * `present: false` là **ô trống** — Function này vốn không có khâu đó. Khác hẳn
 * `status: 'NO_PLAN'` là *có* ticket nhưng thiếu ngày kế hoạch (PRD §6.6). Gộp
 * hai khái niệm này lại sẽ làm thanh tóm tắt đếm sai.
 */
export type SignboardCell =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly planStart: DateOnly | null;
      readonly planEnd: DateOnly | null;
      readonly actualStart: DateOnly | null;
      readonly actualEnd: DateOnly | null;
      readonly status: SignboardStatus;
      readonly ticketCount: number;
      readonly tickets: readonly CellTicket[];
    };

export const EMPTY_CELL: SignboardCell = { present: false };
