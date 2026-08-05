import type { PrismaClient } from '../client.js';

/**
 * Ghi nhật ký log giờ — PRD §4.2, E-03, E-17.
 *
 * `worklog_id` là ID gốc từ Jira và cũng là khoá chính, nên bản thân bảng đã tự
 * chống trùng: chạy job hai lần không thể sinh dòng thứ hai (C-6).
 */

export interface WorklogUpsertRow {
  worklogId: bigint;
  issueKey: string;
  epicKey: string;
  authorAccountId: string | null;
  timeSpentS: bigint;
  /** Ngày NGƯỜI DÙNG khai đã làm. Engine luôn lọc theo trường này (C-1). */
  startedAt: Date;
  /** Ngày BẤM NÚT log. Chỉ dùng để phát hiện log lùi ngày. */
  jiraCreatedAt: Date;
  jiraUpdatedAt: Date;
  isDeleted: boolean;
}

export async function upsertWorklogs(
  prisma: PrismaClient,
  rows: readonly WorklogUpsertRow[],
): Promise<void> {
  if (rows.length === 0) return;

  for (const r of rows) {
    const data = {
      issueKey: r.issueKey,
      epicKey: r.epicKey,
      authorId: r.authorAccountId,
      timeSpentS: r.timeSpentS,
      startedAt: r.startedAt,
      createdAt: r.jiraCreatedAt,
      updatedAt: r.jiraUpdatedAt,
      isDeleted: r.isDeleted,
    };

    await prisma.worklogEntry.upsert({
      where: { worklogId: r.worklogId },
      create: { worklogId: r.worklogId, ...data },
      update: data,
    });
  }
}

/**
 * Worklog bị xoá trên Jira: ĐẶT CỜ, không xoá dòng (E-17).
 *
 * Giữ lại dòng để giải thích được vì sao số liệu của một ngày đã chốt sổ lại
 * thay đổi. Xoá đi thì số cũ và số mới không còn cách nào đối chiếu.
 */
export async function markWorklogsDeleted(
  prisma: PrismaClient,
  worklogIds: readonly bigint[],
): Promise<number> {
  if (worklogIds.length === 0) return 0;
  const result = await prisma.worklogEntry.updateMany({
    where: { worklogId: { in: [...worklogIds] }, isDeleted: false },
    data: { isDeleted: true },
  });
  return result.count;
}
