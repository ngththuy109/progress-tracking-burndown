import type {
  DateOnly,
  ExplainResponse,
  ExplainRow,
  StatusIdMap,
  SubtaskRecord,
  WorkCalendar,
} from '@app/shared';
import {
  endOfDayUtcMs,
  explainRule,
  resolveHistoricalRemaining,
  resolveOriginalEstimateAt,
  resolveStatusCategoryAt,
  totalSpentTill,
} from '@app/engine';

/**
 * Giải thích một điểm dữ liệu — PRD §10.3, bước đầu tiên trong runbook khi PM
 * báo số liệu sai.
 *
 * HÀM THUẦN: nhận Sub-task đã nạp sẵn, trả về từng dòng kèm **quy tắc nào đã
 * được áp dụng**. Trả về con số mà không kèm lý do thì endpoint này vô dụng
 * đúng vào lúc cần nó nhất — người vận hành vẫn phải mở database.
 */

const SECONDS_PER_HOUR = 3600;
const toHours = (s: number): number => s / SECONDS_PER_HOUR;

export interface ExplainInput {
  readonly epicKey: string;
  readonly date: DateOnly;
  /** TOÀN BỘ Sub-task của Epic, kể cả cái đã gỡ — hàm tự lọc theo mốc thời gian. */
  readonly subtasks: readonly SubtaskRecord[];
  readonly summaries: Readonly<Record<string, string>>;
  readonly calendar: WorkCalendar;
  readonly statusIdMap: StatusIdMap;
  /** `actual_remaining_s` của snapshot ngày đó, để đối chiếu. */
  readonly storedRemainingSeconds: number;
  /** Ai sửa `timeestimate`, tra theo `issueKey` + mốc thời gian. */
  readonly changeAuthors?: Readonly<Record<string, string | null>>;
}

export function explainDay(input: ExplainInput): ExplainResponse {
  const T = endOfDayUtcMs(input.date, input.calendar.timezone);

  // Cùng điều kiện lọc với `buildSnapshotForDay` (T-17). Lệch điều kiện ở đây là
  // phần giải thích mâu thuẫn với chính snapshot mà nó đang giải thích.
  const active = input.subtasks.filter(
    (s) => s.createdAtMs <= T && (s.removedAtMs === null || s.removedAtMs > T),
  );

  const rows: ExplainRow[] = active.map((sub) => {
    const remaining = resolveHistoricalRemaining(sub, T, input.statusIdMap);
    const original = resolveOriginalEstimateAt(sub, T);
    // Giờ đã log tính theo `started`, không theo `created` (C-1, E-03).
    const spent = totalSpentTill(sub, T);
    const category = resolveStatusCategoryAt(sub.changelog, input.statusIdMap, T);

    const override =
      remaining.rule === 2 && remaining.explicitEstimate !== undefined
        ? {
            valueHours: toHours(remaining.explicitEstimate.seconds),
            changedAt: new Date(remaining.explicitEstimate.atMs).toISOString(),
            changedBy: input.changeAuthors?.[`${sub.key}:${remaining.explicitEstimate.atMs}`] ?? null,
          }
        : null;

    return {
      issueKey: sub.key,
      summary: input.summaries[sub.key] ?? sub.key,
      // Sub-task `UNCLASSIFIED` VẪN nằm trong danh sách: nó vẫn cộng vào tổng
      // (C-11). Bỏ đi thì tổng không khớp snapshot và người điều tra sẽ đi tìm
      // một sai số không tồn tại.
      phaseCode: sub.phaseCode,
      statusCategoryAtDay: category,
      appliedRule: remaining.rule,
      ruleExplanation: explainRule(remaining),
      originalEstimateHours: toHours(original.seconds),
      spentHoursUpToDay: toHours(spent),
      remainingHours: toHours(remaining.seconds),
      estimateOverride: override,
    };
  });

  const recomputedSeconds = active.reduce(
    (sum, sub) => sum + resolveHistoricalRemaining(sub, T, input.statusIdMap).seconds,
    0,
  );

  const differenceSeconds = recomputedSeconds - input.storedRemainingSeconds;

  return {
    epicKey: input.epicKey,
    date: input.date,
    rows: [...rows].sort((a, b) => a.issueKey.localeCompare(b.issueKey)),
    recomputedRemainingHours: toHours(recomputedSeconds),
    storedRemainingHours: toHours(input.storedRemainingSeconds),
    // Lệch nhau nghĩa là snapshot cũ hoặc engine sai — chính là thứ endpoint
    // này đáng giá hơn một bảng số thường.
    mismatch:
      differenceSeconds === 0
        ? null
        : {
            storedHours: toHours(input.storedRemainingSeconds),
            recomputedHours: toHours(recomputedSeconds),
            differenceHours: toHours(differenceSeconds),
          },
  };
}
