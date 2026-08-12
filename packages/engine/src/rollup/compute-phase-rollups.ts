import type { PhaseRollup, StatusIdMap, SubtaskRecord, WorkCalendar } from '@app/shared';
import { reduceGroupDates } from './reduce-group-dates.js';

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
 *
 * Phần gộp mốc/tổng nằm ở `reduceGroupDates` (dùng chung với `computeGroupRollups`
 * N tầng). Ở đây chỉ còn: nhóm theo `phaseCode` + dựng câu cảnh báo tầng Phase.
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
    const reduced = reduceGroupDates(
      list,
      calendar,
      statusIdMap,
      asOfMs,
      (planStart, planEnd) =>
        `Phase ${phaseCode}: ngày bắt đầu kế hoạch (${planStart}) muộn hơn ngày kết thúc ` +
        `(${planEnd}). Nhiều khả năng có Sub-task điền nhầm wbs_*. ` +
        `Tạm coi Phase dài 1 ngày; hãy sửa trên Jira.`,
    );
    out.push({ phaseCode, ...reduced });
  }

  // Thứ tự ổn định để so hai lần chạy có giống nhau không (C-6).
  return out.sort((a, b) => a.phaseCode.localeCompare(b.phaseCode));
}
