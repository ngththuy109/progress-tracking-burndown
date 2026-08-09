import { USER_ROLE, type UserRole } from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Người dùng ứng dụng — nguồn sự thật của phân quyền (PRD §9.3, mô hình SSO B1).
 *
 * Cổng SSO chỉ khẳng định DANH TÍNH; role/projects tra ở bảng `app_user` này.
 * API KHÔNG bao giờ tin `role` đến từ header (xem apps/api/src/adapters/principal.ts).
 */

export interface AppUserRow {
  readonly userId: string;
  readonly role: UserRole;
  readonly projects: readonly string[];
  readonly displayName: string | null;
}

/** Vai trò lạ trong DB (dữ liệu cũ, cấu hình tay sai) bị coi là KHÔNG hợp lệ. */
function isRole(v: string): v is UserRole {
  return (USER_ROLE as readonly string[]).includes(v);
}

/**
 * Tra một người dùng theo danh tính đã xác thực.
 *
 * Trả `null` khi chưa được cấp quyền HOẶC role trong DB không hợp lệ — cả hai
 * đều nghĩa là "không có quyền xác định", để tầng trên tự quyết (mặc định
 * VIEWER hay từ chối). KHÔNG âm thầm nâng thành một vai trò nào đó.
 */
export async function findAppUser(prisma: PrismaClient, userId: string): Promise<AppUserRow | null> {
  const row = await prisma.appUser.findUnique({ where: { userId } });
  if (row === null) return null;
  if (!isRole(row.role)) return null;
  return {
    userId: row.userId,
    role: row.role,
    projects: row.projects,
    displayName: row.displayName,
  };
}

/** Liệt kê mọi người dùng đã cấp quyền — cho màn hình quản trị. */
export async function listAppUsers(prisma: PrismaClient): Promise<AppUserRow[]> {
  const rows = await prisma.appUser.findMany({ orderBy: [{ role: 'asc' }, { userId: 'asc' }] });
  return rows
    .filter((r) => isRole(r.role))
    .map((r) => ({
      userId: r.userId,
      role: r.role as UserRole,
      projects: r.projects,
      displayName: r.displayName,
    }));
}

/** Gỡ quyền. Trả `true` nếu có xoá, `false` nếu vốn không tồn tại. */
export async function deleteAppUser(prisma: PrismaClient, userId: string): Promise<boolean> {
  const res = await prisma.appUser.deleteMany({ where: { userId } });
  return res.count > 0;
}

export interface UpsertAppUserArgs {
  readonly userId: string;
  readonly role: UserRole;
  readonly projects?: readonly string[];
  readonly displayName?: string | null;
}

/**
 * Cấp / cập nhật quyền cho một người dùng — dùng để provision (script quản trị,
 * seed admin đầu tiên). Idempotent theo `userId`.
 */
export async function upsertAppUser(prisma: PrismaClient, args: UpsertAppUserArgs): Promise<void> {
  const projects = [...(args.projects ?? [])];
  const displayName = args.displayName ?? null;
  await prisma.appUser.upsert({
    where: { userId: args.userId },
    create: { userId: args.userId, role: args.role, projects, displayName },
    update: { role: args.role, projects, displayName },
  });
}
