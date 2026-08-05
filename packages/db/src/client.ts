import { PrismaClient } from '@prisma/client';

export { PrismaClient };
export type { Prisma } from '@prisma/client';

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
  singleton ??= new PrismaClient();
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
