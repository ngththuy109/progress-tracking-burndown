import {
  SUGGEST_COLUMN_MIN_COUNT,
  UNPARSED_BANNER_RATIO,
  type DateOnly,
  type SignboardCell,
  type SignboardResponse,
  type SignboardStatus,
  type SignboardSubtask,
  type UnparsedResponse,
} from '@app/shared';
import { mergeCell, mergeCellStatus, resolveCellStatus } from '@app/engine';

/**
 * Dựng bảng Signboard — PRD §6.
 *
 * HÀM THUẦN: nhận Sub-task đã nạp sẵn và "hôm nay" qua tham số, trả về bảng.
 * Toàn bộ phần quyết định trạng thái nằm ở engine (T-22); file này chỉ nhóm
 * hàng, nhóm cột và đếm.
 */

export interface ColumnSpec {
  readonly taskCode: string;
  readonly label: string;
}

export interface BuildSignboardArgs {
  readonly epicKey: string;
  readonly phaseCode: string;
  readonly asOfDate: DateOnly;
  readonly columns: readonly ColumnSpec[];
  readonly subtasks: readonly SignboardSubtask[];
}

const EMPTY_CELL: SignboardCell = { present: false };

export function buildSignboard(args: BuildSignboardArgs): SignboardResponse {
  // Gộp hàng theo `functionKey` (đã NFKC + chữ thường), KHÔNG theo `functionName`.
  // Dùng nhầm thì `Login`, `login` và `Ｌｏｇｉｎ` thành ba hàng riêng và bảng trở
  // nên vô dụng (E-31).
  const byFunction = new Map<string, { name: string; byColumn: Map<string, SignboardSubtask[]> }>();

  for (const s of args.subtasks) {
    if (s.functionKey === null || s.taskType === null) continue;

    let row = byFunction.get(s.functionKey);
    if (row === undefined) {
      // Tên hiển thị lấy theo lần gặp ĐẦU TIÊN — dạng đã chuẩn hoá đọc rất khó.
      row = { name: s.functionName ?? s.functionKey, byColumn: new Map() };
      byFunction.set(s.functionKey, row);
    }

    const list = row.byColumn.get(s.taskType);
    if (list) list.push(s);
    else row.byColumn.set(s.taskType, [s]);
  }

  const byStatus: Record<string, number> = {};
  let emptyCells = 0;

  const rows = [...byFunction.entries()]
    // Sắp theo tên hiển thị, đối chiếu tiếng Việt.
    .sort((a, b) => a[1].name.localeCompare(b[1].name, 'vi'))
    .map(([functionKey, row]) => {
      const cells = args.columns.map((col) => {
        const tickets = row.byColumn.get(col.taskCode) ?? [];
        if (tickets.length === 0) {
          emptyCells += 1;
          return EMPTY_CELL;
        }

        const cell = mergeCell(
          tickets.map((t) => ({
            issueKey: t.issueKey,
            planStart: t.planStart,
            planEnd: t.planEnd,
            actualStart: t.actualStart,
            actualEnd: t.actualEnd,
            status: resolveCellStatus(
              {
                statusCategory: t.statusCategory,
                planStart: t.planStart,
                planEnd: t.planEnd,
                actualStart: t.actualStart,
              },
              args.asOfDate,
            ),
          })),
        );

        if (cell.present) byStatus[cell.status] = (byStatus[cell.status] ?? 0) + 1;
        else emptyCells += 1;
        return cell;
      });

      return { functionKey, functionName: row.name, cells, total: totalCell(cells) };
    });

  const unparsed = args.subtasks.filter((s) => s.parseStatus !== 'OK').length;

  return {
    epicKey: args.epicKey,
    phaseCode: args.phaseCode,
    asOfDate: args.asOfDate,
    columns: args.columns.map((c) => ({ taskCode: c.taskCode, label: c.label })),
    rows,
    summary: {
      byStatus,
      // Ô trống KHÔNG được đếm vào bất kỳ trạng thái nào (§6.5).
      emptyCells,
      totalCells: rows.length * args.columns.length,
    },
    parseHealthWarning:
      args.subtasks.length > 0 && unparsed / args.subtasks.length > UNPARSED_BANNER_RATIO,
  };
}

/**
 * Ô "Tổng" của một hàng.
 *
 * Lấy trạng thái XẤU NHẤT trong các ô CÓ MẶT. Ô trống không tham gia — Function
 * không có khâu đó thì việc thiếu nó không phải là chậm trễ.
 */
export function totalCell(cells: readonly SignboardCell[]): SignboardCell {
  const present = cells.filter((c): c is Extract<SignboardCell, { present: true }> => c.present);
  if (present.length === 0) return EMPTY_CELL;

  const status = mergeCellStatus(present.map((c) => c.status));
  if (status === null) return EMPTY_CELL;

  return {
    present: true,
    planStart: minOf(present.map((c) => c.planStart)),
    planEnd: maxOf(present.map((c) => c.planEnd)),
    actualStart: minOf(present.map((c) => c.actualStart)),
    actualEnd: maxOf(present.map((c) => c.actualEnd)),
    status,
    ticketCount: present.reduce((n, c) => n + c.ticketCount, 0),
    tickets: present.flatMap((c) => c.tickets),
  };
}

function minOf(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) if (v !== null && (best === null || v < best)) best = v;
  return best;
}

function maxOf(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) if (v !== null && (best === null || v > best)) best = v;
  return best;
}

// ---------------------------------------------------------------------------
// Khu "chưa lên được bảng"
// ---------------------------------------------------------------------------

const HINT = {
  BAD_TITLE_FORMAT:
    'The title does not follow [Project][Team][Phase][FunctionName]_TaskName, so it fits no cell. ' +
    'Fix the title in Jira and resync. This sub-task DOES still count towards the Burndown chart.',
  UNKNOWN_TASK_TYPE:
    'The TaskName part of the title matches no configured column. ' +
    'Either fix the title, or add a new column on the Signboard columns screen.',
} as const;

export function buildUnparsedList(args: {
  readonly epicKey: string;
  readonly phaseCode: string;
  readonly subtasks: readonly SignboardSubtask[];
  /** Bóc `TaskName` thô từ tiêu đề, để gợi ý cột mới. */
  readonly rawTaskTypeOf?: (s: SignboardSubtask) => string | null;
}): UnparsedResponse {
  const items = args.subtasks
    .filter((s) => s.parseStatus !== 'OK' || s.taskType === null)
    .map((s) => {
      const reason = s.parseStatus === 'UNPARSED' ? 'BAD_TITLE_FORMAT' : 'UNKNOWN_TASK_TYPE';
      return {
        issueKey: s.issueKey,
        summary: s.summary,
        reason: reason as 'BAD_TITLE_FORMAT' | 'UNKNOWN_TASK_TYPE',
        hint: HINT[reason],
        rawTaskType: reason === 'UNKNOWN_TASK_TYPE' ? (args.rawTaskTypeOf?.(s) ?? null) : null,
      };
    })
    .sort((a, b) => a.issueKey.localeCompare(b.issueKey));

  // Cùng một `TaskName` lạ xuất hiện ≥ 3 lần thì gần như chắc chắn đó là một
  // khâu có thật mà chưa ai khai cột (E-29).
  const counts = new Map<string, number>();
  for (const i of items) {
    if (i.rawTaskType !== null) counts.set(i.rawTaskType, (counts.get(i.rawTaskType) ?? 0) + 1);
  }

  const unparsed = args.subtasks.filter((s) => s.parseStatus !== 'OK').length;

  return {
    epicKey: args.epicKey,
    phaseCode: args.phaseCode,
    items,
    suggestedColumns: [...counts.entries()]
      .filter(([, count]) => count >= SUGGEST_COLUMN_MIN_COUNT)
      .map(([taskCode, count]) => ({ taskCode, count }))
      .sort((a, b) => b.count - a.count || a.taskCode.localeCompare(b.taskCode)),
    totalSubtasks: args.subtasks.length,
    parseHealthWarning:
      args.subtasks.length > 0 && unparsed / args.subtasks.length > UNPARSED_BANNER_RATIO,
  };
}

/** Trạng thái xuất hiện trong bảng, dùng cho thanh tóm tắt bấm lọc được. */
export function statusesInBoard(response: SignboardResponse): SignboardStatus[] {
  return Object.keys(response.summary.byStatus) as SignboardStatus[];
}
