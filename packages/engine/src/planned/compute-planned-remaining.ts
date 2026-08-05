import type { DateOnly, PhaseRollup, WorkCalendar } from '@app/shared';
import { countWorkdays } from '../calendar/count-workdays.js';

/**
 * Đường Kế hoạch — PRD §4.3.1.
 *
 *   PlannedRemaining(T_d) = TotalScope(now)
 *                         − Σ min( OE_i(now) / PlannedWorkdays_i(now) × DaysElapsed_i(T_d),
 *                                  OE_i(now) )
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
    // Phase chưa có ngày kế hoạch → KHÔNG đoán bừa (C-10, PRD §2.7.3).
    if (phase.planStart === null || phase.planEnd === null) {
      skippedPhases.push({
        phaseCode: phase.phaseCode,
        reason: 'Chưa có ngày kế hoạch — mọi Sub-task đều thiếu wbs_start_date/wbs_end_date.',
      });
      continue;
    }

    // Chia cho 0 cho ra `Infinity`, rồi `Math.min(Infinity, OE)` = `OE` — kết
    // quả TRÔNG VẪN HỢP LÝ nên lỗi hoàn toàn im lặng. Phải chặn tường minh.
    if (phase.planWorkdays === null || phase.planWorkdays <= 0) {
      skippedPhases.push({
        phaseCode: phase.phaseCode,
        reason:
          `Khoảng kế hoạch ${phase.planStart} → ${phase.planEnd} không có ngày làm việc nào ` +
          `(rơi trọn vào cuối tuần hoặc ngày lễ).`,
      });
      continue;
    }

    // `countWorkdays` tính CẢ HAI ĐẦU. Phase 5 ngày hỏi đúng ngày cuối phải ra
    // 5, không phải 4 — sai một đơn vị ở đây làm đường Kế hoạch không bao giờ
    // chạm 0.
    const elapsed = countWorkdays(phase.planStart, dateStr, calendar);
    if (elapsed <= 0) continue; // Phase chưa tới ngày bắt đầu

    const perDay = phase.totalOriginalS / phase.planWorkdays;
    // `min` chặn một Phase "cháy" quá khối lượng của chính nó khi đã qua ngày
    // kết thúc.
    const phaseBurned = Math.min(perDay * elapsed, phase.totalOriginalS);

    burnedByPhase.set(phase.phaseCode, phaseBurned);
    burned += phaseBurned;
  }

  return {
    // Giữ nguyên số thực, KHÔNG làm tròn ở đây. Làm tròn sớm rồi cộng dồn nhiều
    // Phase sẽ tích lũy sai số và golden dataset sẽ lệch vài giây (C-2).
    seconds: Math.max(0, totalScopeSeconds - burned),
    burnedByPhase,
    skippedPhases,
  };
}
