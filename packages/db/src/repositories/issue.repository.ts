import type { Prisma, PrismaClient } from '../client.js';

/**
 * Ghi cây issue — PRD §4.2.
 *
 * MỌI thao tác ghi đều là UPSERT theo khoá tự nhiên (C-6): chạy job hai lần
 * liên tiếp phải cho ra dữ liệu byte-for-byte giống nhau.
 */

export interface IssueUpsertRow {
  issueKey: string;
  issueId: bigint;
  /** Tenant sở hữu — lấy từ tracked_epic của root, KHÔNG đoán theo prefix key. */
  projectKey: string;
  /** Vai trò trong cây: EPIC | TASK | SUBTASK | MIDDLE (xem schema.prisma). */
  issueType: string;
  /** Vị trí tầng thật: 0 = root, 1..depth. */
  tierIndex: number;
  parentKey: string | null;
  epicKey: string | null;
  summary: string;
  phaseCode: string | null;
  rawPhaseLabel: string | null;
  statusId: string;
  statusCategory: string;
  originalEstimateS: bigint;
  remainingEstimateS: bigint;
  timeSpentS: bigint;
  jiraCreatedAt: Date;
  jiraUpdatedAt: Date;
  wbsStartDate: Date | null;
  wbsEndDate: Date | null;
  sbProject: string | null;
  sbTeam: string | null;
  sbPhaseRaw: string | null;
  functionName: string | null;
  functionKey: string | null;
  taskType: string | null;
  sbTaskRaw: string | null;
  sbParseStatus: string;
}

/**
 * Ghi theo lô để tránh mở hàng trăm transaction nhỏ.
 *
 * Chèn cha trước con: `parent_key` là khoá ngoại trỏ vào chính bảng này, ghi
 * lẫn lộn thứ tự sẽ vi phạm ràng buộc.
 */
export async function upsertIssues(
  prisma: PrismaClient,
  rows: readonly IssueUpsertRow[],
): Promise<void> {
  if (rows.length === 0) return;

  // Chèn cha trước con theo VỊ TRÍ TẦNG thật (tier_index), không theo vai trò:
  // với cây sâu hơn 3 tầng, giữa EPIC và TASK còn các tầng MIDDLE.
  const sorted = [...rows].sort((a, b) => a.tierIndex - b.tierIndex);

  for (const r of sorted) {
    const data = {
      issueId: r.issueId,
      projectKey: r.projectKey,
      issueType: r.issueType,
      tierIndex: r.tierIndex,
      parentKey: r.parentKey,
      epicKey: r.epicKey,
      summary: r.summary,
      phaseCode: r.phaseCode,
      rawPhaseLabel: r.rawPhaseLabel,
      statusId: r.statusId,
      statusCategory: r.statusCategory,
      originalEstimateS: r.originalEstimateS,
      remainingEstimateS: r.remainingEstimateS,
      timeSpentS: r.timeSpentS,
      jiraCreatedAt: r.jiraCreatedAt,
      jiraUpdatedAt: r.jiraUpdatedAt,
      wbsStartDate: r.wbsStartDate,
      wbsEndDate: r.wbsEndDate,
      sbProject: r.sbProject,
      sbTeam: r.sbTeam,
      sbPhaseRaw: r.sbPhaseRaw,
      functionName: r.functionName,
      functionKey: r.functionKey,
      taskType: r.taskType,
      sbTaskRaw: r.sbTaskRaw,
      sbParseStatus: r.sbParseStatus,
      // Issue xuất hiện lại sau khi từng bị gỡ thì phải bỏ cờ, nếu không nó sẽ
      // vĩnh viễn bị coi là đã biến mất.
      removedAt: null,
    } satisfies Prisma.JiraIssueUncheckedUpdateInput;

    await prisma.jiraIssue.upsert({
      where: { issueKey: r.issueKey },
      create: { issueKey: r.issueKey, ...data } as Prisma.JiraIssueUncheckedCreateInput,
      update: data,
    });
  }
}

/**
 * Đánh dấu issue không còn thấy trên Jira.
 *
 * XOÁ MỀM, không xoá cứng: snapshot của những ngày trước khi gỡ vẫn phải nhìn
 * thấy issue này, nếu không biểu đồ lịch sử sẽ tự thay đổi trong quá khứ.
 */
export async function markRemovedIssues(
  prisma: PrismaClient,
  epicKey: string,
  liveKeys: ReadonlySet<string>,
  at: Date,
): Promise<number> {
  const result = await prisma.jiraIssue.updateMany({
    where: {
      epicKey,
      removedAt: null,
      ...(liveKeys.size > 0 ? { issueKey: { notIn: [...liveKeys] } } : {}),
    },
    data: { removedAt: at },
  });
  return result.count;
}

/** Ánh xạ `issueId` → `issueKey`, cần cho `/worklog/list` (chỉ trả về id). */
export async function knownIdToKey(
  prisma: PrismaClient,
  epicKey: string,
): Promise<ReadonlyMap<string, string>> {
  const rows = await prisma.jiraIssue.findMany({
    where: { epicKey },
    select: { issueId: true, issueKey: true },
  });
  return new Map(rows.map((r) => [String(r.issueId), r.issueKey]));
}
