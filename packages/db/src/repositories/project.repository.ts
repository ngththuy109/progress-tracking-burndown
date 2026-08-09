import type { PrismaClient } from '../client.js';

/**
 * Danh mục Project do Admin quản lý (dùng để gán PM).
 *
 * Không phải mọi project trên Jira — chỉ những project Admin chủ động đăng ký để
 * gán quyền. `project_key` là key Jira, chữ HOA (PAY, CRM).
 */

export interface ProjectRow {
  readonly projectKey: string;
  readonly displayName: string | null;
}

export async function listProjects(prisma: PrismaClient): Promise<ProjectRow[]> {
  const rows = await prisma.project.findMany({ orderBy: { projectKey: 'asc' } });
  return rows.map((r) => ({ projectKey: r.projectKey, displayName: r.displayName }));
}

/** Tập key đã đăng ký — để kiểm PM chỉ được gán project có thật. */
export async function projectKeySet(prisma: PrismaClient): Promise<Set<string>> {
  const rows = await prisma.project.findMany({ select: { projectKey: true } });
  return new Set(rows.map((r) => r.projectKey));
}

export async function upsertProject(
  prisma: PrismaClient,
  args: { projectKey: string; displayName: string | null },
): Promise<void> {
  await prisma.project.upsert({
    where: { projectKey: args.projectKey },
    create: { projectKey: args.projectKey, displayName: args.displayName },
    update: { displayName: args.displayName },
  });
}

/** Bỏ project khỏi danh mục. Trả `true` nếu có xoá, `false` nếu vốn không có. */
export async function deleteProject(prisma: PrismaClient, projectKey: string): Promise<boolean> {
  const res = await prisma.project.deleteMany({ where: { projectKey } });
  return res.count > 0;
}
