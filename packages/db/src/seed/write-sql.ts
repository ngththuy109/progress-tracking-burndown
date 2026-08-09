/**
 * Sinh (ghi ra đĩa) file SQL seed từ `DEFAULT_PHASE_CONFIG`.
 *
 * Chạy sau khi đổi hằng số cấu hình Mặc định:
 *
 *   pnpm db:seed:sql:gen
 *
 * File sinh ra (`tools/db/seed-default-config.sql`) là thứ đem chạy trực tiếp
 * bằng `psql`. Test `render-default-config-sql.test.ts` giữ file đó luôn khớp
 * với hàm sinh — quên chạy lệnh này sau khi sửa hằng số là test đỏ.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderDefaultConfigSql, SEED_SQL_RELATIVE_PATH } from './render-default-config-sql.js';

const target = fileURLToPath(new URL(`../../../../${SEED_SQL_RELATIVE_PATH}`, import.meta.url));
writeFileSync(target, renderDefaultConfigSql(), 'utf8');
console.log(`[db:seed:sql:gen] Đã ghi ${SEED_SQL_RELATIVE_PATH}.`);
console.log(`[db:seed:sql:gen] Chạy trực tiếp: psql "$DATABASE_URL" -f ${SEED_SQL_RELATIVE_PATH}`);
