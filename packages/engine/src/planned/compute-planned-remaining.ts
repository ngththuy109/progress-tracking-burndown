import type { DateOnly, PhaseRollup, WorkCalendar } from '@app/shared';
import { countWorkdays } from '../calendar/count-workdays.js';

/**
 * Đường Kế hoạch — ramp tuyến tính theo TỪNG Sub-task.
 *
 *   PlannedRemaining(T_d) = TotalScope(now)
 *                         − Σ_subtask min( OE_i(now) / SubtaskWorkdays_i(now) × DaysElapsed_i(T_d),
 *                                          OE_i(now) )
 *
 * Mỗi Sub-task (đủ hai ngày `wbs_*`) tự rải đều khối lượng của CHÍNH NÓ trên cửa
 * sổ `wbs_start_date → wbs_end_date` của chính nó; đường của Phase/Epic là TỔNG
 * các ramp đó (lịch nằm ở `PhaseRollup.plannedItems`). Đây là điểm khác cốt lõi
 * so với bản cũ rải đều theo Phase — cửa sổ gộp MIN/MAX làm mất lịch từng Sub-task.
 *
 * Sub-task THIẾU một trong hai ngày KHÔNG nằm trong `plannedItems` → khối lượng
 * của nó không bao giờ bị trừ, thành "sàn" cố định. Đường Kế hoạch chỉ chạm 0 khi
 * MỌI Sub-task đang hoạt động đều đủ ngày (C-10: không đoán ngày thay người dùng).
 *
 * `(now)` nhấn mạnh: mọi giá trị lấy tại **thời điểm chạy job**, không phải tại
 * `T_d`. Hệ quả: đường Kế hoạch được **vẽ lại toàn bộ** sau mỗi lần đồng bộ, kể
 * cả phần lịch sử. Điểm ngày 05/03 hôm nay có thể khác hôm qua.
 *
 * ĐÓ LÀ THIẾT KẾ, KHÔNG PHẢI LỖI. Hệ thống này không dùng baseline (PRD §1.4:
 * *"Không làm: Baseline"*). Hệ quả được theo dõi ở rủi ro R-11 và bù lại bằng
 * `plan_shift_history` (T-15). Đừng "sửa" thành đóng băng.
 */

export interface PlannedRemainingResult {
  readonly seconds: number;
  /** Phần đáng lẽ đã "cháy" của từng Phase — để API `/explain` giải thích được. */
  readonly burnedByPhase: ReadonlyMap<string, number>;
  /** Phase bị bỏ qua vì thiếu dữ liệu kế hoạch, kèm lý do. */
  readonly skippedPhases: readonly { readonly phaseCode: string; readonly reason: string }[];
}

export function computePlannedRemaining(
  phaseRollups: readonly PhaseRollup[],
  totalScopeSeconds: number,
  dateStr: DateOnly,
  calendar: WorkCalendar,
): PlannedRemainingResult {
  const burnedByPhase = new Map<string, number>();
  const skippedPhases: { phaseCode: string; reason: string }[] = [];
  let burned = 0;

  for (const phase of phaseRollups) {
    let schedulable = 0; // số Sub-task ramp được (đủ ngày & cửa sổ có ngày làm việc)
    let phaseBurned = 0;

    for (const item of phase.plannedItems) {
      // Cửa sổ không có ngày làm việc nào (rơi trọn cuối tuần/lễ, hoặc ngày đảo
      // start > end) → không chia được, để nguyên làm sàn. Đồng thời chặn luôn
      // `Infinity` do chia cho 0 — lỗi này TRÔNG hợp lý nên rất dễ lọt.
      if (item.planWorkdays <= 0) continue;
      schedulable += 1;

      // HAI CHẶN NGẮN O(1) giữ `countWorkdays` ra khỏi vòng nóng — chỉ gọi khi
      // đang Ở GIỮA cửa sổ. So sánh chuỗi ISO 'YYYY-MM-DD' = so sánh thời gian.
      if (dateStr < item.wbsStartDate) continue; // chưa tới ngày bắt đầu → cháy 0
      if (dateStr >= item.wbsEndDate) {
        // Đã qua (hoặc đúng) ngày kết thúc → cháy TRỌN khối lượng. `countWorkdays`
        // tính cả hai đầu nên tại đúng `wbsEndDate` cũng ra trọn; chặn sớm ở đây
        // vừa nhanh hơn vừa khỏi phụ thuộc phép `min` bên dưới.
        phaseBurned += item.originalS;
        continue;
      }

      const elapsed = countWorkdays(item.wbsStartDate, dateStr, calendar);
      if (elapsed <= 0) continue; // `wbsStart` rơi vào ngày nghỉ, chưa cháy gì
      const perDay = item.originalS / item.planWorkdays;
      // `min` chặn một Sub-task "cháy" quá khối lượng của chính nó (đề phòng lệch).
      phaseBurned += Math.min(perDay * elapsed, item.originalS);
    }

    // Không có Sub-task nào ramp được → Phase thiếu kế hoạch, KHÔNG vẽ (C-10).
    // Giữ nguyên hệ quả cũ: tầng gọi thấy `skippedPhases` → đường Phase = null.
    if (schedulable === 0) {
      skippedPhases.push({
        phaseCode: phase.phaseCode,
        reason:
          'No Sub-task has both planned dates with valid workdays — every ' +
          'Sub-task is missing wbs_start_date/wbs_end_date or falls entirely on days off.',
      });
      continue;
    }

    // Chỉ ghi vào `burnedByPhase` khi ĐÃ cháy — Phase chưa tới ngày bắt đầu vắng
    // mặt khỏi map (giữ nguyên ngữ nghĩa cũ mà `/explain` dựa vào).
    if (phaseBurned > 0) burnedByPhase.set(phase.phaseCode, phaseBurned);
    burned += phaseBurned;
  }

  return {
    // Giữ nguyên số thực, KHÔNG làm tròn ở đây. Làm tròn sớm rồi cộng dồn nhiều
    // Sub-task sẽ tích lũy sai số và golden dataset sẽ lệch vài giây (C-2).
    seconds: Math.max(0, totalScopeSeconds - burned),
    burnedByPhase,
    skippedPhases,
  };
}
