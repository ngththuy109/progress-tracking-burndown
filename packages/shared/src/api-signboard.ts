import { z } from 'zod';
import { SIGNBOARD_STATUS } from './enums.js';
import type { SignboardCell } from './signboard.js';

/**
 * Hợp đồng HTTP của bảng Signboard — PRD §6.
 *
 * Signboard KHÔNG có bảng snapshot: trạng thái ô phụ thuộc **hôm nay là ngày
 * nào**, nên phải tính lúc đọc. Dữ liệu nguồn đã có sẵn trong `jira_issue`, nên
 * mỗi lần gọi chỉ là một truy vấn cộng một hàm thuần.
 */

export const signboardTicketSchema = z.object({
  issueKey: z.string(),
  planStart: z.string().nullable(),
  planEnd: z.string().nullable(),
  actualStart: z.string().nullable(),
  actualEnd: z.string().nullable(),
  status: z.enum(SIGNBOARD_STATUS),
});

export const signboardCellSchema = z.union([
  /**
   * Ô TRỐNG — Function này vốn không có khâu đó.
   *
   * KHÁC HẲN `status: 'NO_PLAN'` (có ticket nhưng thiếu ngày). Gộp hai khái niệm
   * làm thanh tóm tắt đếm sai và PM đi tìm hàng chục việc không tồn tại (§6.5).
   */
  z.object({ present: z.literal(false) }),
  z.object({
    present: z.literal(true),
    planStart: z.string().nullable(),
    planEnd: z.string().nullable(),
    actualStart: z.string().nullable(),
    actualEnd: z.string().nullable(),
    status: z.enum(SIGNBOARD_STATUS),
    ticketCount: z.number().int(),
    tickets: z.array(signboardTicketSchema),
  }),
]);

export const signboardColumnHeaderSchema = z.object({
  taskCode: z.string(),
  label: z.string(),
});

export const signboardRowSchema = z.object({
  /** Khoá gộp hàng: NFKC + chữ thường (E-31). */
  functionKey: z.string(),
  /** Dạng hiển thị — lấy theo lần gặp ĐẦU TIÊN. */
  functionName: z.string(),
  /** Cùng thứ tự với `columns`. */
  cells: z.array(signboardCellSchema),
  /** Ô "Tổng" của hàng: trạng thái xấu nhất trong các ô có mặt. */
  total: signboardCellSchema,
});

export const signboardSummarySchema = z.object({
  byStatus: z.record(z.string(), z.number().int()),
  /** Ô trống KHÔNG được đếm vào bất kỳ trạng thái nào. */
  emptyCells: z.number().int(),
  totalCells: z.number().int(),
});

export const signboardResponseSchema = z.object({
  epicKey: z.string(),
  phaseCode: z.string(),
  /** Ngày dùng để tính trạng thái. Luôn trả ra để người xem biết đang so với hôm nào. */
  asOfDate: z.string(),
  columns: z.array(signboardColumnHeaderSchema),
  rows: z.array(signboardRowSchema),
  summary: signboardSummarySchema,
  /** `true` khi > 30% Sub-task của Phase không phân tách được tiêu đề (E-27). */
  parseHealthWarning: z.boolean(),
});

/**
 * Kiểu TypeScript khai TAY chứ không lấy từ `z.infer`.
 *
 * Lý do: zod sinh ra mảng có thể sửa được, còn `SignboardCell` của engine khai
 * `readonly`. Hai bên không khớp nhau, mà `SignboardCell` mới là nguồn sự thật —
 * nó là thứ T-22 đã kiểm bằng 38 test. Schema zod ở trên vẫn dùng để frontend
 * kiểm dữ liệu tại biên.
 */
export interface SignboardRow {
  readonly functionKey: string;
  readonly functionName: string;
  readonly cells: readonly SignboardCell[];
  readonly total: SignboardCell;
}

export interface SignboardResponse {
  readonly epicKey: string;
  readonly phaseCode: string;
  readonly asOfDate: string;
  readonly columns: readonly { readonly taskCode: string; readonly label: string }[];
  readonly rows: readonly SignboardRow[];
  readonly summary: {
    readonly byStatus: Readonly<Record<string, number>>;
    readonly emptyCells: number;
    readonly totalCells: number;
  };
  readonly parseHealthWarning: boolean;
}

/**
 * Một Phase CÓ Sub-task trong Epic — nguồn cho bộ chọn Phase của Signboard.
 *
 * Signboard trước đây bắt PM tự GÕ mã Phase, không biết Phase nào có dữ liệu.
 * Endpoint này liệt kê đúng những Phase mà bảng sẽ dựng được ô, nên bộ chọn chỉ
 * hiện Phase "mở ra là có gì để xem".
 */
export const signboardPhaseSchema = z.object({
  phaseCode: z.string(),
  /** Nhãn hiển thị lấy từ cấu hình Phase; `null` khi Phase chưa được định nghĩa. */
  label: z.string().nullable(),
  /** Số Sub-task mang mã Phase này (kể cả loại chưa lên được bảng). */
  subtaskCount: z.number().int(),
});

export const signboardPhasesResponseSchema = z.object({
  epicKey: z.string(),
  /** Đã sắp theo `display_order` của cấu hình; Phase lạ xếp sau, theo mã. */
  phases: z.array(signboardPhaseSchema),
});

/**
 * Kiểu TS khai TAY (không lấy `z.infer`) để `phases` là mảng `readonly`.
 *
 * Cùng lý do với `SignboardResponse` bên dưới: cổng đọc trả mảng `readonly`, còn
 * `z.infer` sinh ra mảng sửa được — hai bên không gán cho nhau được. Schema zod
 * ở trên vẫn dùng để frontend kiểm dữ liệu tại biên.
 */
export interface SignboardPhase {
  readonly phaseCode: string;
  readonly label: string | null;
  readonly subtaskCount: number;
}

export interface SignboardPhasesResponse {
  readonly epicKey: string;
  readonly phases: readonly SignboardPhase[];
}

/** Ngưỡng banner cảnh báo tiêu đề chưa chuẩn — PRD E-27. */
export const UNPARSED_BANNER_RATIO = 0.3;

/** Cùng một `TaskName` lạ xuất hiện đủ số lần này thì gợi ý thêm cột (E-29). */
export const SUGGEST_COLUMN_MIN_COUNT = 3;

export const UNPARSED_REASON = ['BAD_TITLE_FORMAT', 'UNKNOWN_TASK_TYPE'] as const;
export type UnparsedReason = (typeof UNPARSED_REASON)[number];

export const unparsedSubtaskSchema = z.object({
  issueKey: z.string(),
  summary: z.string(),
  reason: z.enum(UNPARSED_REASON),
  /** Câu tiếng Việt nói rõ sai gì và sửa thế nào (C-9). */
  hint: z.string(),
  /** `TaskName` lạ, chỉ có ở nhóm `UNKNOWN_TASK_TYPE`. */
  rawTaskType: z.string().nullable(),
});

export const unparsedResponseSchema = z.object({
  epicKey: z.string(),
  phaseCode: z.string(),
  items: z.array(unparsedSubtaskSchema),
  /** `TaskName` lạ xuất hiện ≥ 3 lần — gợi ý PM thêm cột mới. */
  suggestedColumns: z.array(z.object({ taskCode: z.string(), count: z.number().int() })),
  totalSubtasks: z.number().int(),
  parseHealthWarning: z.boolean(),
});
export type UnparsedResponse = z.infer<typeof unparsedResponseSchema>;

/** Một Sub-task đã nạp, đủ dữ liệu để dựng ô. */
export interface SignboardSubtask {
  readonly issueKey: string;
  readonly summary: string;
  readonly functionKey: string | null;
  readonly functionName: string | null;
  readonly taskType: string | null;
  readonly parseStatus: string;
  readonly planStart: string | null;
  readonly planEnd: string | null;
  readonly actualStart: string | null;
  readonly actualEnd: string | null;
  readonly statusCategory: 'new' | 'indeterminate' | 'done';
}
