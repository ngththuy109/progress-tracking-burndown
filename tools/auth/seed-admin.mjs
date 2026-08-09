#!/usr/bin/env node
/**
 * Seed admin đầu tiên — CHẠY TỰ ĐỘNG KHI DEPLOY. Idempotent: chạy lại mỗi lần
 * deploy đều vô hại. Cấu hình đọc từ ENV, KHÔNG hardcode credential vào repo.
 *
 *   SEED_ADMIN_EMAIL     bắt buộc để làm gì; CHƯA ĐẶT → bỏ qua, exit 0
 *                        (an toàn khi để sẵn bước này trong pipeline mà chưa cấu hình)
 *   SEED_ADMIN_PASSWORD  tuỳ chọn → tạo thêm login Basic Auth (htpasswd)
 *   SEED_ADMIN_HTPASSWD  đường dẫn file htpasswd (mặc định /etc/nginx/burndown.htpasswd)
 *   DATABASE_URL         để ghi vai trò vào app_user
 *
 * Việc làm:
 *   1. Đảm bảo app_user có một dòng ADMIN cho email (upsert — idempotent).
 *      ADMIN đã là toàn quyền; không cần gán project.
 *   2. Nếu có SEED_ADMIN_PASSWORD: đảm bảo login htpasswd — nhưng BỎ QUA nếu user
 *      đã có trong file (không reset mật khẩu mỗi lần deploy).
 *
 * Đặt SAU `pnpm db:migrate` trong bước release/deploy:
 *   pnpm db:migrate && pnpm seed:admin
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(`[seed-admin] ${m}`);

/** Có lệnh htpasswd (hỗ trợ bcrypt) không — probe không đụng file. */
function htpasswdAvailable() {
  try {
    execFileSync('htpasswd', ['-nbB', 'probe', 'probe'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** User đã có dòng trong file htpasswd chưa (khớp tiền tố "user:"). */
function userInHtpasswd(file, user) {
  const prefix = `${user}:`;
  return readFileSync(file, 'utf8')
    .split('\n')
    .some((line) => line.startsWith(prefix));
}

function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (email === '') {
    log('SEED_ADMIN_EMAIL chưa đặt — bỏ qua (không có admin nào để seed).');
    return;
  }

  // 1) Vai trò ADMIN trong app_user (idempotent). Tái dùng grant-role.mjs để
  //    dùng chung một đường ghi/kiểm.
  log(`Đảm bảo vai trò ADMIN cho ${email} …`);
  execFileSync(
    process.execPath,
    [join(scriptDir, 'grant-role.mjs'), '--user', email, '--role', 'ADMIN'],
    { stdio: 'inherit' },
  );

  // 2) Login Basic Auth — chỉ khi có mật khẩu (dùng SSO thì không cần).
  const password = process.env.SEED_ADMIN_PASSWORD ?? '';
  if (password === '') {
    log('SEED_ADMIN_PASSWORD chưa đặt — bỏ qua bước htpasswd (SSO không cần login riêng).');
    return;
  }

  const file = (process.env.SEED_ADMIN_HTPASSWD ?? '/etc/nginx/burndown.htpasswd').trim();

  if (existsSync(file) && userInHtpasswd(file, email)) {
    log(`Login htpasswd cho ${email} đã có trong ${file} — giữ nguyên (không reset mật khẩu).`);
    return;
  }
  if (!htpasswdAvailable()) {
    log(
      `⚠ Có SEED_ADMIN_PASSWORD nhưng thiếu lệnh htpasswd — BỎ QUA login (vai trò đã seed). ` +
        `Cài apache2-utils/httpd-tools trong image deploy, hoặc thêm dòng htpasswd tay.`,
    );
    return;
  }

  const create = existsSync(file) ? [] : ['-c'];
  execFileSync('htpasswd', ['-i', '-B', ...create, file, email], {
    input: `${password}\n`,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  log(`Đã tạo login htpasswd cho ${email} trong ${file}${create.length ? ' (file mới)' : ''}.`);
}

try {
  main();
} catch (err) {
  // Lỗi từ tiến trình con (grant-role/htpasswd) đã tự in nguyên nhân qua stderr;
  // ở đây chỉ cần một dòng gọn, không đổ nguyên stack vào log deploy.
  console.error('[seed-admin] ✖ Thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
}
