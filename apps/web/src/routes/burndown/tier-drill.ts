import type { TierSeries } from '@app/shared';

/**
 * Chọn nút để drill-down theo tầng — thuần, React-free (test được không cần DOM).
 *
 * Cây tầng = các tiền tố của group_path. Con TRỰC TIẾP của một nút = groupPath dài
 * hơn ĐÚNG một phần tử và khớp toàn bộ tiền tố hiện tại.
 */

export function childrenOf(
  tierSeries: readonly TierSeries[],
  path: readonly string[],
): TierSeries[] {
  return tierSeries.filter(
    (s) => s.groupPath.length === path.length + 1 && path.every((c, i) => s.groupPath[i] === c),
  );
}

/** Nút này còn con để drill sâu hơn không? (quyết định có hiện mũi tên ▸.) */
export function hasChildren(
  tierSeries: readonly TierSeries[],
  groupPath: readonly string[],
): boolean {
  return tierSeries.some(
    (s) =>
      s.groupPath.length === groupPath.length + 1 &&
      groupPath.every((c, i) => s.groupPath[i] === c),
  );
}
