import type { GroupRollup, StatusIdMap, SubtaskRecord, WorkCalendar } from '@app/shared';
import { comparePaths, groupPathOf } from '../parser/group-path.js';
import { reduceGroupDates } from './reduce-group-dates.js';

/**
 * Tổng hợp ngày/tổng theo N tầng — tổng quát `computePhaseRollups` (DYNAMIC-TIERS-DESIGN.md §5).
 *
 * Cây phân tầng = MỌI tiền tố (prefix) của vectơ `group_path`. Một lá path
 * `["A","B","C"]` đóng góp vào BA nút: `["A"]`, `["A","B"]`, `["A","B","C"]` — số liệu
 * lá cộng dồn lên mọi tổ tiên (§2.2). Với config mặc định (1 tầng), `groupPathOf` cho
 * `[phaseCode]` nên mỗi lá chỉ có một nút độ sâu 1, và số liệu nút đó BẰNG `PhaseRollup`
 * cùng `phaseCode` — bằng chứng "không đổi hành vi" (kiểm ở compute-group-rollups.test.ts).
 *
 * THUẦN: nhận `asOfMs`, không đọc đồng hồ; cộng dồn KHÔNG lọc bỏ (C-11). Bỏ lá đã gỡ —
 * cùng luật với `computePhaseRollups`.
 *
 * Vòng 2: engine TÍNH được; persist (`group_rollup`) + API + UI drill-down để Vòng 3/4.
 */

/** Mốc "hiện tại" mặc định để xét đã Done chưa — cuối thời gian. Khớp computePhaseRollups. */
const NOW_SENTINEL = 8_640_000_000_000_000;

export interface ComputeGroupRollupArgs {
  readonly subtasks: readonly SubtaskRecord[];
  readonly calendar: WorkCalendar;
  readonly statusIdMap: StatusIdMap;
  /** Mốc UTC (mili-giây) để xét đã Done chưa. Bỏ trống = toàn bộ lịch sử. */
  readonly asOfMs?: number;
}

export function computeGroupRollups(args: ComputeGroupRollupArgs): GroupRollup[] {
  const { subtasks, calendar, statusIdMap } = args;
  const asOfMs = args.asOfMs ?? NOW_SENTINEL;

  // Gom lá vào MỌI nút prefix. Khoá Map = JSON.stringify(prefix): duy nhất cho mọi
  // mảng chuỗi (JSON tự thoát ký tự đặc biệt) nên không cần ký tự phân tách "ma thuật".
  const byNode = new Map<string, { groupPath: string[]; list: SubtaskRecord[] }>();
  for (const s of subtasks) {
    // Lá đã gỡ không tham gia tính toán (dòng vẫn còn trong DB cho snapshot cũ).
    if (s.removedAtMs !== null) continue;
    const path = groupPathOf(s);
    for (let depth = 1; depth <= path.length; depth += 1) {
      const prefix = path.slice(0, depth);
      const key = JSON.stringify(prefix);
      const node = byNode.get(key);
      if (node) node.list.push(s);
      else byNode.set(key, { groupPath: prefix, list: [s] });
    }
  }

  const out: GroupRollup[] = [];
  for (const { groupPath, list } of byNode.values()) {
    const label = groupPath.join(' › ');
    const reduced = reduceGroupDates(
      list,
      calendar,
      statusIdMap,
      asOfMs,
      (planStart, planEnd) =>
        `Nhóm ${label}: ngày bắt đầu kế hoạch (${planStart}) muộn hơn ngày kết thúc ` +
        `(${planEnd}). Nhiều khả năng có lá điền nhầm wbs_*. ` +
        `Tạm coi nhóm dài 1 ngày; hãy sửa trên Jira.`,
    );
    out.push({ tierOrder: groupPath.length, groupPath, ...reduced });
  }

  // Thứ tự ổn định để so hai lần chạy có giống nhau không (C-6): theo tầng rồi path.
  return out.sort((a, b) => a.tierOrder - b.tierOrder || comparePaths(a.groupPath, b.groupPath));
}
