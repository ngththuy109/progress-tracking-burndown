import type { DateOnly } from './calendar.js';

/**
 * Ngày bắt đầu / kết thúc THỰC TẾ — PRD §2.7.2.
 *
 * Jira KHÔNG có sẵn hai trường này. Chúng được suy ra từ changelog và worklog.
 * Khác hẳn `wbs_start_date` / `wbs_end_date` là ngày **kế hoạch** do người dùng
 * điền tay.
 */
export interface SubtaskActualDates {
  readonly actualStart: DateOnly | null;
  /**
   * Chỉ có giá trị khi Sub-task ĐÃ Done. Chưa Done thì là `null` — KHÔNG tạm
   * tính từ worklog, tầng hiển thị ghi rõ "chưa tính" thay vì đưa ra một ngày
   * phỏng đoán mà PM sẽ đọc như thể việc đã xong.
   */
  readonly actualEnd: DateOnly | null;
  /** `true` = Sub-task CHƯA từng chuyển sang Done (khi đó `actualEnd` là null). */
  readonly actualEndIsProvisional: boolean;
}
