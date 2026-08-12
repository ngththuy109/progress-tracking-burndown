import type { StatusCategory, StatusIdMap, SubtaskRecord } from '@app/shared';
import { resolveHistoricalRemaining } from '../remaining/resolve-historical-remaining.js';
import { resolveOriginalEstimateAt } from '../remaining/resolve-original-estimate-at.js';
import { totalSpentTill } from '../remaining/total-spent-till.js';
import { resolveStatusCategoryAt } from '../status/resolve-status-category.js';

/**
 * Bốn giá trị của MỘT lá tại mốc T — dùng chung giữa `buildSnapshotForDay` (tổng Epic
 * + per-phase) và `buildTierSnapshotForDay` (per-nút N tầng, DYNAMIC-TIERS-DESIGN.md §5).
 *
 * Tách ra để hai nơi KHÔNG lệch cách tua lịch sử: khối lượng còn lại, giờ đã log, ước
 * lượng ban đầu, và nhóm trạng thái — tất cả TẠI mốc T (không phải "bây giờ").
 *
 * THUẦN: nhận mốc T, không đọc đồng hồ (C-12).
 */
export interface LeafDayValues {
  readonly remaining: number;
  readonly spent: number;
  readonly original: number;
  readonly category: StatusCategory;
}

export function accumulateLeafAtDay(
  sub: SubtaskRecord,
  T: number,
  statusIdMap: StatusIdMap,
  onWarning?: (code: string, detail: string) => void,
): LeafDayValues {
  return {
    remaining: resolveHistoricalRemaining(sub, T, statusIdMap, onWarning).seconds,
    spent: totalSpentTill(sub, T),
    original: resolveOriginalEstimateAt(sub, T, onWarning).seconds,
    category: resolveStatusCategoryAt(sub.changelog, statusIdMap, T, onWarning),
  };
}
