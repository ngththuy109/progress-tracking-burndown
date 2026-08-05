import type {
  DateOnly,
  PhaseRollup,
  PlanShiftRecord,
  SubtaskRecord,
  WorkCalendar,
} from '@app/shared';
import { countWorkdays } from '../calendar/count-workdays.js';

/**
 * Phát hiện mốc kế hoạch bị dịch chuyển — tuyến phòng thủ chính cho **R-11**.
 *
 * VÌ SAO CẦN: hệ thống không dùng baseline, nên đường Kế hoạch tự trôi theo dữ
 * liệu Jira. Thêm một Sub-task có `wbs_end_date` muộn hơn là `plan_end` lùi ra
 * xa, và **biểu đồ vẫn trông bình thường** — độ trễ bị hấp thụ âm thầm.
 *
 * Bỏ qua việc ghi lịch sử này là bỏ mất cách duy nhất để phát hiện dự án đang
 * trễ, tức là bỏ đúng thứ mà cả hệ thống sinh ra để chống.
 */
export function detectPlanShift(
  previous: PhaseRollup | null,
  next: PhaseRollup,
  subtasks: readonly SubtaskRecord[],
  calendar: WorkCalendar,
): PlanShiftRecord[] {
  // Lần tính đầu tiên không có gì để so. Coi mọi mốc là "vừa bị dịch" sẽ sinh
  // một loạt bản ghi giả ngay lần chạy đầu và làm cảnh báo mất tin cậy.
  if (previous === null) return [];

  const records: PlanShiftRecord[] = [];

  if (previous.planStart !== next.planStart) {
    records.push({
      phaseCode: next.phaseCode,
      shiftType: 'START_MOVED',
      fromDate: previous.planStart,
      toDate: next.planStart,
      shiftedWorkdays: signedWorkdayDelta(previous.planStart, next.planStart, calendar),
      causedByKeys: subtasksMatching(subtasks, next.phaseCode, 'start', next.planStart),
    });
  }

  if (previous.planEnd !== next.planEnd) {
    records.push({
      phaseCode: next.phaseCode,
      shiftType: 'END_MOVED',
      fromDate: previous.planEnd,
      toDate: next.planEnd,
      shiftedWorkdays: signedWorkdayDelta(previous.planEnd, next.planEnd, calendar),
      causedByKeys: subtasksMatching(subtasks, next.phaseCode, 'end', next.planEnd),
    });
  }

  return records;
}

/**
 * Số ngày làm việc dịch chuyển, CÓ DẤU.
 *
 * Dương = lùi ra xa (xấu). Âm = kéo sớm lên.
 *
 * Đếm theo ngày LÀM VIỆC chứ không phải ngày lịch: lùi từ thứ Sáu sang thứ Hai
 * là **1 ngày làm việc**, không phải 3. Đếm theo ngày lịch sẽ thổi phồng mọi
 * lần dịch qua cuối tuần và làm ngưỡng cảnh báo 20% (R-11) kêu sai.
 */
function signedWorkdayDelta(
  from: DateOnly | null,
  to: DateOnly | null,
  calendar: WorkCalendar,
): number {
  // Từ "chưa có mốc" thành "có mốc" (hoặc ngược lại) không đo được bằng số ngày.
  // Trả 0 và để `fromDate`/`toDate` nói lên chuyện gì đã xảy ra.
  if (from === null || to === null) return 0;
  if (from === to) return 0;

  // `countWorkdays` bao gồm cả hai đầu, nên trừ 1 để ra khoảng cách.
  return to > from
    ? countWorkdays(from, to, calendar) - 1
    : -(countWorkdays(to, from, calendar) - 1);
}

/**
 * Sub-task nào đang giữ đúng mốc mới — tức là thủ phạm đẩy mốc đi.
 *
 * Có thể nhiều Sub-task cùng có ngày đó; trả về tất cả thay vì đoán lấy một cái.
 */
function subtasksMatching(
  subtasks: readonly SubtaskRecord[],
  phaseCode: string,
  which: 'start' | 'end',
  target: DateOnly | null,
): string[] {
  if (target === null) return [];
  return subtasks
    .filter(
      (s) =>
        s.removedAtMs === null &&
        s.phaseCode === phaseCode &&
        (which === 'start' ? s.wbsStartDate : s.wbsEndDate) === target,
    )
    .map((s) => s.key)
    .sort();
}

/**
 * Tổng mức dịch chuyển của một Phase so với độ dài kế hoạch — ngưỡng R-11.
 *
 * PRD §10.4: tổng số ngày lùi > 20% độ dài Phase là cảnh báo mức P2.
 */
export const PLAN_SHIFT_WARN_RATIO = 0.2;

export function planShiftLevel(
  totalShiftedWorkdays: number,
  planWorkdays: number | null,
): 'OK' | 'WARN' | 'CRITICAL' {
  if (planWorkdays === null || planWorkdays <= 0) return 'OK';
  const ratio = totalShiftedWorkdays / planWorkdays;
  if (ratio > PLAN_SHIFT_WARN_RATIO * 2) return 'CRITICAL';
  if (ratio > PLAN_SHIFT_WARN_RATIO) return 'WARN';
  return 'OK';
}
