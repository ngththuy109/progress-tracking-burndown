/**
 * Seed dữ liệu Mặc định cho một database MỚI.
 *
 * Vì sao tồn tại: `pnpm db:migrate` chỉ TẠO BẢNG, không nạp dữ liệu. Nếu chưa
 * seed thì màn hình **Phase settings** và **Signboard columns** trả 500
 * `NO_GLOBAL_CONFIG` — `GET /api/config/phase` không tìm thấy bộ Mặc định đang
 * hiệu lực. Đây là bước còn thiếu để một database vừa migrate xong dùng được.
 *
 * Chạy SAU `pnpm db:migrate`:
 *
 *   pnpm db:migrate && pnpm db:seed
 *
 * Idempotent (C-6): chạy lại vô hại — lịch làm việc dùng upsert, bộ Mặc định
 * chỉ tạo khi CHƯA có bộ GLOBAL nào đang hiệu lực. An toàn để đặt sẵn trong
 * pipeline deploy giống `pnpm seed:admin`.
 *
 * Chạy bằng `tsx` (như api/worker) để tái dùng thẳng repository và
 * `DEFAULT_PHASE_CONFIG` của `@app/db`, thay vì viết lại SQL tay dễ lệch.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createPrismaClient } from '../client.js';
import { seedWorkCalendars } from './work-calendar.seed.js';
import { seedDefaultPhaseConfig } from './default-phase-config.js';

const log = (m: string): void => console.log(`[db:seed] ${m}`);

/**
 * Nạp `.env` ở GỐC repo vào `process.env` nếu có.
 *
 * KHÔNG ghi đè biến đã đặt (CI/Docker/shell luôn thắng `.env`). Cùng tinh thần
 * với `apps/api/src/load-env.ts`; `process.loadEnvFile` cần Node ≥ 20.12, thiếu
 * thì bỏ qua và dựa vào env thật.
 */
function loadRootEnv(): void {
  const rootEnv = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (typeof process.loadEnvFile === 'function' && existsSync(rootEnv)) {
    process.loadEnvFile(rootEnv);
  }
}

async function main(): Promise<void> {
  loadRootEnv();

  if (!process.env['DATABASE_URL']) {
    console.error('[db:seed] ✖ Thiếu DATABASE_URL — đặt biến môi trường hoặc điền vào .env.');
    process.exit(1);
  }

  const prisma = createPrismaClient();
  try {
    await seedWorkCalendars(prisma);
    log('Lịch làm việc mặc định: đã đảm bảo (VN_STANDARD, JP_STANDARD).');

    const config = await seedDefaultPhaseConfig(prisma);
    log(
      config.seeded
        ? `Bộ Mặc định (GLOBAL): đã tạo version v${config.version}.`
        : `Bộ Mặc định (GLOBAL): đã có sẵn version v${config.version} — giữ nguyên.`,
    );

    log('Xong.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\n[db:seed] ✖ Seed thất bại:');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
