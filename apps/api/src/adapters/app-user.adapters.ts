import {
  deleteAppUser,
  findAppUser,
  listAppUsers,
  upsertAppUser,
  type PrismaClient,
} from '@app/db';
import type { UserRole } from '@app/shared';
import type { AppUserStore } from './principal.js';

/**
 * Bộ chuyển đổi cổng `AppUserStore` → Prisma (dùng khi phân giải principal).
 *
 * Một truy vấn theo khoá chính (`user_id`), chạy mỗi request có danh tính. Rẻ
 * và đã đánh index; nếu sau này lưu lượng lớn, thêm cache TTL ngắn ở đây là đủ
 * mà không phải đụng tới tầng phân giải principal.
 */
export function createAppUserStore(prisma: PrismaClient): AppUserStore {
  return {
    async find(userId) {
      const row = await findAppUser(prisma, userId);
      return row === null ? null : { role: row.role, projects: row.projects };
    },
  };
}

/** Một dòng người dùng như màn hình quản trị nhìn thấy. */
export interface AdminUserRow {
  readonly userId: string;
  readonly role: UserRole;
  readonly projects: readonly string[];
  readonly displayName: string | null;
}

/** Cổng ĐỌC/GHI danh sách người dùng — chỉ dùng cho nhóm API `/api/users`. */
export interface AppUserAdminStore {
  list(): Promise<readonly AdminUserRow[]>;
  upsert(row: {
    userId: string;
    role: UserRole;
    projects: readonly string[];
    displayName: string | null;
  }): Promise<void>;
  remove(userId: string): Promise<boolean>;
}

export function createAppUserAdminStore(prisma: PrismaClient): AppUserAdminStore {
  return {
    list: () => listAppUsers(prisma),
    upsert: (row) =>
      upsertAppUser(prisma, {
        userId: row.userId,
        role: row.role,
        projects: row.projects,
        displayName: row.displayName,
      }),
    remove: (userId) => deleteAppUser(prisma, userId),
  };
}
