import type { PrismaClient } from '../client.js';

/**
 * Ghi nhật ký log giờ — PRD §4.2, E-03, E-17.
 *
 * Khoá chính là (project_key, worklog_id): ID gốc từ Jira chỉ duy nhất TRONG
 * MỘT SITE, ghép với tenant thì bảng tự chống trùng như cũ — chạy job hai lần
 * không thể sinh dòng thứ hai (C-6), và hai tenant khác site trùng ID số cũng
 * không đè lên nhau.
 */

export interface WorklogUpsertRow {
  worklogId: bigint;
  projectKey: string;
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
      where: { projectKey_worklogId: { projectKey: r.projectKey, worklogId: r.worklogId } },
      create: { worklogId: r.worklogId, projectKey: r.projectKey, ...data },
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
  projectKey: string,
  worklogIds: readonly bigint[],
): Promise<number> {
  if (worklogIds.length === 0) return 0;
  // BẮT BUỘC scope theo tenant: /worklog/deleted của Jira trả ID của CẢ SITE —
  // thiếu project_key thì danh sách xoá của site A có thể đóng dấu nhầm dòng
  // của tenant nằm ở site B trùng ID số.
  const result = await prisma.worklogEntry.updateMany({
    where: { projectKey, worklogId: { in: [...worklogIds] }, isDeleted: false },
    data: { isDeleted: true },
  });
  return result.count;
}
