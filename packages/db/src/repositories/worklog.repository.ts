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

/**
 * ĐỐI SOÁT khi ĐỌC LẠI TOÀN BỘ (backfill / full resync): đặt cờ cho mọi worklog
 * của Epic KHÔNG còn nằm trong `liveWorklogIds` — tập worklog CÒN SỐNG vừa lấy
 * đầy đủ từ Jira. Song song với `markRemovedIssues` cho issue.
 *
 * Vì sao PHẢI có: API `/worklog/deleted` chỉ hỏi được khi có mốc `since`, nên
 * lượt đọc lại toàn bộ (không có `since`) KHÔNG BAO GIỜ thấy worklog đã xoá qua
 * đường đó — Jira đơn giản là không trả nó về nữa. Không đối soát ở đây thì một
 * worklog xoá trên Jira sẽ mãi mãi `is_deleted = false` trong DB, và ngày
 * BẮT ĐẦU / KẾT THÚC THỰC TẾ (suy ra từ worklog) không bao giờ tính lại đúng dù
 * chạy full resync bao nhiêu lần: xoá worklog 11/8 rồi resync mà ngày kết thúc
 * vẫn kẹt ở 11/8 thay vì lùi về 10/8.
 *
 * CHỈ AN TOÀN khi `liveWorklogIds` là tập ĐẦY ĐỦ (chế độ đọc lại toàn bộ). Ở chế
 * độ tăng dần, danh sách worklog lấy về chỉ gồm bản VỪA ĐỔI, dùng nó để đối soát
 * sẽ xoá nhầm sạch phần không đổi — việc xoá của chế độ tăng dần đã có
 * `/worklog/deleted` lo (xem `fetchHistory`). Người gọi PHẢI tự chặn điều kiện này.
 */
export async function markWorklogsDeletedMissing(
  prisma: PrismaClient,
  epicKey: string,
  liveWorklogIds: ReadonlySet<bigint>,
): Promise<number> {
  const result = await prisma.worklogEntry.updateMany({
    where: {
      epicKey,
      isDeleted: false,
      // Tập rỗng = lượt lấy đầy đủ không còn worklog nào sống → mọi dòng cũ đều
      // đã bị xoá. Bỏ HẲN điều kiện thay vì viết `notIn: []`: không phụ thuộc vào
      // cách Prisma diễn giải tập rỗng, và khớp đúng lối `markRemovedIssues` làm.
      ...(liveWorklogIds.size > 0 ? { worklogId: { notIn: [...liveWorklogIds] } } : {}),
    },
    data: { isDeleted: true },
  });
  return result.count;
}
