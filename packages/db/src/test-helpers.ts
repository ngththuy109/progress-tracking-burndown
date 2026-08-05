/**
 * Trợ giúp cho test cần PostgreSQL thật.
 *
 * Máy dev có thể chưa có PostgreSQL. Thay vì để test đỏ và người sau tắt nó đi,
 * ta BỎ QUA có kiểm soát và IN RA LÝ DO — còn CI luôn có service PostgreSQL nên
 * test vẫn chạy đầy đủ ở đó.
 *
 * Đặt `DATABASE_URL` trỏ tới một database dùng được là test sẽ tự chạy.
 */

let cached: boolean | undefined;

/** Có database dùng được không. Kiểm tra một lần rồi nhớ kết quả. */
export async function hasDatabase(): Promise<boolean> {
  if (cached !== undefined) return cached;

  const url = process.env['DATABASE_URL'];
  if (!url) {
    cached = false;
    return cached;
  }

  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$disconnect();
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

/**
 * Dùng thay `describe` cho nhóm test cần database.
 *
 * Không dùng `describe.skipIf` trần vì như vậy test bị bỏ qua im lặng — người
 * đọc kết quả sẽ tưởng chúng đã chạy và xanh.
 */
export const DB_SKIP_REASON =
  'Bỏ qua: chưa có DATABASE_URL dùng được. Đặt biến môi trường đó để chạy nhóm test này. CI luôn chạy đầy đủ.';
