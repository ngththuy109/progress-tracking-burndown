import type {
  DateOnly,
  PhaseRollup,
  StatusIdMap,
  SubtaskRecord,
  WorkCalendar,
} from '@app/shared';
import { countWorkdays } from '../calendar/count-workdays.js';
import { resolveStatusCategoryAt } from '../status/resolve-status-category.js';
import { minDate, maxDate } from '../signboard/merge-cell.js';
import { resolveSubtaskActualDates } from './subtask-actual-dates.js';

/**
 * Tổng hợp ngày của từng Phase từ Sub-task — PRD §2.7.1.
 *
 *   Phase.plan_start   = MIN( wbs_start_date )
 *   Phase.plan_end     = MAX( wbs_end_date   )
 *   Phase.actual_start = MIN( actual_start   )
 *   Phase.actual_end   = MAX( actual_end     )
 *
 * TÍNH LẠI SAU MỖI LẦN ĐỒNG BỘ, không đóng băng.
 *
 * ⚠ Sub-task chuyển sang Phase khác thì phải gọi lại cho **CẢ HAI** Phase
 * (E-24). Hàm này chỉ tính trên danh sách được truyền vào; chỗ gọi (T-18) chịu
 * trách nhiệm truyền đủ. Chỉ tính lại Phase mới sẽ để Phase cũ giữ nguyên số
 * liệu của một Sub-task không còn thuộc về nó.
 */

/** Mốc dùng để hỏi "Sub-task này đã Done chưa" — cuối thời gian. */
const NOW_SENTINEL = 8_640_000_000_000_000;

export interface ComputeRollupArgs {
  readonly subtasks: readonly SubtaskRecord[];
  readonly calendar: WorkCalendar;
  readonly statusIdMap: StatusIdMap;
  /**
   * Mốc "hiện tại" để xét Sub-task đã Done chưa, tính bằng mili-giây UTC.
   *
   * Nhận qua tham số chứ không đọc đồng hồ (C-12). Bỏ trống nghĩa là "tính theo
   * toàn bộ lịch sử đã có".
   */
  readonly asOfMs?: number;
}

export function computePhaseRollups(args: ComputeRollupArgs): PhaseRollup[] {
  const { subtasks, calendar, statusIdMap } = args;
  const asOfMs = args.asOfMs ?? NOW_SENTINEL;

  // Nhóm theo `phaseCode` của TASK CHA, không theo `[Phase]` trong tiêu đề
  // Sub-task (PRD §2.9.2 — quyết định đã chốt).
  const byPhase = new Map<string, SubtaskRecord[]>();
  for (const s of subtasks) {
    // Sub-task đã bị gỡ khỏi Epic không tham gia tính toán nữa. Dòng vẫn còn
    // trong DB để snapshot của những ngày trước đó nhìn thấy được.
    if (s.removedAtMs !== null) continue;
    const list = byPhase.get(s.phaseCode);
    if (list) list.push(s);
    else byPhase.set(s.phaseCode, [s]);
  }

  const out: PhaseRollup[] = [];

  for (const [phaseCode, list] of byPhase) {
    const warnings: { code: string; message: string }[] = [];

    const planStarts: (DateOnly | null)[] = [];
    const planEnds: (DateOnly | null)[] = [];
    const actualStarts: (DateOnly | null)[] = [];
    const actualEnds: (DateOnly | null)[] = [];

    let totalOriginalS = 0;
    let missingDateCount = 0;
    let anyUnfinished = false;

    for (const s of list) {
      // Sub-task `UNPARSED` VẪN được cộng đầy đủ (C-11) — công việc là thật,
      // chỉ có tiêu đề là đặt sai.
      totalOriginalS += s.originalEstimateSeconds;

      planStarts.push(s.wbsStartDate);
      planEnds.push(s.wbsEndDate);
      // Thiếu MỘT trong hai ngày đã là không so sánh được sớm/trễ (E-30).
      if (s.wbsStartDate === null || s.wbsEndDate === null) missingDateCount += 1;

      const actual = resolveSubtaskActualDates(s, statusIdMap, calendar.timezone);
      actualStarts.push(actual.actualStart);
      actualEnds.push(actual.actualEnd);

      if (resolveStatusCategoryAt(s.changelog, statusIdMap, asOfMs) !== 'done') {
        anyUnfinished = true;
      }
    }

    const planStart = minDate(planStarts);
    let planEnd = maxDate(planEnds);

    // Dữ liệu Jira sai: ai đó điền ngày bắt đầu muộn hơn ngày kết thúc. Không
    // đảo ngầm hai mốc — đảo sẽ giấu mất lỗi dữ liệu. Co Phase về 1 ngày và nói
    // rõ ra (C-9, C-10).
    if (planStart !== null && planEnd !== null && planStart > planEnd) {
      warnings.push({
        code: 'INVALID_PHASE_PERIOD',
        message:
          `Phase ${phaseCode}: ngày bắt đầu kế hoạch (${planStart}) muộn hơn ngày kết thúc ` +
          `(${planEnd}). Nhiều khả năng có Sub-task điền nhầm wbs_*. ` +
          `Tạm coi Phase dài 1 ngày; hãy sửa trên Jira.`,
      });
      planEnd = planStart;
    }

    const planWorkdays =
      planStart === null || planEnd === null ? null : countWorkdays(planStart, planEnd, calendar);

    out.push({
      phaseCode,
      planStart,
      planEnd,
      planWorkdays,
      actualStart: minDate(actualStarts),
      actualEnd: maxDate(actualEnds),
      // "BẤT KỲ Sub-task nào chưa Done", không phải "Sub-task kết thúc muộn nhất
      // chưa Done". Nhầm chỗ này cho ra `false` sai khi có task xong sớm nhưng
      // còn cái khác đang dở.
      actualEndIsProvisional: anyUnfinished,
      totalOriginalS,
      subtaskCount: list.length,
      missingDateCount,
      warnings,
    });
  }

  // Thứ tự ổn định để so hai lần chạy có giống nhau không (C-6).
  return out.sort((a, b) => a.phaseCode.localeCompare(b.phaseCode));
}
