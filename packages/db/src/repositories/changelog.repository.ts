import type { PrismaClient } from '../client.js';

/**
 * Ghi nhật ký thay đổi — PRD §4.2.
 *
 * Khoá tự nhiên là `(issue_key, jira_history_id, field_name)`: một lần đổi trên
 * Jira có thể chạm nhiều trường cùng lúc, nên `jira_history_id` một mình KHÔNG
 * đủ để phân biệt.
 */

export interface ChangelogUpsertRow {
  issueKey: string;
  jiraHistoryId: bigint;
  fieldName: string;
  fromValue: string | null;
  toValue: string | null;
  changedAt: Date;
  authorAccountId?: string | null;
}

export async function upsertChangelog(
  prisma: PrismaClient,
  rows: readonly ChangelogUpsertRow[],
): Promise<void> {
  if (rows.length === 0) return;

  for (const r of rows) {
    const data = {
      fromValue: r.fromValue,
      toValue: r.toValue,
      changedAt: r.changedAt,
      authorId: r.authorAccountId ?? null,
    };

    await prisma.issueChangelogEvent.upsert({
      where: {
        issueKey_jiraHistoryId_fieldName: {
          issueKey: r.issueKey,
          jiraHistoryId: r.jiraHistoryId,
          fieldName: r.fieldName,
        },
      },
      create: {
        issueKey: r.issueKey,
        jiraHistoryId: r.jiraHistoryId,
        fieldName: r.fieldName,
        ...data,
      },
      update: data,
    });
  }
}
