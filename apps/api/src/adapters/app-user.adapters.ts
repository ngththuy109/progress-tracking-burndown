import {
  deleteAppUser,
  findAppUser,
  listAppUsers,
  upsertAppUser,
  type PrismaClient,
} from '@app/db';
import type { GlobalRole } from '@app/shared';
import type { AppUserStore } from './principal.js';

/**
 * Bộ chuyển đổi cổng `AppUserStore` → Prisma (dùng khi phân giải principal).
 *
 * Một truy vấn theo khoá chính (`user_id`) kèm join membership, chạy mỗi request
 * có danh tính. Rẻ và đã đánh index; nếu sau này lưu lượng lớn, thêm cache TTL
 * ngắn ở đây là đủ mà không phải đụng tới tầng phân giải principal.
 */
export function createAppUserStore(prisma: PrismaClient): AppUserStore {
  return {
    async find(userId) {
      const row = await findAppUser(prisma, userId);
      return row === null ? null : { role: row.role, memberships: row.memberships };
    },
  };
}

/** Một dòng người dùng như màn hình quản trị nhìn thấy. */
export interface AdminUserRow {
  readonly userId: string;
  readonly role: GlobalRole;
  readonly displayName: string | null;
  /** Số dự án user là thành viên — chi tiết quản ở /api/admin/projects/:key/members. */
  readonly membershipCount: number;
}

/** Cổng ĐỌC/GHI danh sách người dùng — chỉ dùng cho nhóm API `/api/admin/users`. */
export interface AppUserAdminStore {
  list(): Promise<readonly AdminUserRow[]>;
  upsert(row: { userId: string; role: GlobalRole; displayName: string | null }): Promise<void>;
  remove(userId: string): Promise<boolean>;
}

export function createAppUserAdminStore(prisma: PrismaClient): AppUserAdminStore {
  return {
    list: () => listAppUsers(prisma),
    upsert: (row) =>
      upsertAppUser(prisma, {
        userId: row.userId,
        role: row.role,
        displayName: row.displayName,
      }),
    remove: (userId) => deleteAppUser(prisma, userId),
  };
}
