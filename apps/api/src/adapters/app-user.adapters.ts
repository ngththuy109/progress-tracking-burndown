import { findAppUser, type PrismaClient } from '@app/db';
import type { AppUserStore } from './principal.js';

/**
 * Bộ chuyển đổi cổng `AppUserStore` → Prisma.
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
