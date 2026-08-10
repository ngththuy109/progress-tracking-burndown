import {
  UNCLASSIFIED_PHASE,
  type PhaseSubtaskGroup,
  type PhaseSubtaskResponse,
  type PhaseSubtaskTicket,
  type StatusCategory,
} from '@app/shared';

/**
 * Dựng danh sách Sub-task nhóm theo Phase — HÀM THUẦN.
 *
 * Nhận Phase đã định nghĩa (đã gộp kế thừa) và toàn bộ Sub-task đang hoạt động
 * của Epic, trả về từng nhóm kèm ticket bên trong. Không chạm database, không
 * đọc đồng hồ — nhờ vậy test được mà không cần PostgreSQL và không phụ thuộc
 * "hôm nay là ngày nào".
 */

const SECONDS_PER_HOUR = 3600;

/** Định nghĩa Phase rút gọn, đã gộp kế thừa và sắp theo `displayOrder`. */
export interface PhaseDefinitionLite {
  readonly phaseCode: string;
  readonly label: string;
  readonly colorHex: string | null;
  readonly displayOrder: number;
}

/** Một Sub-task đã nạp, `phaseCode` đã chuẩn hoá (rỗng → `UNCLASSIFIED`). */
export interface LoadedSubtask {
  readonly issueKey: string;
  readonly summary: string;
  readonly parentKey: string | null;
  readonly phaseCode: string;
  readonly statusCategory: StatusCategory;
  readonly planStart: string | null;
  readonly planEnd: string | null;
  /** Từ `subtask_actual_dates`; `null` khi job dựng lại chưa tính cho ticket. */
  readonly actualStart: string | null;
  readonly actualEnd: string | null;
  readonly originalEstimateSeconds: number;
  /** Tổng giờ đã log (worklog) tính bằng GIÂY — `jira_issue.time_spent_s`. */
  readonly timeSpentSeconds: number;
  readonly functionName: string | null;
  readonly taskType: string | null;
}

export interface PhaseSubtaskInput {
  readonly epicKey: string;
  readonly definitions: readonly PhaseDefinitionLite[];
  readonly subtasks: readonly LoadedSubtask[];
}

export function buildPhaseSubtaskList(input: PhaseSubtaskInput): PhaseSubtaskResponse {
  // Gom ticket theo mã Phase trước, rồi mới ghép vào khung Phase — nhờ vậy một
  // Phase đã định nghĩa nhưng chưa có ticket vẫn ra được nhóm rỗng.
  const ticketsByPhase = new Map<string, PhaseSubtaskTicket[]>();
  for (const sub of input.subtasks) {
    const ticket = toTicket(sub);
    const list = ticketsByPhase.get(sub.phaseCode);
    if (list) list.push(ticket);
    else ticketsByPhase.set(sub.phaseCode, [ticket]);
  }
  // Sắp ticket trong mỗi nhóm theo issueKey — thứ tự ỔN ĐỊNH để test không giòn
  // và để danh sách không nhảy chỗ giữa hai lần tải.
  for (const list of ticketsByPhase.values()) {
    list.sort((a, b) => a.issueKey.localeCompare(b.issueKey));
  }

  const groups: PhaseSubtaskGroup[] = [];
  const emitted = new Set<string>();

  // 1) Phase đã định nghĩa, theo displayOrder — KỂ CẢ nhóm rỗng.
  const ordered = [...input.definitions].sort((a, b) => a.displayOrder - b.displayOrder);
  for (const def of ordered) {
    if (emitted.has(def.phaseCode)) continue; // chống định nghĩa trùng mã
    emitted.add(def.phaseCode);
    groups.push(groupOf(def.phaseCode, def.label, def.colorHex, true, ticketsByPhase));
  }

  // 2) Mã Phase có trên Sub-task nhưng không luật nào định nghĩa (kể cả
  //    UNCLASSIFIED) — gom ở cuối, UNCLASSIFIED xuống dưới cùng.
  const extras = [...ticketsByPhase.keys()].filter((code) => !emitted.has(code)).sort(compareExtra);
  for (const code of extras) {
    groups.push(groupOf(code, null, null, false, ticketsByPhase));
  }

  return { epicKey: input.epicKey, groups, totalSubtasks: input.subtasks.length };
}

function groupOf(
  phaseCode: string,
  label: string | null,
  colorHex: string | null,
  isDefined: boolean,
  ticketsByPhase: ReadonlyMap<string, readonly PhaseSubtaskTicket[]>,
): PhaseSubtaskGroup {
  const tickets = ticketsByPhase.get(phaseCode) ?? [];
  return { phaseCode, label, colorHex, isDefined, subtaskCount: tickets.length, tickets };
}

function toTicket(sub: LoadedSubtask): PhaseSubtaskTicket {
  return {
    issueKey: sub.issueKey,
    summary: sub.summary,
    parentKey: sub.parentKey,
    statusCategory: sub.statusCategory,
    planStart: sub.planStart,
    planEnd: sub.planEnd,
    actualStart: sub.actualStart,
    actualEnd: sub.actualEnd,
    originalEstimateHours: sub.originalEstimateSeconds / SECONDS_PER_HOUR,
    timeSpentHours: sub.timeSpentSeconds / SECONDS_PER_HOUR,
    functionName: sub.functionName,
    taskType: sub.taskType,
  };
}

/** UNCLASSIFIED luôn xếp cuối; các mã lạ còn lại đối chiếu theo tiếng Việt. */
function compareExtra(a: string, b: string): number {
  if (a === UNCLASSIFIED_PHASE) return b === UNCLASSIFIED_PHASE ? 0 : 1;
  if (b === UNCLASSIFIED_PHASE) return -1;
  return a.localeCompare(b, 'vi');
}
