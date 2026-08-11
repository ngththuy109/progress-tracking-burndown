import { PROJECT_ROLE, type ProjectRole } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Thành viên dự án — role RIÊNG trong từng dự án (multi-tenant).
 *
 * Đây là bảng quyết định "user X nhìn thấy dự án nào, làm được gì trong đó".
 * ADMIN toàn cục không cần dòng nào ở đây. Quản trị qua
 * /api/admin/projects/:projectKey/members.
 */

export interface ProjectMemberRow {
  readonly userId: string;
  readonly role: ProjectRole;
  readonly displayName: string | null;
  readonly addedBy: string;
  readonly addedAt: Date;
}

function isProjectRole(v: string): v is ProjectRole {
  return (PROJECT_ROLE as readonly string[]).includes(v);
}

export async function listMembers(
  prisma: PrismaClient,
  projectKey: string,
): Promise<ProjectMemberRow[]> {
  const rows = await prisma.projectMember.findMany({
    where: { projectKey },
    orderBy: [{ role: 'asc' }, { userId: 'asc' }],
    include: { user: { select: { displayName: true } } },
  });
  return rows
    .filter((r) => isProjectRole(r.role))
    .map((r) => ({
      userId: r.userId,
      role: r.role as ProjectRole,
      displayName: r.user.displayName,
      addedBy: r.addedBy,
      addedAt: r.addedAt,
    }));
}

export interface UpsertMemberArgs {
  readonly projectKey: string;
  readonly userId: string;
  readonly role: ProjectRole;
  readonly addedBy: string;
}

/**
 * Thêm/đổi role thành viên. TIỀN ĐIỀU KIỆN: user đã tồn tại ở `app_user`
 * (FK sẽ chặn nếu chưa — route đổi lỗi đó thành 400 "user chưa được cấp quyền").
 */
export async function upsertMember(prisma: PrismaClient, args: UpsertMemberArgs): Promise<void> {
  await prisma.projectMember.upsert({
    where: { projectKey_userId: { projectKey: args.projectKey, userId: args.userId } },
    create: {
      projectKey: args.projectKey,
      userId: args.userId,
      role: args.role,
      addedBy: args.addedBy,
    },
    update: { role: args.role },
  });
}

/** Gỡ thành viên khỏi dự án. Trả `true` nếu có xoá. */
export async function removeMember(
  prisma: PrismaClient,
  projectKey: string,
  userId: string,
): Promise<boolean> {
  const res = await prisma.projectMember.deleteMany({ where: { projectKey, userId } });
  return res.count > 0;
}
