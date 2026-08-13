import type { DateOnly } from '@app/shared';
import { fromDateString } from '../client.js';
import type { PrismaClient } from '../client.js';

/**
 * Ngày bắt đầu/kết thúc THỰC TẾ của từng Sub-task — bản CHI TIẾT cho Signboard.
 *
 * `phase_rollup` chỉ giữ bản TỔNG HỢP theo Phase (MIN/MAX). Hai ngày này suy ra
 * từ changelog + worklog nên KHÔNG tính được bằng SQL thuần (việc tra
 * status_id → nhóm cần bảng ở Redis); engine tính sẵn per Sub-task rồi job dựng
 * lại GHI xuống đây.
 */
export interface SubtaskActualDatesRow {
  issueKey: string;
  actualStart: DateOnly | null;
  actualEnd: DateOnly | null;
  actualEndIsProvisional: boolean;
}

/** UPSERT theo `issue_key`. Chạy hai lần cho kết quả y hệt (C-6). */
export async function upsertSubtaskActualDates(
  prisma: PrismaClient,
  rows: readonly SubtaskActualDatesRow[],
  computedAt: Date,
): Promise<void> {
  for (const r of rows) {
    const data = {
      actualStart: fromDateString(r.actualStart),
      actualEnd: fromDateString(r.actualEnd),
      actualEndIsProvisional: r.actualEndIsProvisional,
      computedAt,
    };
    await prisma.subtaskActualDates.upsert({
      where: { issueKey: r.issueKey },
      create: { issueKey: r.issueKey, ...data },
      update: data,
    });
  }
}
