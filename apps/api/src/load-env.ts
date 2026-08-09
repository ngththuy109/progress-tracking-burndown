import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nạp `.env` ở GỐC repo vào `process.env`.
 *
 * Là side-effect import ĐẦU TIÊN của `main.ts` (trước cả `@app/db`…), để biến có
 * mặt TRƯỚC khi bất kỳ module nào đọc env. Nhờ vậy `pnpm dev` chạy được chỉ với
 * một file `.env` ở gốc — đúng như ONBOARDING.md §2 hứa (`cp .env.example .env`),
 * kể cả biến `AUTH_BOOTSTRAP_ADMINS` (nếu không thì `main.ts` đọc thẳng
 * `process.env` sẽ không bao giờ thấy nó).
 *
 * AN TOÀN CHO PRODUCTION: `loadEnvFile` KHÔNG ghi đè biến đã có — biến thật
 * (CI/Docker/shell export) luôn thắng `.env`. Ở production thường không có file
 * `.env` nên hàm này là no-op. Tự làm thay vì kéo thêm `dotenv` — cùng tinh thần
 * `tools/db/apply-migrations.mjs`.
 *
 * `process.loadEnvFile` cần Node ≥ 20.12; thiếu thì bỏ qua (giữ nguyên hành vi
 * cũ, không regression) — người dùng Node cũ vẫn đặt env qua shell/Docker được.
 */
const ROOT_ENV = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');

if (typeof process.loadEnvFile === 'function' && existsSync(ROOT_ENV)) {
  process.loadEnvFile(ROOT_ENV);
}
