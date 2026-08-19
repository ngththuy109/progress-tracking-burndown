import type { PrismaClient } from '../client.js';

/**
 * Bản "PM đã verify — thôi theo dõi" cho một cặp (member, ticket) ở màn Log work.
 *
 * Ghi theo khoá tự nhiên (account_id, issue_key) nên UPSERT/xoá đều idempotent
 * (C-6). `epic_key`/`project_key` denormalize để đọc theo tập Epic và kiểm quyền.
 */

export interface LogworkExemptionRecord {
  accountId: string;
  issueKey: string;
  exemptedBy: string;
  /** ISO timestamp. */
  exemptedAt: string;
}

export interface UpsertLogworkExemptionArgs {
  accountId: string;
  issueKey: string;
  epicKey: string;
  projectKey: string;
  exemptedBy: string;
  note: string | null;
}

export async function listExemptionsForEpics(
  prisma: PrismaClient,
  epicKeys: readonly string[],
): Promise<LogworkExemptionRecord[]> {
  if (epicKeys.length === 0) return [];
  const rows = await prisma.logworkExemption.findMany({
    where: { epicKey: { in: [...epicKeys] } },
    select: { accountId: true, issueKey: true, exemptedBy: true, exemptedAt: true },
  });
  return rows.map((r) => ({
    accountId: r.accountId,
    issueKey: r.issueKey,
    exemptedBy: r.exemptedBy,
    exemptedAt: r.exemptedAt.toISOString(),
  }));
}

/** Đánh dấu — có rồi thì cập nhật (không ném lỗi trùng khoá). */
export async function upsertExemption(
  prisma: PrismaClient,
  args: UpsertLogworkExemptionArgs,
): Promise<void> {
  await prisma.logworkExemption.upsert({
    where: { accountId_issueKey: { accountId: args.accountId, issueKey: args.issueKey } },
    create: {
      accountId: args.accountId,
      issueKey: args.issueKey,
      epicKey: args.epicKey,
      projectKey: args.projectKey,
      exemptedBy: args.exemptedBy,
      note: args.note,
    },
    update: {
      epicKey: args.epicKey,
      projectKey: args.projectKey,
      exemptedBy: args.exemptedBy,
      note: args.note,
    },
  });
}

/** Gỡ đánh dấu — không có thì thôi (idempotent), không ném lỗi. */
export async function deleteExemption(
  prisma: PrismaClient,
  accountId: string,
  issueKey: string,
): Promise<void> {
  await prisma.logworkExemption.deleteMany({ where: { accountId, issueKey } });
}
