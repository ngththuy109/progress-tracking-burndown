import type { GroupRollup } from '@app/shared';
import { Prisma } from '../client.js';
import type { PrismaClient } from '../client.js';

/**
 * Ghi/đọc rollup N tầng — DYNAMIC-TIERS-DESIGN §4.3, Vòng 4.
 *
 * Tổng quát `phase-rollup.repository` cho MỌI nút prefix của group_path. UPSERT theo
 * khoá tự nhiên `(epic_key, group_key)` với `group_key = JSON.stringify(group_path)` —
 * chuỗi ổn định để so khớp (không dùng JSONB làm khoá). Cảnh báo KHÔNG lưu (như
 * phase_rollup). Chỉ ghi khi cấu hình đa tầng; Epic 1 tầng để trống.
 */

const toDate = (d: string | null): Date | null => (d === null ? null : new Date(`${d}T00:00:00Z`));
const fromDate = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

/** Khoá tự nhiên của một nút rollup: JSON của group_path. */
export function groupKeyOf(groupPath: readonly string[]): string {
  return JSON.stringify(groupPath);
}

export async function upsertGroupRollups(
  prisma: PrismaClient,
  epicKey: string,
  rollups: readonly GroupRollup[],
  computedAt: Date,
): Promise<void> {
  for (const r of rollups) {
    const groupKey = groupKeyOf(r.groupPath);
    const data = {
      tierOrder: r.tierOrder,
      groupPath: [...r.groupPath] as Prisma.InputJsonValue,
      planStart: toDate(r.planStart),
      planEnd: toDate(r.planEnd),
      planWorkdays: r.planWorkdays,
      actualStart: toDate(r.actualStart),
      actualEnd: toDate(r.actualEnd),
      actualEndIsProvisional: r.actualEndIsProvisional,
      totalOriginalS: BigInt(r.totalOriginalS),
      subtaskCount: r.subtaskCount,
      missingDateCount: r.missingDateCount,
      computedAt,
    };
    await prisma.groupRollup.upsert({
      where: { epicKey_groupKey: { epicKey, groupKey } },
      create: { epicKey, groupKey, ...data },
      update: data,
    });
  }
}

/**
 * Xoá nút không còn trong lần tính mới (nút cha rỗng con, hoặc cấu hình về 1 tầng).
 *
 * `liveGroupKeys` rỗng ⇒ xoá SẠCH group_rollup của Epic (đã chuyển về 1 tầng) — cùng
 * lối phòng thủ với `markRemovedIssues`: chỉ thêm điều kiện `notIn` khi có khoá sống.
 */
export async function deleteObsoleteGroupRollups(
  prisma: PrismaClient,
  epicKey: string,
  liveGroupKeys: readonly string[],
): Promise<number> {
  const result = await prisma.groupRollup.deleteMany({
    where: {
      epicKey,
      ...(liveGroupKeys.length > 0 ? { groupKey: { notIn: [...liveGroupKeys] } } : {}),
    },
  });
  return result.count;
}

export async function loadGroupRollups(
  prisma: PrismaClient,
  epicKey: string,
): Promise<GroupRollup[]> {
  const rows = await prisma.groupRollup.findMany({
    where: { epicKey },
    orderBy: [{ tierOrder: 'asc' }, { groupKey: 'asc' }],
  });
  return rows.map((r) => ({
    tierOrder: r.tierOrder,
    groupPath: Array.isArray(r.groupPath) ? (r.groupPath as string[]) : [],
    planStart: fromDate(r.planStart),
    planEnd: fromDate(r.planEnd),
    planWorkdays: r.planWorkdays,
    actualStart: fromDate(r.actualStart),
    actualEnd: fromDate(r.actualEnd),
    actualEndIsProvisional: r.actualEndIsProvisional,
    totalOriginalS: Number(r.totalOriginalS),
    subtaskCount: r.subtaskCount,
    missingDateCount: r.missingDateCount,
    warnings: [],
  }));
}
