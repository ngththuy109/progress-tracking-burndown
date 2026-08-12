import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export { PrismaClient };
// Value export (không phải `export type`): `Prisma` là namespace CÓ giá trị runtime
// (`Prisma.DbNull`, `Prisma.JsonNull`…) cần khi ghi cột JSONB nullable. Mọi nơi dùng
// nó như KIỂU vẫn `import type { Prisma }` như cũ — không phá vỡ gì.
export { Prisma } from '@prisma/client';

/**
 * Tạo một `PrismaClient` chạy qua **driver adapter `pg`** thay cho native query
 * engine.
 *
 * Vì sao: engine mặc định của Prisma là binary Rust tải từ CDN
 * (`binaries.prisma.sh`) lúc `postinstall`/`prisma generate`. Máy chặn mạng ra
 * ngoài không tải được → cài đặt và sinh client cùng chết. Schema đã đặt
 * `engineType = "client"`: Prisma biên dịch truy vấn bằng query compiler WASM
 * (đóng gói sẵn trong `@prisma/client`, không tải gì) và thực thi qua driver
 * `pg` thuần JavaScript — KHÔNG cần binary native.
 *
 * Ràng buộc đi kèm: engine "client" BẮT BUỘC `new PrismaClient()` nhận
 * `adapter`; client trần sẽ ném lỗi lúc chạy. Vì thế mọi nơi đều đi qua hàm này
 * (và `getPrisma()`), không tự `new PrismaClient()`.
 */
export function createPrismaClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    // Cùng tinh thần với README: thiếu hạ tầng thì dừng sớm với thông báo rõ,
    // đừng để lỗi nổ mơ hồ ở tận trong tầng adapter.
    throw new Error('Thiếu DATABASE_URL — không thể khởi tạo PrismaClient.');
  }
  // Engine native của Prisma đọc `?schema=` trong URL để đặt search_path; driver
  // `pg` lại bỏ qua tham số đó. Tự bóc ra rồi truyền vào adapter để giữ NGUYÊN
  // hành vi cũ (mặc định `public` khi URL không ghi).
  const adapter = new PrismaPg({ connectionString }, { schema: schemaFromUrl(connectionString) });
  return new PrismaClient({ adapter });
}

function schemaFromUrl(connectionString: string): string {
  try {
    return new URL(connectionString).searchParams.get('schema') ?? 'public';
  } catch {
    return 'public';
  }
}

/**
 * Prisma client dùng chung.
 *
 * BigInt: Prisma trả cột `BIGINT` thành `BigInt` của JavaScript, không phải
 * `number` — và `JSON.stringify` sẽ NÉM LỖI với BigInt. Repository phải đổi
 * sang `number` khi đọc ra (giá trị giây không bao giờ vượt
 * `Number.MAX_SAFE_INTEGER` ≈ 285 triệu năm).
 *
 * Xem `toSeconds()` bên dưới.
 */
let singleton: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  singleton ??= createPrismaClient();
  return singleton;
}

export async function disconnectPrisma(): Promise<void> {
  await singleton?.$disconnect();
  singleton = undefined;
}

/**
 * Đổi giá trị `BIGINT` của Prisma sang `number`.
 *
 * Dùng ở BIÊN của repository, không rải rác khắp nơi (CONVENTIONS.md C-3).
 * Bỏ bước này thì `JSON.stringify` ở tầng API sẽ ném
 * "Do not know how to serialize a BigInt" — lỗi nổ xa chỗ gây ra.
 */
export function toSeconds(v: bigint | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Đổi `DATE` của Prisma sang chuỗi 'YYYY-MM-DD' (CONVENTIONS.md C-1). */
export function toDateString(v: Date | null | undefined): string | null {
  if (!v) return null;
  // Cột DATE của PostgreSQL không có giờ; Prisma trả về Date ở UTC midnight,
  // nên cắt phần ngày theo UTC là đúng. KHÔNG dùng toLocaleDateString.
  return v.toISOString().slice(0, 10);
}

/** Đổi chuỗi 'YYYY-MM-DD' sang Date cho cột `DATE`. */
export function fromDateString(v: string | null | undefined): Date | null {
  if (!v) return null;
  return new Date(`${v}T00:00:00.000Z`);
}
