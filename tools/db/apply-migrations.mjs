#!/usr/bin/env node
/**
 * Áp migration mà KHÔNG cần native binary của Prisma.
 *
 * `prisma migrate deploy` cần "schema engine" — một binary Rust tải từ CDN
 * (`binaries.prisma.sh`). Máy dev chặn mạng ra ngoài không tải được, nên lệnh
 * đó chết y hệt như `prisma generate` với query engine.
 *
 * Nhưng file migration của Prisma vốn là SQL thuần. Script này đọc lần lượt các
 * `migration.sql` rồi chạy qua driver `pg` (đã là dependency vì client cũng
 * dùng nó — xem packages/db/src/client.ts). Không tải gì, không binary native.
 *
 * Ghi nhận vào đúng bảng `_prisma_migrations` của Prisma, với checksum SHA-256
 * tính giống hệt Prisma, nên khi nào có mạng chạy `prisma migrate status` vẫn
 * thấy khớp — không báo "migration đã sửa" hay bắt áp lại.
 *
 * Dùng: `pnpm db:migrate` (đọc DATABASE_URL từ môi trường hoặc file .env).
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const migrationsDir = join(repoRoot, 'packages', 'db', 'prisma', 'migrations');

/**
 * Lấy DATABASE_URL: ưu tiên biến môi trường (CI đặt sẵn), nếu không có thì đọc
 * từ `.env` ở gốc repo. Không kéo thêm thư viện dotenv — chỉ cần một dòng.
 */
function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const envPath = join(repoRoot, '.env');
  if (!existsSync(envPath)) return undefined;

  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const match = rawLine.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[1].trim();
    // Bỏ dấu ngoặc bao quanh nếu có (`.env.example` để trong ngoặc kép).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

/** Prisma tính checksum = SHA-256 (hex) của nội dung file migration.sql. */
function checksumOf(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

// Cấu trúc bảng đúng như Prisma tự tạo, để tương thích hai chiều với CLI.
const CREATE_TRACKING_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id"                  VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum"            VARCHAR(64) NOT NULL,
  "finished_at"         TIMESTAMPTZ,
  "migration_name"      VARCHAR(255) NOT NULL,
  "logs"                TEXT,
  "rolled_back_at"      TIMESTAMPTZ,
  "started_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);
`;

async function main() {
  const databaseUrl = loadDatabaseUrl();
  if (!databaseUrl) {
    console.error('✖ Thiếu DATABASE_URL — đặt biến môi trường hoặc điền vào .env.');
    process.exit(1);
  }

  if (!existsSync(migrationsDir)) {
    console.error(`✖ Không thấy thư mục migrations: ${migrationsDir}`);
    process.exit(1);
  }

  const migrationNames = readdirSync(migrationsDir)
    .filter((name) => statSync(join(migrationsDir, name)).isDirectory())
    .filter((name) => existsSync(join(migrationsDir, name, 'migration.sql')))
    // Tên bắt đầu bằng timestamp (20260803000000_init…) → sort chuỗi ra đúng
    // thứ tự thời gian, cũng chính là thứ tự Prisma áp.
    .sort();

  if (migrationNames.length === 0) {
    console.error(`✖ Không có migration nào trong ${migrationsDir}`);
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(CREATE_TRACKING_TABLE);

    const done = new Set(
      (
        await client.query(
          'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
        )
      ).rows.map((row) => row.migration_name),
    );

    let applied = 0;
    for (const name of migrationNames) {
      if (done.has(name)) {
        console.log(`•  bỏ qua (đã áp): ${name}`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
      process.stdout.write(`→  áp: ${name} … `);

      // Mỗi migration chạy trong MỘT transaction: lỗi giữa chừng thì cuộn lại
      // sạch, không để database mắc kẹt nửa vời.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO "_prisma_migrations"
             (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
           VALUES ($1, $2, $3, now(), now(), 1)`,
          [randomUUID(), checksumOf(sql), name],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('LỖI');
        throw err;
      }
      console.log('xong');
      applied += 1;
    }

    console.log(
      applied === 0
        ? '✔ Database đã ở bản mới nhất — không có migration nào phải áp.'
        : `✔ Đã áp ${applied} migration.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n✖ Áp migration thất bại:');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
