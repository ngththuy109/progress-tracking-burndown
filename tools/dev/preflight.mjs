#!/usr/bin/env node
// Bảo đảm môi trường SẴN SÀNG trước khi khởi động — chạy TỰ ĐỘNG như `predev`
// nên chỉ cần `pnpm dev` là đủ, không phải cài tay gì nữa.
//
// VẤN ĐỀ nó giải: trên máy dev (nhất là Windows chặn mạng), mỗi lần muốn chạy
// server lại phải `pnpm install` + `pnpm db:generate`, và `pnpm install` từng
// CHẾT ở bước build addon native (re2) rồi phải bỏ qua script bằng tay. Nay:
//   - re2 đã đổi sang bản WebAssembly (`re2-wasm`) nên `pnpm install` không còn
//     bước build native để hỏng nữa (xem packages/engine/src/parser/safe-regex.ts).
//   - Script này CHỈ cài/sinh khi THIẾU. Lần đầu nó chuẩn bị trọn bộ; các lần
//     sau mọi thứ đã có sẵn nên nó bỏ qua trong tích tắc rồi để `pnpm dev` chạy.
//
// Quyết định "còn thiếu gì" dựa trên TRẠNG THÁI THẬT trên đĩa (node_modules,
// Prisma Client đã sinh, và hash của pnpm-lock.yaml), KHÔNG chỉ tin một lá cờ —
// nên `git pull` đổi phụ thuộc sẽ tự kích hoạt cài lại đúng lúc.
//
// An toàn: các bước KIỂM TRA đều là đọc thuần, không phá gì. Chỉ khi phát hiện
// thiếu mới chạy `pnpm install` / `pnpm db:generate`. Bước nào hỏng thì thoát
// với mã lỗi + thông báo rõ, không nuốt lỗi.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE_MODULES = join(ROOT, 'node_modules');
const LOCKFILE = join(ROOT, 'pnpm-lock.yaml');
const MARKER = join(NODE_MODULES, '.dev-preflight.json');

/** In một dòng có tiền tố nhất quán để dễ đọc trong log khởi động. */
function say(msg) {
  console.log(`[preflight] ${msg}`);
}

/** Hash nội dung lockfile — đổi phụ thuộc là đổi hash → biết cần cài lại. */
function lockHash() {
  try {
    return createHash('sha256').update(readFileSync(LOCKFILE)).digest('hex');
  } catch {
    return null; // chưa có lockfile (repo lạ) — coi như cần cài
  }
}

function readMarker() {
  try {
    return JSON.parse(readFileSync(MARKER, 'utf8'));
  } catch {
    return null;
  }
}

/** node_modules đã được pnpm dựng chưa? `.pnpm` là dấu hiệu chắc chắn nhất. */
function depsInstalled() {
  return existsSync(join(NODE_MODULES, '.pnpm'));
}

/**
 * Prisma Client đã được SINH chưa? `prisma generate` ghi mã ra thư mục
 * `.prisma/client` nằm CẠNH gói `@prisma/client` (vị trí sinh mặc định). Chưa
 * sinh thì file này không có và `new PrismaClient()` sẽ ném lỗi lúc chạy.
 */
function prismaClientGenerated() {
  try {
    const req = createRequire(pathToFileURL(join(ROOT, 'packages/db/src/client.ts')));
    const pkgDir = dirname(req.resolve('@prisma/client/package.json'));
    // pkgDir = …/node_modules/@prisma/client → lùi 2 cấp về …/node_modules
    const candidates = [
      join(pkgDir, '..', '..', '.prisma', 'client', 'index.js'),
      join(NODE_MODULES, '.prisma', 'client', 'index.js'),
    ];
    return candidates.some((p) => existsSync(p));
  } catch {
    return false;
  }
}

/** Chạy một lệnh pnpm, kế thừa stdio. `shell:true` để hợp cả `pnpm.cmd` trên Windows. */
function run(args, label) {
  say(`${label}…`);
  const res = spawnSync('pnpm', args, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    say(`✗ Lỗi khi chạy: pnpm ${args.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

function main() {
  const currentLock = lockHash();
  const marker = readMarker();

  const installed = depsInstalled();
  const lockChanged = !marker || marker.lockHash !== currentLock;
  const needInstall = !installed || lockChanged;

  // Sau khi cài lại, Prisma Client có thể bị ghi đè → sinh lại cho chắc.
  const needGenerate = needInstall || !prismaClientGenerated();

  if (!needInstall && !needGenerate) {
    say('môi trường đã sẵn sàng — bỏ qua cài đặt, vào thẳng server.');
    return;
  }

  if (needInstall) {
    say(
      installed
        ? 'pnpm-lock.yaml đã đổi kể từ lần chuẩn bị trước → cài lại phụ thuộc.'
        : 'chưa có node_modules → cài phụ thuộc lần đầu.',
    );
    run(['install'], 'pnpm install (link deps, không có bước build native)');
  }

  if (needGenerate) {
    run(['db:generate'], 'prisma generate (sinh Prisma Client)');
  }

  // Ghi mốc để lần sau bỏ qua. Đặt trong node_modules (đã .gitignore) nên tự
  // reset khi node_modules bị xoá hoặc khi clone mới.
  try {
    writeFileSync(
      MARKER,
      JSON.stringify({ lockHash: currentLock, preparedAt: new Date().toISOString() }, null, 2),
    );
  } catch {
    // Không ghi được mốc cũng không sao — lần sau chỉ tốn thêm một lượt kiểm tra.
  }

  say('✓ xong — môi trường sẵn sàng chạy server.');
}

main();
