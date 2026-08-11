import { Prisma } from '@prisma/client';
import type { ProjectStatus } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Project — GỐC TENANT của multi-tenant (không còn là picklist thuần).
 *
 * Mỗi project tự chứa kết nối Jira riêng (token đã mã hóa — cột `jiraTokenEnc`
 * KHÔNG BAO GIỜ rời khỏi tầng adapter dưới dạng plaintext, và không bao giờ
 * xuất hiện trong response API), cấu trúc phân tầng (`hierarchyDepth`) và danh
 * sách thành viên. `project_key` là key Jira, chữ HOA (PAY, CRM), duy nhất
 * toàn hệ thống.
 */

export interface ProjectRow {
  readonly projectKey: string;
  readonly displayName: string | null;
  readonly status: ProjectStatus;
  readonly jiraBaseUrl: string | null;
  readonly jiraEmail: string | null;
  readonly hasJiraToken: boolean;
  readonly hierarchyDepth: number;
  readonly timezone: string;
  readonly defaultCalendarId: string | null;
  readonly memberCount: number;
}

/**
 * Row đầy đủ cho tầng kết nối Jira (client registry) — chứa cả token mã hóa và
 * fields config. KHÔNG dùng cho response API.
 */
export interface ProjectConnectionRow {
  readonly projectKey: string;
  readonly status: ProjectStatus;
  readonly jiraBaseUrl: string | null;
  readonly jiraEmail: string | null;
  readonly jiraTokenEnc: string | null;
  readonly jiraFieldsJson: unknown;
  readonly jiraResolvedJson: unknown;
  readonly hierarchyDepth: number;
  readonly timezone: string;
}

function toStatus(v: string): ProjectStatus {
  return v === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE';
}

export async function listProjects(prisma: PrismaClient): Promise<ProjectRow[]> {
  const rows = await prisma.project.findMany({
    orderBy: { projectKey: 'asc' },
    include: { _count: { select: { members: true } } },
  });
  return rows.map((r) => ({
    projectKey: r.projectKey,
    displayName: r.displayName,
    status: toStatus(r.status),
    jiraBaseUrl: r.jiraBaseUrl,
    jiraEmail: r.jiraEmail,
    hasJiraToken: r.jiraTokenEnc !== null,
    hierarchyDepth: r.hierarchyDepth,
    timezone: r.timezone,
    defaultCalendarId: r.defaultCalendarId,
    memberCount: r._count.members,
  }));
}

export async function findProject(
  prisma: PrismaClient,
  projectKey: string,
): Promise<ProjectRow | null> {
  const r = await prisma.project.findUnique({
    where: { projectKey },
    include: { _count: { select: { members: true } } },
  });
  if (r === null) return null;
  return {
    projectKey: r.projectKey,
    displayName: r.displayName,
    status: toStatus(r.status),
    jiraBaseUrl: r.jiraBaseUrl,
    jiraEmail: r.jiraEmail,
    hasJiraToken: r.jiraTokenEnc !== null,
    hierarchyDepth: r.hierarchyDepth,
    timezone: r.timezone,
    defaultCalendarId: r.defaultCalendarId,
    memberCount: r._count.members,
  };
}

/**
 * Row kết nối cho client registry / sync. Trả cả token MÃ HÓA — người gọi tự
 * giải mã bằng secret-box; không cache plaintext ở đâu ngoài bộ nhớ tiến trình.
 */
export async function findProjectConnection(
  prisma: PrismaClient,
  projectKey: string,
): Promise<ProjectConnectionRow | null> {
  const r = await prisma.project.findUnique({ where: { projectKey } });
  if (r === null) return null;
  return {
    projectKey: r.projectKey,
    status: toStatus(r.status),
    jiraBaseUrl: r.jiraBaseUrl,
    jiraEmail: r.jiraEmail,
    jiraTokenEnc: r.jiraTokenEnc,
    jiraFieldsJson: r.jiraFieldsJson ?? null,
    jiraResolvedJson: r.jiraResolvedJson ?? null,
    hierarchyDepth: r.hierarchyDepth,
    timezone: r.timezone,
  };
}

/** Tập key đã đăng ký — để kiểm thao tác chỉ nhắm vào project có thật. */
export async function projectKeySet(prisma: PrismaClient): Promise<Set<string>> {
  const rows = await prisma.project.findMany({ select: { projectKey: true } });
  return new Set(rows.map((r) => r.projectKey));
}

export interface UpsertProjectArgs {
  readonly projectKey: string;
  readonly displayName: string | null;
  readonly status?: ProjectStatus;
  readonly hierarchyDepth?: number;
  readonly timezone?: string;
  readonly defaultCalendarId?: string | null;
}

export async function upsertProject(prisma: PrismaClient, args: UpsertProjectArgs): Promise<void> {
  const patch = {
    displayName: args.displayName,
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.hierarchyDepth !== undefined ? { hierarchyDepth: args.hierarchyDepth } : {}),
    ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
    ...(args.defaultCalendarId !== undefined ? { defaultCalendarId: args.defaultCalendarId } : {}),
  };
  await prisma.project.upsert({
    where: { projectKey: args.projectKey },
    create: { projectKey: args.projectKey, ...patch },
    update: patch,
  });
}

export interface UpdateProjectJiraArgs {
  readonly jiraBaseUrl: string | null;
  readonly jiraEmail: string | null;
  /**
   * Token ĐÃ MÃ HÓA (seal xong ở tầng gọi):
   *   - chuỗi   → ghi đè;
   *   - null    → xóa token (quay về fallback env);
   *   - undefined → giữ nguyên token cũ.
   */
  readonly jiraTokenEnc?: string | null;
  readonly jiraFieldsJson: unknown;
  /** Ghi khi "Test connection" resolve xong field mapping; null = xóa bản cũ. */
  readonly jiraResolvedJson?: unknown;
}

/** Trả `false` nếu project không tồn tại (route đổi thành 404). */
export async function updateProjectJira(
  prisma: PrismaClient,
  projectKey: string,
  args: UpdateProjectJiraArgs,
): Promise<boolean> {
  const res = await prisma.project.updateMany({
    where: { projectKey },
    data: {
      jiraBaseUrl: args.jiraBaseUrl,
      jiraEmail: args.jiraEmail,
      ...(args.jiraTokenEnc !== undefined ? { jiraTokenEnc: args.jiraTokenEnc } : {}),
      // Prisma từ chối `null` trần cho cột Json (hiểu nhầm JSON null) → DbNull.
      jiraFieldsJson: args.jiraFieldsJson === null ? Prisma.DbNull : (args.jiraFieldsJson as Prisma.InputJsonValue),
      ...(args.jiraResolvedJson !== undefined
        ? {
            jiraResolvedJson:
              args.jiraResolvedJson === null
                ? Prisma.DbNull
                : (args.jiraResolvedJson as Prisma.InputJsonValue),
          }
        : {}),
    },
  });
  return res.count > 0;
}

/** Bỏ project. Trả `true` nếu có xoá, `false` nếu vốn không có. */
export async function deleteProject(prisma: PrismaClient, projectKey: string): Promise<boolean> {
  const res = await prisma.project.deleteMany({ where: { projectKey } });
  return res.count > 0;
}
