import type { SubtaskRecord } from '@app/shared';

/**
 * Chiếu `phaseCode → group_path` — điểm DUY NHẤT engine suy vectơ khoá tầng từ một lá.
 *
 * Lá thiếu `groupPath` (config mặc định 1 tầng, hoặc dữ liệu chưa backfill) ⇒ coi như
 * đúng MỘT tầng `[phaseCode]`. Nhờ vậy các hàm N tầng (`computeGroupRollups`,
 * `buildTierSnapshotForDay`) chạy trên dữ liệu cũ cho ra kết quả y hệt tầng Phase —
 * đó là bằng chứng "không đổi hành vi".
 *
 * KHÔNG dùng trong `computePhaseRollups` / `buildSnapshotForDay`: hai hàm đó giữ khoá
 * scalar `phaseCode` để 20 golden dataset (PRD §8.2) không đổi một byte.
 */
export function groupPathOf(sub: SubtaskRecord): readonly string[] {
  return sub.groupPath && sub.groupPath.length > 0 ? sub.groupPath : [sub.phaseCode];
}

/**
 * So hai path theo thứ tự từ điển, từng phần tử một; path ngắn hơn đứng trước khi
 * trùng tiền tố. Dùng để sắp xếp ổn định danh sách nút prefix (C-6) — cùng luật cho
 * `computeGroupRollups` và `buildTierSnapshotForDay`.
 */
export function comparePaths(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const c = a[i]!.localeCompare(b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}
