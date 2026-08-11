import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from './client.js';

/**
 * Kiểm database đã áp đủ migration CHƯA — để CHẶN khởi động khi nó còn lạc hậu.
 *
 * VÌ SAO CÓ FILE NÀY: deploy mã mới nhưng quên `pnpm db:migrate` thì Prisma sẽ
 * truy vấn một cột/bảng chưa tồn tại → Postgres trả 42703 (undefined_column) /
 * 42P01 (undefined_table) → tầng route đổi thành `500 INTERNAL_ERROR` mờ mịt,
 * lặp lại trên TỪNG request. Đúng ca đã xảy ra: màn hình "Signboard columns"
 * gọi `GET /api/config/phase`, DB thiếu cột `signboard_column.side` (migration
 * `20260811000000_signboard_column_side` chưa áp) nên nổ 500 với message tiếng
 * Nhật bị mojibake — rất dễ chẩn nhầm thành "lỗi encoding".
 *
 * Kiểm NGAY lúc boot biến ca đó thành MỘT lỗi rõ, một lần, kèm đúng lệnh phải
 * chạy — cùng tinh thần "thà không chạy còn hơn chạy nửa vời" với phần kiểm env
 * và Redis ở điểm khởi động.
 *
 * "Đã áp" định nghĩa GIỐNG HỆT `tools/db/apply-migrations.mjs`: có tên trong
 * `_prisma_migrations` với `finished_at` KHÁC NULL. Giữ đồng nhất để guard chỉ
 * xanh khi và chỉ khi runner không còn gì để áp — tránh ca "guard bảo thiếu mà
 * runner bảo đủ".
 */

/**
 * Thư mục migration của Prisma, tính theo vị trí file NÀY.
 *
 * Gói `@app/db` chạy thẳng từ nguồn (không build ra `dist`): `package.json` trỏ
 * `main`/`exports` vào `src/index.ts`, các app chạy bằng `tsx`. Nên
 * `../prisma/migrations` từ thư mục `src` này luôn đúng ở cả dev lẫn production.
 */
export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations');
}

/**
 * Tên các migration trên đĩa: thư mục CÓ `migration.sql`, sắp theo tên.
 *
 * Tên bắt đầu bằng timestamp nên sort chuỗi ra đúng thứ tự thời gian — cùng cách
 * `apply-migrations.mjs` và Prisma xác định thứ tự áp.
 */
export function listMigrationDirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .filter((name) => existsSync(join(dir, name, 'migration.sql')))
    .sort();
}

/**
 * So đĩa với tập đã-áp, trả về các migration CHƯA áp (giữ thứ tự đĩa). HÀM THUẦN.
 *
 * Chỉ soi chiều "mã đi trước DB" (đĩa có mà DB chưa áp) — đây là chiều gây lỗi
 * cột/bảng thiếu. Chiều ngược lại (DB có migration mã không biết) là tình huống
 * khác, không thuộc phạm vi guard này.
 */
export function findPendingMigrations(
  onDisk: readonly string[],
  applied: ReadonlySet<string>,
): string[] {
  return onDisk.filter((name) => !applied.has(name));
}

/**
 * Đọc tên migration đã áp từ `_prisma_migrations`.
 *
 * Bảng chưa tồn tại (database trắng, chưa từng migrate) KHÔNG phải lỗi hạ tầng:
 * nghĩa là chưa áp gì → trả tập RỖNG, để guard kết luận "phải áp tất cả" thay vì
 * ném một lỗi thô khó hiểu.
 */
export async function fetchAppliedMigrationNames(prisma: PrismaClient): Promise<Set<string>> {
  try {
    const rows = await prisma.$queryRaw<
      { migration_name: string }[]
    >`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
    return new Set(rows.map((r) => r.migration_name));
  } catch (err) {
    if (isMissingMigrationsTable(err)) return new Set();
    throw err;
  }
}

/**
 * Có phải lỗi "bảng `_prisma_migrations` không tồn tại" không.
 *
 * Prisma (engine `client` + driver `pg`) bọc lỗi raw thành `P2010` và nhét lỗi
 * gốc vào `meta.driverAdapterError.cause` (`originalCode: '42P01'`,
 * `kind: 'TableDoesNotExist'`). Bắt cả dạng có cấu trúc lẫn dạng chuỗi để không
 * phụ thuộc một phiên bản Prisma cụ thể. Truy vấn ở trên CHỈ chạm
 * `_prisma_migrations` nên 42P01 từ nó chắc chắn là do bảng này vắng mặt.
 */
function isMissingMigrationsTable(err: unknown): boolean {
  const cause = (
    err as {
      meta?: { driverAdapterError?: { cause?: { originalCode?: string; kind?: string } } };
    }
  )?.meta?.driverAdapterError?.cause;
  if (cause?.originalCode === '42P01' || cause?.kind === 'TableDoesNotExist') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b42P01\b/.test(message) && /_prisma_migrations/i.test(message);
}

/** Lỗi khởi động khi database còn migration chưa áp — thông báo kèm ĐÚNG lệnh sửa. */
export class PendingMigrationsError extends Error {
  constructor(readonly pending: readonly string[]) {
    super(
      `Database còn ${pending.length} migration CHƯA áp: ${pending.join(', ')}. ` +
        'Chạy `pnpm db:migrate` trên môi trường này (đúng DATABASE_URL) rồi khởi động lại. ' +
        'Bỏ qua thì mọi truy vấn chạm cột/bảng mới sẽ nổ 500 INTERNAL_ERROR trên từng request.',
    );
    this.name = 'PendingMigrationsError';
  }
}

/**
 * CHẶN khởi động nếu database còn migration chưa áp.
 *
 * Không tìm thấy thư mục migrations (đóng gói lạ) thì KHÔNG báo động giả: bỏ qua
 * kiểm và trả về — chặn boot chỉ vì không TỰ kiểm được còn tệ hơn lỗi gốc. Nơi
 * gọi có thể log lý do qua `onSkip`.
 *
 * Ném `PendingMigrationsError` khi có migration chưa áp; để nguyên các lỗi khác
 * (DB không tới được…) truyền lên cho watchdog khởi động xử lý.
 */
export async function assertMigrationsApplied(
  prisma: PrismaClient,
  opts?: { migrationsDir?: string; onSkip?: (reason: string, dir: string) => void },
): Promise<void> {
  const dir = opts?.migrationsDir ?? defaultMigrationsDir();
  if (!existsSync(dir)) {
    opts?.onSkip?.('migrations-dir-not-found', dir);
    return;
  }
  const pending = findPendingMigrations(
    listMigrationDirNames(dir),
    await fetchAppliedMigrationNames(prisma),
  );
  if (pending.length > 0) throw new PendingMigrationsError(pending);
}
