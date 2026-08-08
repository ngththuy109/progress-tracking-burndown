/**
 * Kết quả phân tách tiêu đề Sub-task — PRD §2.9.
 *
 * Để ở `shared` vì ba nơi cùng dùng một hình dạng: engine sinh ra, db lưu xuống
 * `jira_issue`, web hiện khu "Chưa lên bảng".
 */
import type { SbParseStatus } from './enums.js';

/**
 * Mã cảnh báo của riêng bước phân tách Sub-task.
 *
 * `PHASE_MISMATCH` lấy đúng mã trong danh sách dùng chung `WARNING_CODE` (C-9).
 * Ba mã còn lại nói về **cấu hình sai**, không phải dữ liệu Jira sai, và chỉ có
 * nghĩa trong phạm vi bước này nên để riêng ở đây.
 */
export const SUBTASK_PARSE_WARNING_CODE = [
  'PHASE_MISMATCH',
  'NO_SUBTASK_PATTERN',
  'SUBTASK_PATTERN_INVALID',
  'AMBIGUOUS_TASK_COLUMN',
] as const;
export type SubtaskParseWarningCode = (typeof SUBTASK_PARSE_WARNING_CODE)[number];

export interface SubtaskParseWarning {
  readonly code: SubtaskParseWarningCode;
  readonly message: string;
}

export interface SubtaskParseResult {
  /**
   * Phase dùng THẬT cho Sub-task này — luôn bằng Phase của Task cha (PRD §2.9.2).
   *
   * Có mặt ở đây để chỗ gọi chỉ cần đọc một trường duy nhất. Đừng bao giờ lấy
   * `sbPhaseRaw` thay cho trường này: cây Jira là cấu trúc thật, tiêu đề chỉ là
   * chữ, và lấy nhầm sẽ khiến số cộng dồn lệch khỏi cây Jira mà không báo lỗi.
   */
  readonly phaseCode: string;

  readonly sbProject: string | null;
  readonly sbTeam: string | null;
  /** `[Phase]` bóc từ TIÊU ĐỀ. CHỈ để đối chiếu, không dùng để phân loại. */
  readonly sbPhaseRaw: string | null;

  /** Dạng hiển thị của Function, giữ nguyên hoa/thường. */
  readonly functionName: string | null;
  /** Khoá gộp hàng Signboard: NFKC + lowercase (PRD E-31). */
  readonly functionKey: string | null;
  /** `null` khi `TaskName` không khớp cột nào — KHÔNG tự tạo cột mới (C-10). */
  readonly taskType: string | null;
  /**
   * `TaskName` THÔ bóc từ tiêu đề, TRƯỚC khi khớp cột. Giữ lại kể cả khi
   * `taskType` là `null` — chính là thứ để màn hình gợi ý cột mới (E-29).
   */
  readonly sbTaskRaw: string | null;

  readonly sbParseStatus: SbParseStatus;
  /** Mẫu nào đã khớp — màn hình Xem thử hiển thị cột này. */
  readonly matchedPattern: string | null;
  readonly warnings: readonly SubtaskParseWarning[];
}
