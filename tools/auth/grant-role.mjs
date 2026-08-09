#!/usr/bin/env node
/**
 * Cấp / cập nhật vai trò cho một người dùng trong bảng `app_user`.
 *
 * Mô hình SSO B1: cổng xác thực DANH TÍNH, còn AI-được-làm-gì tra ở `app_user`.
 * Admin đầu tiên nên mồi bằng env AUTH_BOOTSTRAP_ADMINS; script này để cấp cho
 * những người còn lại (đặc biệt PM kèm danh sách project phụ trách).
 *
 * Dùng driver `pg` trực tiếp — KHÔNG cần native binary của Prisma (giống
 * tools/db/apply-migrations.mjs), nên chạy được cả ở môi trường chặn mạng.
 *
 * Ví dụ:
 *   pnpm auth:grant --user pm@cty.com --role PM --projects PAY,CRM
 *   pnpm auth:grant --user boss@cty.com --role ADMIN
 *   pnpm auth:grant --user ai@cty.com --role VIEWER --name "Nguyễn A"
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const ROLES = ['ADMIN', 'PM', 'VIEWER'];

/** Đọc cờ dạng `--key value` thành object. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true';
    out[key] = value;
  }
  return out;
}

/** DATABASE_URL: ưu tiên env, không có thì đọc `.env` ở gốc repo (như apply-migrations). */
function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const envPath = join(repoRoot, '.env');
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return undefined;
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const userId = (args.user ?? '').trim().toLowerCase();
  const role = (args.role ?? '').trim().toUpperCase();
  // Key project chuẩn hoá về chữ HOA để khớp danh mục `project`.
  const projects =
    args.projects && args.projects !== 'true'
      ? args.projects.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s !== '')
      : [];
  const displayName = args.name && args.name !== 'true' ? args.name : null;

  if (userId === '') fail('Thiếu --user <email>.');
  if (!ROLES.includes(role)) fail(`--role phải là một trong: ${ROLES.join(', ')} (nhận "${role}").`);
  if (role !== 'PM' && projects.length > 0) {
    fail('--projects chỉ có nghĩa với --role PM (ADMIN/VIEWER thấy tất cả).');
  }

  const databaseUrl = loadDatabaseUrl();
  if (!databaseUrl) fail('Thiếu DATABASE_URL — đặt biến môi trường hoặc điền vào .env.');

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // PM chỉ được gán vào project ĐÃ ĐĂNG KÝ (giống ràng buộc của API), để không
    // gõ nhầm key gây mất quyền xem trong im lặng.
    if (role === 'PM' && projects.length > 0) {
      const { rows } = await client.query(
        'SELECT project_key FROM "project" WHERE project_key = ANY($1)',
        [projects],
      );
      const known = new Set(rows.map((r) => r.project_key));
      const unknown = projects.filter((p) => !known.has(p));
      if (unknown.length > 0) {
        throw new Error(
          `Project chưa đăng ký: ${unknown.join(', ')}. ` +
            'Thêm vào danh mục trước (màn hình Projects, hoặc INSERT vào bảng "project").',
        );
      }
    }

    await client.query(
      `INSERT INTO "app_user" ("user_id", "role", "projects", "display_name", "updated_at")
         VALUES ($1, $2, $3, $4, now())
       ON CONFLICT ("user_id")
         DO UPDATE SET "role" = EXCLUDED."role",
                       "projects" = EXCLUDED."projects",
                       "display_name" = EXCLUDED."display_name",
                       "updated_at" = now()`,
      [userId, role, projects, displayName],
    );
    const label = role === 'PM' ? `PM (${projects.join(', ') || 'chưa gán project'})` : role;
    console.log(`✔ Đã cấp ${label} cho ${userId}.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n✖ Cấp quyền thất bại:');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
