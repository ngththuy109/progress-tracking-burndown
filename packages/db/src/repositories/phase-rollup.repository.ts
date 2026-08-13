import type { PhaseRollup, PlannedSubtaskItem } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Ghi ngày plan/actual của từng Phase — PRD §2.7.
 *
 * Tính lại sau MỖI lần đồng bộ, nên luôn là UPSERT theo `(epic_key, phase_code)`
 * (C-6).
 */

const toDate = (d: string | null): Date | null => (d === null ? null : new Date(`${d}T00:00:00Z`));
const fromDate = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

/**
 * Đọc cột JSON `planned_items` (lịch ramp per-Sub-task).
 *
 * Cột JSON là biên giữa hai hệ kiểu — dữ liệu cũ hoặc DEFAULT '[]' có thể thiếu
 * trường mà không có gì báo. Đọc phòng thủ từng trường, bỏ qua phần tử sai kiểu.
 */
function readPlannedItems(raw: unknown): PlannedSubtaskItem[] {
  if (!Array.isArray(raw)) return [];

  const out: PlannedSubtaskItem[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o['wbsStartDate'] !== 'string' || typeof o['wbsEndDate'] !== 'string') continue;

    out.push({
      wbsStartDate: o['wbsStartDate'],
      wbsEndDate: o['wbsEndDate'],
      originalS: num(o['originalS']),
      planWorkdays: num(o['planWorkdays']),
    });
  }
  return out;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

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
      // Map sang object thuần: Prisma `Json` nhận `InputJsonValue`, không nhận
      // mảng readonly. Chỉ lấy đúng bốn trường cần lưu.
      plannedItems: r.plannedItems.map((i) => ({
        wbsStartDate: i.wbsStartDate,
        wbsEndDate: i.wbsEndDate,
        originalS: i.originalS,
        planWorkdays: i.planWorkdays,
      })),
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
        plannedItems: readPlannedItems(r.plannedItems),
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
