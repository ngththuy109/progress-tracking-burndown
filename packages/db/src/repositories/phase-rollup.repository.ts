import type { PhaseRollup } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Ghi ngày plan/actual của từng Phase — PRD §2.7.
 *
 * Tính lại sau MỖI lần đồng bộ, nên luôn là UPSERT theo `(epic_key, phase_code)`
 * (C-6).
 */

const toDate = (d: string | null): Date | null => (d === null ? null : new Date(`${d}T00:00:00Z`));
const fromDate = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

export async function upsertPhaseRollups(
  prisma: PrismaClient,
  epicKey: string,
  rollups: readonly PhaseRollup[],
  computedAt: Date,
): Promise<void> {
  for (const r of rollups) {
    const data = {
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

    await prisma.phaseRollup.upsert({
      where: { epicKey_phaseCode: { epicKey, phaseCode: r.phaseCode } },
      create: { epicKey, phaseCode: r.phaseCode, ...data },
      update: data,
    });
  }
}

/**
 * Đọc bản rollup TRƯỚC ĐÓ để so ra dịch chuyển kế hoạch.
 *
 * Phải đọc TRƯỚC khi ghi bản mới, nếu không sẽ so bản mới với chính nó và
 * không bao giờ phát hiện được dịch chuyển nào (R-11).
 */
export async function loadPhaseRollups(
  prisma: PrismaClient,
  epicKey: string,
): Promise<Map<string, PhaseRollup>> {
  const rows = await prisma.phaseRollup.findMany({ where: { epicKey } });

  return new Map(
    rows.map((r) => [
      r.phaseCode,
      {
        phaseCode: r.phaseCode,
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
      } satisfies PhaseRollup,
    ]),
  );
}

/**
 * Xoá bản rollup của Phase không còn Sub-task nào.
 *
 * Sub-task cuối cùng chuyển sang Phase khác thì Phase cũ phải biến mất khỏi
 * biểu đồ. Giữ lại sẽ hiện một Phase rỗng với số liệu cũ đông cứng (E-24).
 */
export async function deleteObsoleteRollups(
  prisma: PrismaClient,
  epicKey: string,
  livePhaseCodes: readonly string[],
): Promise<number> {
  const result = await prisma.phaseRollup.deleteMany({
    where: { epicKey, phaseCode: { notIn: [...livePhaseCodes] } },
  });
  return result.count;
}
