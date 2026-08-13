import type { DateOnly, PlannedSubtaskItem, StatusIdMap, SubtaskRecord, WorkCalendar } from '@app/shared';
import { countWorkdays } from '../calendar/count-workdays.js';
import { resolveStatusCategoryAt } from '../status/resolve-status-category.js';
import { minDate, maxDate } from '../signboard/merge-cell.js';
import { resolveSubtaskActualDates } from './subtask-actual-dates.js';

/**
 * Gộp MỘT danh sách lá thành mốc plan/actual + tổng — phần dùng chung giữa
 * `computePhaseRollups` (một tầng Phase) và `computeGroupRollups` (mọi nút prefix
 * N tầng — DYNAMIC-TIERS-DESIGN.md §5).
 *
 * Tách ra để hai nơi KHÔNG lệch cách tính: MIN/MAX ngày, đếm thiếu ngày, cờ "còn
 * việc chưa Done", và kẹp khoảng ngày âm về 1 ngày. Câu chữ cảnh báo
 * `INVALID_PHASE_PERIOD` do NGƯỜI GỌI dựng (`formatInvalidPeriod`) — nhờ vậy tầng
 * Phase giữ NGUYÊN VĂN thông điệp cũ (20 golden dataset không đổi), còn nút nhóm
 * có câu chữ riêng.
 *
 * THUẦN: không đọc đồng hồ (nhận `asOfMs`), không chạm db/jira (C-12).
 */

/** Kết quả gộp — mọi trường của `PhaseRollup`/`GroupRollup` TRỪ khoá nhóm. */
export interface ReducedGroupDates {
  readonly planStart: DateOnly | null;
  readonly planEnd: DateOnly | null;
  readonly planWorkdays: number | null;
  readonly actualStart: DateOnly | null;
  readonly actualEnd: DateOnly | null;
  readonly actualEndIsProvisional: boolean;
  readonly totalOriginalS: number;
  readonly subtaskCount: number;
  readonly missingDateCount: number;
  /**
   * Lịch ramp theo TỪNG lá đủ hai ngày — đường Kế hoạch per-Sub-task (main). Lá
   * thiếu ngày KHÔNG nằm ở đây. Dùng chung cho `PhaseRollup` và `GroupRollup` nên
   * đường Kế hoạch của mọi tầng (kể cả N tầng) tính cùng một cách.
   */
  readonly plannedItems: readonly PlannedSubtaskItem[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export function reduceGroupDates(
  list: readonly SubtaskRecord[],
  calendar: WorkCalendar,
  statusIdMap: StatusIdMap,
  asOfMs: number,
  /** Dựng câu cảnh báo INVALID_PHASE_PERIOD cho đúng loại nút (Phase / nhóm). */
  formatInvalidPeriod: (planStart: DateOnly, planEnd: DateOnly) => string,
): ReducedGroupDates {
  const warnings: { code: string; message: string }[] = [];

  const planStarts: (DateOnly | null)[] = [];
  const planEnds: (DateOnly | null)[] = [];
  const actualStarts: (DateOnly | null)[] = [];
  const actualEnds: (DateOnly | null)[] = [];

  const plannedItems: PlannedSubtaskItem[] = [];
  let totalOriginalS = 0;
  let missingDateCount = 0;
  let anyUnfinished = false;

  for (const s of list) {
    // Lá `UNPARSED` VẪN được cộng đầy đủ (C-11) — công việc là thật, chỉ tiêu đề sai.
    totalOriginalS += s.originalEstimateSeconds;

    planStarts.push(s.wbsStartDate);
    planEnds.push(s.wbsEndDate);
    // Thiếu MỘT trong hai ngày đã là không so sánh được sớm/trễ (E-30).
    if (s.wbsStartDate === null || s.wbsEndDate === null) {
      missingDateCount += 1;
    } else {
      // Đủ hai ngày → đưa vào lịch ramp per-Sub-task. Ngày đảo (start > end) cho
      // countWorkdays = 0 → planWorkdays 0 → thành sàn (không đốt), KHÔNG crash;
      // cảnh báo INVALID_PHASE_PERIOD cấp nút vẫn nổ ở dưới.
      plannedItems.push({
        wbsStartDate: s.wbsStartDate,
        wbsEndDate: s.wbsEndDate,
        originalS: s.originalEstimateSeconds,
        planWorkdays: countWorkdays(s.wbsStartDate, s.wbsEndDate, calendar),
      });
    }

    const actual = resolveSubtaskActualDates(s, statusIdMap, calendar.timezone);
    actualStarts.push(actual.actualStart);
    actualEnds.push(actual.actualEnd);

    if (resolveStatusCategoryAt(s.changelog, statusIdMap, asOfMs) !== 'done') {
      anyUnfinished = true;
    }
  }

  const planStart = minDate(planStarts);
  let planEnd = maxDate(planEnds);

  // Dữ liệu Jira sai: ai đó điền ngày bắt đầu muộn hơn ngày kết thúc. Không đảo
  // ngầm hai mốc — đảo sẽ giấu mất lỗi dữ liệu. Co về 1 ngày và nói rõ (C-9, C-10).
  if (planStart !== null && planEnd !== null && planStart > planEnd) {
    warnings.push({ code: 'INVALID_PHASE_PERIOD', message: formatInvalidPeriod(planStart, planEnd) });
    planEnd = planStart;
  }

  const planWorkdays =
    planStart === null || planEnd === null ? null : countWorkdays(planStart, planEnd, calendar);

  return {
    planStart,
    planEnd,
    planWorkdays,
    actualStart: minDate(actualStarts),
    actualEnd: maxDate(actualEnds),
    // "BẤT KỲ lá nào chưa Done", không phải "lá kết thúc muộn nhất chưa Done".
    actualEndIsProvisional: anyUnfinished,
    totalOriginalS,
    subtaskCount: list.length,
    missingDateCount,
    plannedItems,
    warnings,
  };
}
