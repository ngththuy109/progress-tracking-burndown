import { z } from 'zod';
import { STATUS_CATEGORY } from './enums.js';

/**
 * Hợp đồng HTTP: danh sách Sub-task NHÓM THEO Phase đã định nghĩa — của MỘT Epic.
 *
 * Khác với `phase_rollup` (chỉ giữ tổng hợp: ngày plan/actual, đếm số Sub-task),
 * endpoint này liệt kê TỪNG Sub-task nằm trong mỗi Phase, để PM soi được ticket
 * nào thuộc khâu nào mà không phải mở Jira.
 *
 * Ba quy tắc dựng danh sách (xem `phase-subtasks.service.ts`):
 *   1. MỌI Phase đã định nghĩa đều hiện ra, kể cả khi CHƯA có Sub-task nào —
 *      "hiển thị danh sách của các Phase đã định nghĩa" nghĩa là thấy đủ bộ
 *      khung, không phải chỉ những Phase tình cờ đang có ticket.
 *   2. Sub-task mang `phase_code` KHÔNG khớp Phase nào (kể cả `UNCLASSIFIED`)
 *      vẫn hiện, gom thành nhóm riêng ở CUỐI — chúng vẫn cộng vào biểu đồ
 *      Burndown (C-11), giấu đi thì tổng không khớp.
 *   3. Phase đã định nghĩa xếp theo `display_order`; nhóm ngoài luồng xếp sau.
 */

export const phaseSubtaskTicketSchema = z.object({
  issueKey: z.string(),
  summary: z.string(),
  /** Task cha mà Sub-task này thuộc về. `null` khi Jira không trả cha. */
  parentKey: z.string().nullable(),
  statusCategory: z.enum(STATUS_CATEGORY),
  /** `wbs_start_date` / `wbs_end_date` — `null` khi PM chưa điền trên Jira. */
  planStart: z.string().nullable(),
  planEnd: z.string().nullable(),
  /**
   * Ngày bắt đầu/kết thúc THỰC TẾ, đọc từ `subtask_actual_dates` (engine suy ra
   * từ changelog + worklog, T-14). `null` khi job dựng lại chưa chạy hoặc
   * Sub-task chưa có hoạt động nào.
   */
  actualStart: z.string().nullable(),
  actualEnd: z.string().nullable(),
  originalEstimateHours: z.number(),
  /** Tổng giờ ĐÃ LOG (worklog) — `jira_issue.time_spent_s` đổi sang giờ. */
  timeSpentHours: z.number(),
  /** Bóc từ tiêu đề Sub-task (PRD §2.9) — chỉ để nhìn, không phân loại. */
  functionName: z.string().nullable(),
  taskType: z.string().nullable(),
});

export const phaseSubtaskGroupSchema = z.object({
  phaseCode: z.string(),
  /** Nhãn hiển thị lấy từ cấu hình; `null` với nhóm ngoài luồng (chưa định nghĩa). */
  label: z.string().nullable(),
  colorHex: z.string().nullable(),
  /** `true` = Phase có trong cấu hình đang hiệu lực; `false` = nhóm ngoài luồng. */
  isDefined: z.boolean(),
  subtaskCount: z.number().int(),
  tickets: z.array(phaseSubtaskTicketSchema),
});

export const phaseSubtaskResponseSchema = z.object({
  epicKey: z.string(),
  groups: z.array(phaseSubtaskGroupSchema),
  /** Tổng Sub-task ĐANG HOẠT ĐỘNG (đã bỏ ticket gỡ khỏi Epic). */
  totalSubtasks: z.number().int(),
});

/**
 * Kiểu TypeScript khai TAY để giữ `readonly` xuyên suốt (zod sinh mảng sửa
 * được). Schema ở trên vẫn dùng để `apps/web` kiểm dữ liệu tại biên (T-20).
 */
export interface PhaseSubtaskTicket {
  readonly issueKey: string;
  readonly summary: string;
  readonly parentKey: string | null;
  readonly statusCategory: (typeof STATUS_CATEGORY)[number];
  readonly planStart: string | null;
  readonly planEnd: string | null;
  readonly actualStart: string | null;
  readonly actualEnd: string | null;
  readonly originalEstimateHours: number;
  readonly timeSpentHours: number;
  readonly functionName: string | null;
  readonly taskType: string | null;
}

export interface PhaseSubtaskGroup {
  readonly phaseCode: string;
  readonly label: string | null;
  readonly colorHex: string | null;
  readonly isDefined: boolean;
  readonly subtaskCount: number;
  readonly tickets: readonly PhaseSubtaskTicket[];
}

export interface PhaseSubtaskResponse {
  readonly epicKey: string;
  readonly groups: readonly PhaseSubtaskGroup[];
  readonly totalSubtasks: number;
}
