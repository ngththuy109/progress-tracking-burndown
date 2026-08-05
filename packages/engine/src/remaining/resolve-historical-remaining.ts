import type { StatusIdMap, SubtaskRecord } from '@app/shared';
import { resolveStatusCategoryAt } from '../status/resolve-status-category.js';
import { totalSpentTill } from './total-spent-till.js';
import {
  parseChangelogSeconds,
  resolveOriginalEstimateAt,
} from './resolve-original-estimate-at.js';

/**
 * Khối lượng CÒN LẠI của một Sub-task tại một mốc quá khứ — PRD §4.3.2.
 *
 * Đây là hàm cốt lõi tạo ra đường Thực tế, thứ mà biểu đồ mặc định của Jira
 * không làm được.
 *
 * Ba quy tắc, xét theo ĐÚNG THỨ TỰ, dừng ngay khi khớp:
 *
 *   1. Tại T_d đã `done`         → 0
 *   2. Có changelog `timeestimate` trước T_d → giá trị MỚI NHẤT
 *   3. Còn lại                    → max(0, OriginalEstimate(T_d) − đã log tới T_d)
 *
 * VÌ SAO QUY TẮC 2 THẮNG QUY TẮC 3: khi con người đã tự khai "còn 30 giờ", ta
 * tin con người hơn phép trừ máy móc.
 */

export const ESTIMATE_FIELD = 'timeestimate';

/** Quy tắc nào đã được áp dụng — API `/explain` (T-25) hiển thị đúng số này. */
export type RemainingRule = 1 | 2 | 3;

export interface HistoricalRemaining {
  readonly seconds: number;
  readonly rule: RemainingRule;
  /** Chỉ có ở quy tắc 2: giá trị con người khai và thời điểm khai. */
  readonly explicitEstimate?: { readonly seconds: number; readonly atMs: number };
  /** Chỉ có ở quy tắc 3. */
  readonly originalEstimateSeconds?: number;
  readonly spentSeconds?: number;
}

export function resolveHistoricalRemaining(
  sub: SubtaskRecord,
  tMs: number,
  statusIdMap: StatusIdMap,
  onWarning?: (code: string, detail: string) => void,
): HistoricalRemaining {
  // --- QUY TẮC 1 ---
  // Không được nhớ "đã done thì mãi mãi done": ca mở lại (E-13) sẽ mất trắng
  // khối lượng làm lại, và lỗi đó im lặng.
  if (resolveStatusCategoryAt(sub.changelog, statusIdMap, tMs, onWarning) === 'done') {
    return { seconds: 0, rule: 1 };
  }

  // --- QUY TẮC 2 ---
  let latestExplicit: number | null = null;
  let latestExplicitAtMs = 0;

  for (const ev of sub.changelog) {
    if (ev.field !== ESTIMATE_FIELD) continue;
    if (ev.createdAtMs > tMs) break;
    // GÁN LẠI mỗi lần khớp, KỂ CẢ gán về `null`. Lần sửa cuối là xoá trắng thì
    // rơi xuống quy tắc 3 (E-05). Viết `if (v !== null) latestExplicit = v` là
    // sai — nó bỏ qua đúng lần xoá trắng đó.
    latestExplicit = parseChangelogSeconds(ev.toValue);
    latestExplicitAtMs = ev.createdAtMs;
  }

  if (latestExplicit !== null) {
    return {
      seconds: Math.max(0, latestExplicit),
      rule: 2,
      explicitEstimate: { seconds: latestExplicit, atMs: latestExplicitAtMs },
    };
  }

  // --- QUY TẮC 3 ---
  const original = resolveOriginalEstimateAt(sub, tMs, onWarning);
  const spent = totalSpentTill(sub, tMs);

  return {
    seconds: Math.max(0, original.seconds - spent),
    rule: 3,
    originalEstimateSeconds: original.seconds,
    spentSeconds: spent,
  };
}

/**
 * Câu giải thích cho API `/explain` (T-25).
 *
 * Bằng TIẾNG ANH vì nó hiện thẳng lên bảng "Where this number comes from" trên
 * màn hình Biểu đồ, nơi khách nước ngoài và PM người Việt cùng đọc.
 */
export function explainRule(r: HistoricalRemaining): string {
  switch (r.rule) {
    case 1:
      return 'Rule 1 — the sub-task was already in the Done status category at this point, so 0 hours remain.';
    case 2:
      return (
        `Rule 2 — someone manually set the remaining estimate to ` +
        `${hours(r.explicitEstimate?.seconds ?? 0)}h. A human-entered value wins over subtraction, ` +
        `so logging more hours does not lower this number.`
      );
    case 3:
      return (
        `Rule 3 — original estimate ${hours(r.originalEstimateSeconds ?? 0)}h ` +
        `minus ${hours(r.spentSeconds ?? 0)}h already logged.`
      );
  }
}

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(2).replace(/\.00$/, '');
}
