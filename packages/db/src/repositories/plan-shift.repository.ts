import type { PlanShiftRecord } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Lịch sử dịch chuyển kế hoạch — tuyến phòng thủ chính cho **R-11**.
 *
 * CHỈ THÊM, không bao giờ sửa hay xoá: đây là sổ ghi chép, và một sổ ghi chép
 * sửa được thì không còn dùng để đối chứng.
 */

export interface InsertShiftResult {
  readonly inserted: number;
  /**
   * Số bản ghi bị bỏ qua vì có mốc `null`.
   *
   * Xảy ra khi Phase chuyển từ "chưa có ngày kế hoạch nào" sang "có ngày" — đó
   * là kế hoạch vừa **xuất hiện**, không phải bị **dịch chuyển**, và cột
   * `from_date`/`to_date` trong DB không nhận `null`.
   *
   * Trả về con số này thay vì bỏ qua im lặng, để chỗ gọi còn ghi log được.
   */
  readonly skippedNullBoundary: number;
}

export async function insertPlanShifts(
  prisma: PrismaClient,
  epicKey: string,
  shifts: readonly PlanShiftRecord[],
  detectedAt: Date,
): Promise<InsertShiftResult> {
  const usable = shifts.filter((s) => s.fromDate !== null && s.toDate !== null);
  if (usable.length > 0) {
    await prisma.planShiftHistory.createMany({
      data: usable.map((s) => ({
        epicKey,
        phaseCode: s.phaseCode,
        shiftType: s.shiftType,
        fromDate: new Date(`${s.fromDate!}T00:00:00Z`),
        toDate: new Date(`${s.toDate!}T00:00:00Z`),
        shiftedWorkdays: s.shiftedWorkdays,
        causedByKeys: [...s.causedByKeys],
        detectedAt,
      })),
    });
  }

  return {
    inserted: usable.length,
    skippedNullBoundary: shifts.length - usable.length,
  };
}

export interface PlanShiftSummary {
  /** Chỉ cộng phần bị LÙI RA XA. Lần kéo sớm lên không bù trừ cho lần lùi. */
  readonly totalShiftedWorkdays: number;
  readonly shiftCount: number;
}

/**
 * Tổng mức dịch chuyển của một Phase.
 *
 * Cố ý CHỈ cộng các lần lùi ra xa (số dương). Nếu để lần kéo sớm bù trừ thì một
 * Phase lùi 10 ngày rồi cắt bớt phạm vi cho sớm lại 10 ngày sẽ hiện "không dịch
 * chuyển gì" — trong khi thực tế kế hoạch đã đổi hai lần và độ trễ bị giấu đi
 * bằng cách cắt việc.
 */
export async function summarizePlanShifts(
  prisma: PrismaClient,
  epicKey: string,
  phaseCode?: string,
): Promise<PlanShiftSummary> {
  const rows = await prisma.planShiftHistory.findMany({
    where: { epicKey, ...(phaseCode ? { phaseCode } : {}), shiftType: 'END_MOVED' },
    select: { shiftedWorkdays: true },
  });

  return {
    totalShiftedWorkdays: rows.reduce((sum, r) => sum + Math.max(0, r.shiftedWorkdays), 0),
    shiftCount: rows.length,
  };
}

/** Lịch sử đầy đủ, mới nhất trước — API `GET /api/epic/:key/plan-shift-history` (T-25). */
export async function listPlanShifts(
  prisma: PrismaClient,
  epicKey: string,
): Promise<Array<PlanShiftRecord & { detectedAt: string }>> {
  const rows = await prisma.planShiftHistory.findMany({
    where: { epicKey },
    orderBy: { detectedAt: 'desc' },
  });

  return rows.map((r) => ({
    phaseCode: r.phaseCode,
    shiftType: r.shiftType as PlanShiftRecord['shiftType'],
    fromDate: r.fromDate.toISOString().slice(0, 10),
    toDate: r.toDate.toISOString().slice(0, 10),
    shiftedWorkdays: r.shiftedWorkdays,
    causedByKeys: r.causedByKeys,
    detectedAt: r.detectedAt.toISOString(),
  }));
}
