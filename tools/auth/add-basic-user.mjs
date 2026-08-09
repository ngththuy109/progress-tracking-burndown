#!/usr/bin/env node
/**
 * Thêm một người dùng để test qua Basic Auth — GỘP hai việc:
 *   (a) tạo/đổi mật khẩu đăng nhập trong file htpasswd của nginx, VÀ
 *   (b) cấp vai trò trong bảng `app_user` (gọi lại `grant-role.mjs`, nên tái dùng
 *       nguyên kiểm tra: role hợp lệ + PM chỉ nhận project ĐÃ ĐĂNG KÝ).
 *
 * Username htpasswd = EMAIL (chữ thường) để khớp `app_user.user_id` — nginx đặt
 * `x-user-id = $remote_user`, resolver hạ chữ thường rồi tra `app_user`.
 *
 * Ví dụ:
 *   pnpm auth:testuser --user pm@cty.com --role PM --projects PAY,CRM
 *   pnpm auth:testuser --user viewer@cty.com                       # mặc định VIEWER
 *   pnpm auth:testuser --user boss@cty.com --role ADMIN --password 'S3cret!'
 *   pnpm auth:testuser --user a@cty.com --htpasswd ./burndown.htpasswd  # file khác
 *
 * Cần: lệnh `htpasswd` (gói apache2-utils / httpd-tools) và DATABASE_URL (bước b).
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_HTPASSWD = '/etc/nginx/burndown.htpasswd';
const scriptDir = dirname(fileURLToPath(import.meta.url));

/** Đọc cờ dạng `--key value` thành object (giống grant-role.mjs). */
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

const opt = (v) => (v && v !== 'true' ? v : null);

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

/** Có lệnh htpasswd (và hỗ trợ bcrypt) không — probe không đụng file. */
function htpasswdAvailable() {
  try {
    execFileSync('htpasswd', ['-nbB', 'probe', 'probe'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const userId = (args.user ?? '').trim().toLowerCase();
  if (userId === '') fail('Thiếu --user <email>.');

  const htpasswdFile = opt(args.htpasswd) ?? DEFAULT_HTPASSWD;

  // Kiểm công cụ TRƯỚC để fail nhanh, không ghi DB rồi mới phát hiện thiếu htpasswd.
  if (!htpasswdAvailable()) {
    fail(
      'Không thấy lệnh `htpasswd`. Cài: `apt install apache2-utils` (Debian/Ubuntu) ' +
        'hoặc `yum install httpd-tools` (RHEL/CentOS).',
    );
  }

  // (b) Cấp vai trò TRƯỚC — grant-role.mjs kiểm role hợp lệ và PM chỉ nhận project
  //     đã đăng ký. Lỗi ở đây thì dừng, CHƯA đụng file htpasswd.
  const grantArgs = [join(scriptDir, 'grant-role.mjs'), '--user', userId, '--role', args.role ?? 'VIEWER'];
  if (opt(args.projects)) grantArgs.push('--projects', args.projects);
  if (opt(args.name)) grantArgs.push('--name', args.name);
  try {
    execFileSync(process.execPath, grantArgs, { stdio: 'inherit' });
  } catch {
    fail('Cấp vai trò thất bại (xem lỗi ở trên) — chưa tạo tài khoản đăng nhập.');
  }

  // (a) Mật khẩu: dùng --password nếu có, không thì sinh ngẫu nhiên rồi in ra.
  const explicit = opt(args.password);
  const password = explicit ?? randomBytes(12).toString('base64url');

  const create = existsSync(htpasswdFile) ? [] : ['-c']; // tạo file nếu chưa có
  try {
    // -i: đọc mật khẩu từ stdin (không lộ trên dòng lệnh); -B: bcrypt.
    execFileSync('htpasswd', ['-i', '-B', ...create, htpasswdFile, userId], {
      input: `${password}\n`,
      stdio: ['pipe', 'ignore', 'inherit'],
    });
  } catch (err) {
    fail(`Ghi htpasswd thất bại (${err instanceof Error ? err.message : err}). Kiểm quyền ghi ${htpasswdFile}.`);
  }

  console.log(`\n✔ Xong cho ${userId}:`);
  console.log(`   • đăng nhập  : ${htpasswdFile}${create.length ? '  (đã tạo file mới)' : ''}`);
  if (explicit === null) console.log(`   • mật khẩu    : ${password}   ← đưa cho người dùng`);
  console.log('   • vai trò     : đã cấp ở app_user (dòng ✔ phía trên)');
  if (create.length) console.log('\nVừa tạo file htpasswd lần đầu → cần `nginx -s reload`. Thêm người sau thì không cần.');
}

main();
