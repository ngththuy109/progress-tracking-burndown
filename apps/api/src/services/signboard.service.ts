import {
  SUGGEST_COLUMN_MIN_COUNT,
  UNPARSED_BANNER_RATIO,
  type DateOnly,
  type SignboardCell,
  type SignboardColumnGroup,
  type SignboardResponse,
  type SignboardStatus,
  type SignboardSubtask,
  type UnparsedResponse,
} from '@app/shared';
import { mergeCell, mergeCellStatus, normalize, normalizePreservingCase, resolveCellStatus } from '@app/engine';

/**
 * Dựng bảng Signboard — PRD §6.
 *
 * HÀM THUẦN: nhận Sub-task đã nạp sẵn và "hôm nay" qua tham số, trả về bảng.
 * Toàn bộ phần quyết định trạng thái nằm ở engine (T-22); file này chỉ nhóm
 * hàng, nhóm cột và đếm.
 *
 * Cột được nhóm hai tầng: tầng trên là **Sub-phase** (`[Sub-phase]` ngay trước
 * Function trong tiêu đề — PRD §2.9.1), tầng dưới là loại task. Cùng một bộ loại
 * task lặp lại dưới mỗi Sub-phase; `cells`/`columns` là mảng LÁ đã làm phẳng theo
 * thứ tự nhóm, nên `SignboardCell` và logic ô ở engine không phải đổi.
 */

export interface ColumnSpec {
  readonly taskCode: string;
  readonly label: string;
}

/** Nhãn + thứ tự hiển thị của một Sub-phase, tra theo khoá đã chuẩn hoá. */
export interface SubPhaseMetaEntry {
  readonly label: string;
  readonly order: number;
}

export interface BuildSignboardArgs {
  readonly epicKey: string;
  readonly phaseCode: string;
  readonly asOfDate: DateOnly;
  readonly columns: readonly ColumnSpec[];
  readonly subtasks: readonly SignboardSubtask[];
  /**
   * Nhãn + thứ tự cho từng Sub-phase, khoá = `normalize(phaseCode)` của cấu hình.
   * Sub-phase khớp một Phase trong cấu hình lấy nhãn + `display_order` của Phase
   * đó; Sub-phase lạ xếp sau theo A→Z. Bỏ trống thì mọi Sub-phase là "lạ".
   */
  readonly subPhaseMeta?: ReadonlyMap<string, SubPhaseMetaEntry>;
}

const EMPTY_CELL: SignboardCell = { present: false };

/**
 * Khoá nhóm dự phòng cho Sub-task thiếu `[Sub-phase]` trong tiêu đề.
 *
 * Không Sub-phase THẬT nào chuẩn hoá về chuỗi rỗng: parser đã `trim() || null`,
 * nên bracket rỗng thành `null`, không phải `''`.
 */
const NO_SUB_PHASE_KEY = '';
const NO_SUB_PHASE_LABEL = '(No sub-phase)';
/** Nối khoá ô: `\u0000` không xuất hiện trong mã đã chuẩn hoá nên không đụng độ. */
const CELL_KEY_SEP = '\u0000';

interface SubPhaseAgg {
  readonly key: string;
  readonly label: string;
}

export function buildSignboard(args: BuildSignboardArgs): SignboardResponse {
  const meta = args.subPhaseMeta ?? new Map<string, SubPhaseMetaEntry>();

  // Gộp hàng theo `functionKey` (đã NFKC + chữ thường), KHÔNG theo `functionName`.
  // Dùng nhầm thì `Login`, `login` và `Ｌｏｇｉｎ` thành ba hàng riêng và bảng trở
  // nên vô dụng (E-31). Ô gộp theo `(subPhaseKey, taskType)`.
  const subPhases = new Map<string, SubPhaseAgg>();
  const byFunction = new Map<string, { name: string; byCell: Map<string, SignboardSubtask[]> }>();

  for (const s of args.subtasks) {
    if (s.functionKey === null || s.taskType === null) continue;

    const raw = s.subPhaseRaw !== null && s.subPhaseRaw.trim() !== '' ? s.subPhaseRaw.trim() : null;
    const spKey = raw === null ? NO_SUB_PHASE_KEY : normalize(raw);

    if (!subPhases.has(spKey)) {
      // Nhãn: Phase khớp trong cấu hình → nhãn cấu hình; lạ → chữ gốc (giữ hoa
      // thường, gặp lần ĐẦU); thiếu bracket → nhãn dự phòng cố định.
      const label =
        spKey === NO_SUB_PHASE_KEY
          ? NO_SUB_PHASE_LABEL
          : (meta.get(spKey)?.label ?? normalizePreservingCase(raw ?? spKey));
      subPhases.set(spKey, { key: spKey, label });
    }

    let row = byFunction.get(s.functionKey);
    if (row === undefined) {
      // Tên hiển thị lấy theo lần gặp ĐẦU TIÊN — dạng đã chuẩn hoá đọc rất khó.
      row = { name: s.functionName ?? s.functionKey, byCell: new Map() };
      byFunction.set(s.functionKey, row);
    }

    const cellKey = spKey + CELL_KEY_SEP + s.taskType;
    const list = row.byCell.get(cellKey);
    if (list) list.push(s);
    else row.byCell.set(cellKey, [s]);
  }

  // Thứ tự nhóm Sub-phase: khớp cấu hình → theo `display_order` (rồi A→Z cho hoà);
  // lạ → xếp sau theo nhãn A→Z; nhóm dự phòng LUÔN xếp cuối cùng.
  const orderedSubPhases = [...subPhases.values()].sort((a, b) => {
    const fa = a.key === NO_SUB_PHASE_KEY ? 1 : 0;
    const fb = b.key === NO_SUB_PHASE_KEY ? 1 : 0;
    if (fa !== fb) return fa - fb;

    const oa = meta.get(a.key)?.order;
    const ob = meta.get(b.key)?.order;
    if (oa !== undefined && ob !== undefined) return oa - ob || a.label.localeCompare(b.label, 'vi');
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return a.label.localeCompare(b.label, 'vi');
  });

  const columnGroups: SignboardColumnGroup[] = orderedSubPhases.map((sp) => ({
    subPhaseKey: sp.key,
    subPhaseLabel: sp.label,
    // Cùng bộ cột cấu hình cho MỌI nhóm — giữ lưới đều để so ngang giữa các Sub-phase.
    taskColumns: args.columns.map((c) => ({ taskCode: c.taskCode, label: c.label })),
  }));

  // Cột LÁ đã làm phẳng — 1:1 với `cells` của mỗi hàng.
  const flatColumns = orderedSubPhases.flatMap((sp) =>
    args.columns.map((c) => ({ taskCode: c.taskCode, label: c.label, subPhaseKey: sp.key })),
  );

  const byStatus: Record<string, number> = {};
  let emptyCells = 0;

  const rows = [...byFunction.entries()]
    // Sắp theo tên hiển thị, đối chiếu tiếng Việt.
    .sort((a, b) => a[1].name.localeCompare(b[1].name, 'vi'))
    .map(([functionKey, row]) => {
      const cells: SignboardCell[] = [];
      const subtotals: SignboardCell[] = [];

      for (const sp of orderedSubPhases) {
        const groupCells = args.columns.map((col) => {
          const tickets = row.byCell.get(sp.key + CELL_KEY_SEP + col.taskCode) ?? [];
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

        cells.push(...groupCells);
        // Ô "Σ" của nhóm: trạng thái xấu nhất TRONG Sub-phase đó.
        subtotals.push(totalCell(groupCells));
      }

      return { functionKey, functionName: row.name, cells, subtotals, total: totalCell(cells) };
    });

  const unparsed = args.subtasks.filter((s) => s.parseStatus !== 'OK').length;

  return {
    epicKey: args.epicKey,
    phaseCode: args.phaseCode,
    asOfDate: args.asOfDate,
    columnGroups,
    columns: flatColumns,
    rows,
    summary: {
      byStatus,
      // Ô trống KHÔNG được đếm vào bất kỳ trạng thái nào (§6.5).
      emptyCells,
      totalCells: rows.length * flatColumns.length,
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
