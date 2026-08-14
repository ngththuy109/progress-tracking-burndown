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

/**
 * Điểm BẮT ĐẦU drill: tự tụt qua những cấp chỉ có ĐÚNG MỘT nút (và nút đó còn con).
 *
 * Vì sao: config Giai đoạn là GLOBAL nên Epic 1 giai đoạn cũng mang tầng GĐ với đúng
 * một nút (catch-all). Bắt người dùng bấm xuyên qua "GD1" duy nhất là vô nghĩa — bỏ
 * qua cấp đó thì Epic 1 giai đoạn nhìn Y HỆT chế độ Phase hôm nay, Epic ≥2 giai đoạn
 * mới thấy cấp GĐ. Dừng TRƯỚC nút lá đơn độc (vẫn phải vẽ được biểu đồ của nút đó).
 */
export function baseDrillPath(tierSeries: readonly TierSeries[]): string[] {
  const base: string[] = [];
  for (;;) {
    const kids = childrenOf(tierSeries, base);
    if (kids.length !== 1) return base;
    const only = kids[0]!;
    if (!hasChildren(tierSeries, only.groupPath)) return base;
    base.push(only.groupPath[only.groupPath.length - 1]!);
  }
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
