import { GLOBAL_ROLE, PROJECT_ROLE, type GlobalRole, type ProjectRole } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Người dùng ứng dụng — nguồn sự thật của phân quyền (PRD §9.3, mô hình SSO B1).
 *
 * Cổng SSO chỉ khẳng định DANH TÍNH; quyền tra ở DB. Từ multi-tenant, quyền có
 * HAI TẦNG: role toàn cục (`app_user.role`: ADMIN | MEMBER) và role trong từng
 * dự án (`project_member.role`: PM | VIEWER). API KHÔNG bao giờ tin `role` đến
 * từ header (xem apps/api/src/adapters/principal.ts).
 */

export interface AppUserRow {
  readonly userId: string;
  readonly role: GlobalRole;
  /** projectKey → role trong dự án đó. */
  readonly memberships: Readonly<Record<string, ProjectRole>>;
  readonly displayName: string | null;
}

/** Vai trò lạ trong DB (dữ liệu cũ, cấu hình tay sai) bị coi là KHÔNG hợp lệ. */
function isGlobalRole(v: string): v is GlobalRole {
  return (GLOBAL_ROLE as readonly string[]).includes(v);
}

function isProjectRole(v: string): v is ProjectRole {
  return (PROJECT_ROLE as readonly string[]).includes(v);
}

function toMemberships(
  rows: readonly { projectKey: string; role: string }[],
): Record<string, ProjectRole> {
  const out: Record<string, ProjectRole> = {};
  for (const m of rows) {
    // Role lạ trong project_member bị BỎ QUA (không âm thầm nâng thành gì cả).
    if (isProjectRole(m.role)) out[m.projectKey] = m.role;
  }
  return out;
}

/**
 * Tra một người dùng theo danh tính đã xác thực, kèm membership các dự án.
 *
 * Trả `null` khi chưa được cấp quyền HOẶC role trong DB không hợp lệ — cả hai
 * đều nghĩa là "không có quyền xác định", để tầng trên tự quyết (mặc định
 * MEMBER-không-dự-án hay từ chối). KHÔNG âm thầm nâng thành một vai trò nào đó.
 */
export async function findAppUser(prisma: PrismaClient, userId: string): Promise<AppUserRow | null> {
  const row = await prisma.appUser.findUnique({
    where: { userId },
    include: { memberships: { select: { projectKey: true, role: true } } },
  });
  if (row === null) return null;
  if (!isGlobalRole(row.role)) return null;
  return {
    userId: row.userId,
    role: row.role,
    memberships: toMemberships(row.memberships),
    displayName: row.displayName,
  };
}

export interface AppUserListRow {
  readonly userId: string;
  readonly role: GlobalRole;
  readonly displayName: string | null;
  readonly membershipCount: number;
}

/** Liệt kê mọi người dùng đã cấp quyền — cho màn hình quản trị. */
export async function listAppUsers(prisma: PrismaClient): Promise<AppUserListRow[]> {
  const rows = await prisma.appUser.findMany({
    orderBy: [{ role: 'asc' }, { userId: 'asc' }],
    include: { _count: { select: { memberships: true } } },
  });
  return rows
    .filter((r) => isGlobalRole(r.role))
    .map((r) => ({
      userId: r.userId,
      role: r.role as GlobalRole,
      displayName: r.displayName,
      membershipCount: r._count.memberships,
    }));
}

/** Gỡ quyền (membership rơi theo CASCADE). Trả `true` nếu có xoá. */
export async function deleteAppUser(prisma: PrismaClient, userId: string): Promise<boolean> {
  const res = await prisma.appUser.deleteMany({ where: { userId } });
  return res.count > 0;
}

export interface UpsertAppUserArgs {
  readonly userId: string;
  readonly role: GlobalRole;
  readonly displayName?: string | null;
}

/**
 * Cấp / cập nhật role TOÀN CỤC cho một người dùng — dùng để provision (script
 * quản trị, seed admin đầu tiên). Membership theo dự án quản ở
 * project-member.repository. Idempotent theo `userId`.
 */
export async function upsertAppUser(prisma: PrismaClient, args: UpsertAppUserArgs): Promise<void> {
  const displayName = args.displayName ?? null;
  await prisma.appUser.upsert({
    where: { userId: args.userId },
    create: { userId: args.userId, role: args.role, displayName },
    update: { role: args.role, displayName },
  });
}
