import { z } from 'zod';
import { SIGNBOARD_STATUS } from './enums.js';
import type { SignboardCell, SignboardPic } from './signboard.js';

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
  /**
   * Khoá nhóm Sub-phase mà cột LÁ này thuộc về (NFKC + chữ thường).
   *
   * Cùng một loại task lặp lại một lần dưới MỖI Sub-phase, nên `taskCode` không
   * còn là khoá duy nhất — cần kèm `subPhaseKey` để xác định đúng cột. `''` là
   * nhóm dự phòng cho Sub-task không có `[Sub-phase]` trong tiêu đề.
   */
  subPhaseKey: z.string(),
});

/**
 * Một nhóm cột theo Sub-phase — tầng header TRÊN của bảng (PRD §6.1).
 *
 * `[Sub-phase]` là cặp ngoặc vuông NGAY TRƯỚC Function trong tiêu đề Sub-task
 * (PRD §2.9.1). Một Phase có thể chứa nhiều Sub-phase; mỗi Sub-phase thành một
 * nhóm cột, xếp tuần tự trái→phải theo `display_order` của cấu hình Phase.
 */
export const signboardColumnGroupSchema = z.object({
  subPhaseKey: z.string(),
  /** Nhãn hiển thị: nhãn Phase khớp trong cấu hình, nếu không thì chữ gốc. */
  subPhaseLabel: z.string(),
  /** Các loại task trong nhóm — cùng bộ cột cấu hình, cùng thứ tự cho mọi nhóm. */
  taskColumns: z.array(z.object({ taskCode: z.string(), label: z.string() })),
});

/**
 * Một người phụ trách (PIC) của Function — gom từ "Request participants".
 *
 * `displayName` là `null` khi field Jira chỉ có accountId và chưa tra được tên.
 */
export const signboardPicSchema = z.object({
  accountId: z.string(),
  displayName: z.string().nullable(),
});

export const signboardRowSchema = z.object({
  /** Khoá gộp hàng: NFKC + chữ thường (E-31). */
  functionKey: z.string(),
  /** Dạng hiển thị — lấy theo lần gặp ĐẦU TIÊN. */
  functionName: z.string(),
  /**
   * Cột "PIC": gom "Request participants" của MỌI Sub-task thuộc Function này,
   * bỏ trùng theo `accountId`, sắp theo tên. Rỗng khi chưa cấu hình field hoặc
   * không Sub-task nào có người tham gia.
   *
   * `.default([])` để web MỚI vẫn đọc được phản hồi từ API CŨ (chưa có `pics`)
   * trong lúc deploy — khi đó cột PIC rỗng thay vì cả bảng gãy validate.
   */
  pics: z.array(signboardPicSchema).default([]),
  /** Cùng thứ tự (và cùng độ dài) với `columns` — mảng cột LÁ đã làm phẳng. */
  cells: z.array(signboardCellSchema),
  /** Ô "Σ" của mỗi nhóm Sub-phase — cùng thứ tự với `columnGroups`. */
  subtotals: z.array(signboardCellSchema),
  /** Ô "Tổng" của hàng: trạng thái xấu nhất trong các ô có mặt (mọi Sub-phase). */
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
  /** Nhóm cột theo Sub-phase, xếp trái→phải — tầng header trên (PRD §6.1). */
  columnGroups: z.array(signboardColumnGroupSchema),
  /** Cột LÁ đã làm phẳng theo thứ tự nhóm; 1:1 với `cells` của mỗi hàng. */
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
export interface SignboardColumnGroup {
  readonly subPhaseKey: string;
  readonly subPhaseLabel: string;
  readonly taskColumns: readonly { readonly taskCode: string; readonly label: string }[];
}

export interface SignboardRow {
  readonly functionKey: string;
  readonly functionName: string;
  /** Cột "PIC" — gom "Request participants" của cả Function, bỏ trùng, sắp theo tên. */
  readonly pics: readonly SignboardPic[];
  /** 1:1 với `columns` (mảng cột lá đã làm phẳng). */
  readonly cells: readonly SignboardCell[];
  /** 1:1 với `columnGroups` — ô "Σ" mỗi Sub-phase. */
  readonly subtotals: readonly SignboardCell[];
  readonly total: SignboardCell;
}

export interface SignboardResponse {
  readonly epicKey: string;
  readonly phaseCode: string;
  readonly asOfDate: string;
  readonly columnGroups: readonly SignboardColumnGroup[];
  readonly columns: readonly {
    readonly taskCode: string;
    readonly label: string;
    readonly subPhaseKey: string;
  }[];
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

/**
 * Một nhóm ở TẦNG TRÊN CÙNG của cây phân tầng (VD "Giai đoạn" GD1/GD2) — nguồn cho
 * bộ lọc đứng trước bộ chọn Phase. Chỉ đếm lá có `group_path` sâu ≥ 2 (lá 1 tầng
 * không có chiều nhóm nào ngoài Phase).
 */
export const signboardStageSchema = z.object({
  code: z.string(),
  /** Nhãn từ định nghĩa tầng (group_tier_definition); `null` khi chưa khai. */
  label: z.string().nullable(),
  subtaskCount: z.number().int(),
});

export const signboardPhasesResponseSchema = z.object({
  epicKey: z.string(),
  /** Đã sắp theo `display_order` của cấu hình; Phase lạ xếp sau, theo mã. */
  phases: z.array(signboardPhaseSchema),
  /** Nhãn của tầng trên cùng (group_tier.label_vi, VD "Giai đoạn"); `null` khi config 1 tầng. */
  stageTierLabel: z.string().nullable().default(null),
  /** Các nhóm tầng-1 CÓ lá trong Epic. UI chỉ hiện bộ lọc khi ≥ 2 nhóm. */
  stages: z.array(signboardStageSchema).default([]),
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

export interface SignboardStage {
  readonly code: string;
  readonly label: string | null;
  readonly subtaskCount: number;
}

export interface SignboardPhasesResponse {
  readonly epicKey: string;
  readonly phases: readonly SignboardPhase[];
  readonly stageTierLabel: string | null;
  readonly stages: readonly SignboardStage[];
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
  /**
   * `[Sub-phase]` bóc từ tiêu đề — cặp ngoặc NGAY TRƯỚC Function (PRD §2.9.1),
   * lưu thô ở `jira_issue.sb_phase_raw`. Dùng để NHÓM CỘT trên Signboard. `null`
   * khi mẫu tiêu đề không có ô `{phase}` → rơi vào nhóm dự phòng.
   */
  readonly subPhaseRaw: string | null;
  readonly taskType: string | null;
  readonly parseStatus: string;
  readonly planStart: string | null;
  readonly planEnd: string | null;
  readonly actualStart: string | null;
  readonly actualEnd: string | null;
  readonly statusCategory: 'new' | 'indeterminate' | 'done';
  /**
   * "Request participants" của Sub-task này (đã bỏ trùng theo `accountId`).
   * `displayName` là `null` khi field chỉ có accountId và chưa tra được tên.
   * Signboard gom danh sách này theo Function để dựng cột PIC.
   */
  readonly pics: readonly SignboardPic[];
}
