import type { DateOnly } from './calendar.js';
import type { ShiftType } from './enums.js';

/**
 * Ngày plan/actual của một Phase, tổng hợp từ Sub-task — PRD §2.7.
 *
 * TÍNH LẠI SAU MỖI LẦN ĐỒNG BỘ, KHÔNG ĐÓNG BĂNG. Hệ thống không dùng baseline
 * (PRD §4.3), nên thêm một Sub-task có `wbs_end_date` muộn hơn sẽ đẩy `planEnd`
 * ra xa và làm đường Kế hoạch dịch chuyển.
 *
 * Đó chính là lý do `PlanShiftRecord` tồn tại: kế hoạch tự trôi thì độ trễ bị
 * hấp thụ âm thầm, nhìn biểu đồ vẫn thấy bình thường (rủi ro R-11).
 */
export interface PhaseRollup {
  readonly phaseCode: string;

  /** MIN(`wbs_start_date`) của Sub-task đang hoạt động. `null` = mọi Sub-task đều thiếu ngày. */
  readonly planStart: DateOnly | null;
  readonly planEnd: DateOnly | null;
  /** Số ngày làm việc từ `planStart` tới `planEnd`. `null` khi thiếu mốc. */
  readonly planWorkdays: number | null;

  readonly actualStart: DateOnly | null;
  readonly actualEnd: DateOnly | null;
  /** `true` khi CÒN BẤT KỲ Sub-task nào chưa Done. */
  readonly actualEndIsProvisional: boolean;

  readonly totalOriginalS: number;
  readonly subtaskCount: number;
  /** Số Sub-task thiếu `wbs_start_date` HOẶC `wbs_end_date` — rủi ro R-08. */
  readonly missingDateCount: number;

  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

/** Một lần mốc kế hoạch bị dịch chuyển — tuyến phòng thủ chính cho R-11. */
export interface PlanShiftRecord {
  readonly phaseCode: string;
  readonly shiftType: ShiftType;
  readonly fromDate: DateOnly | null;
  readonly toDate: DateOnly | null;
  /**
   * Số ngày LÀM VIỆC bị dịch. Dương = lùi ra xa (xấu), âm = kéo sớm lên.
   *
   * Đếm theo ngày làm việc chứ không phải ngày lịch: lùi từ thứ Sáu sang thứ Hai
   * là **1 ngày làm việc**, không phải 3.
   */
  readonly shiftedWorkdays: number;
  /** Sub-task nào gây ra thay đổi này. */
  readonly causedByKeys: readonly string[];
}
