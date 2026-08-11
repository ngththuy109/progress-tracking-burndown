import type {
  DateOnly,
  PlanConflict,
  PlanConflictViolation,
  PlanConflictsResponse,
  WorkCalendar,
  WorkSide,
} from '@app/shared';
import { isWorkday } from '@app/engine';

/**
 * Kiểm tra plan rơi vào ngày nghỉ — T-37, HÀM THUẦN.
 *
 * Bối cảnh nghiệp vụ: mỗi task do người VN làm và người JP (khách hàng) review.
 * Cột Signboard mang cờ `side` cho biết loại task thuộc phía nào; Sub-task đã
 * lưu sẵn `task_type` khớp với cột. Từ đó ngày kế hoạch của từng Sub-task được
 * kiểm tra với lịch nghỉ của ĐÚNG phía làm nó.
 *
 * CHỈ soi ngày BẮT ĐẦU và ngày KẾT THÚC. Khoảng plan vắt qua ngày nghỉ là bình
 * thường — đường Kế hoạch đã tự loại các ngày đó khi chia (T-16). Vi phạm là
 * khi chính mốc start/end rơi trúng ngày không làm việc: không ai bắt đầu hay
 * kết thúc công việc vào ngày cả phía đó nghỉ.
 *
 * Chọn lịch theo phía:
 *   - VN (người làm)  → lịch THỰC THI của chính Epic (thường là VN_STANDARD).
 *   - JP (review)      → lịch chuẩn phía khách hàng (JP_STANDARD).
 * Sub-task không tra được phía (taskType null, hoặc cột đã bị xoá khỏi cấu
 * hình) được kiểm theo lịch VN và gắn `sideResolved: false` — nói rõ ra thay vì
 * bỏ qua trong im lặng (C-10).
 */

export interface PlanCheckSubtask {
  readonly issueKey: string;
  readonly summary: string;
  readonly parentKey: string | null;
  /** Phase của TASK CHA — nguồn phân loại chính thức (PRD §2.9.2). */
  readonly phaseCode: string | null;
  readonly taskType: string | null;
  readonly wbsStartDate: DateOnly | null;
  readonly wbsEndDate: DateOnly | null;
}

/** Lịch của một phía, kèm nhãn ngày lễ để thông báo nói được "đó là Tết". */
export interface SideCalendar {
  readonly calendar: WorkCalendar;
  readonly holidayLabels: ReadonlyMap<string, string | null>;
}

export interface ComputePlanConflictsArgs {
  readonly epicKey: string;
  readonly subtasks: readonly PlanCheckSubtask[];
  /** `task_code` cột Signboard → phía làm, từ cấu hình đang hiệu lực. */
  readonly columnSides: ReadonlyMap<string, WorkSide>;
  readonly calendars: Readonly<Record<WorkSide, SideCalendar>>;
}

export function computePlanConflicts(args: ComputePlanConflictsArgs): PlanConflictsResponse {
  const conflicts: PlanConflict[] = [];
  let sideUnknownCount = 0;
  const bySide = { VN: 0, JP: 0 };

  for (const s of args.subtasks) {
    // Không có ngày kế hoạch nào thì không có gì để kiểm — Sub-task đó đã nằm
    // trong báo cáo "thiếu ngày kế hoạch" (R-08), không đếm hai lần.
    if (s.wbsStartDate === null && s.wbsEndDate === null) continue;

    const resolved = s.taskType !== null ? args.columnSides.get(s.taskType) : undefined;
    const side: WorkSide = resolved ?? 'VN';
    const sideResolved = resolved !== undefined;

    const violations: PlanConflictViolation[] = [];
    const check = (field: 'START' | 'END', date: DateOnly | null): void => {
      if (date === null) return;
      const { calendar, holidayLabels } = args.calendars[side];
      if (isWorkday(date, calendar)) return;
      violations.push({
        field,
        date,
        reason: calendar.holidays.has(date) ? 'HOLIDAY' : 'WEEKEND',
        holidayLabel: holidayLabels.get(date) ?? null,
      });
    };
    check('START', s.wbsStartDate);
    check('END', s.wbsEndDate);

    if (violations.length === 0) continue;

    if (!sideResolved) sideUnknownCount += 1;
    bySide[side] += 1;
    conflicts.push({
      issueKey: s.issueKey,
      summary: s.summary,
      parentKey: s.parentKey,
      phaseCode: s.phaseCode,
      taskType: s.taskType,
      side,
      sideResolved,
      violations,
    });
  }

  // Thứ tự ổn định để hai lần gọi cho kết quả giống nhau (C-6).
  conflicts.sort((a, b) => a.issueKey.localeCompare(b.issueKey));

  return {
    epicKey: args.epicKey,
    summary: { total: conflicts.length, bySide, sideUnknownCount },
    conflicts,
  };
}
