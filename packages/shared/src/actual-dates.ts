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
  readonly actualEnd: DateOnly | null;
  /**
   * `true` = Sub-task CHƯA từng chuyển sang Done, nên `actualEnd` mới chỉ là
   * ngày worklog cuối cùng — một phỏng đoán, không phải sự thật.
   *
   * Tầng hiển thị phải phân biệt rõ hai thứ này, nếu không PM sẽ đọc một ngày
   * kết thúc tạm tính như thể việc đã xong.
   */
  readonly actualEndIsProvisional: boolean;
}
