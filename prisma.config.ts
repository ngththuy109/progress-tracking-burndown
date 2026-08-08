// Cấu hình cho Prisma CLI — điểm mấu chốt để KHÔNG cần binary native.
//
// Vì sao cần file này: CLI của Prisma (`generate`, `migrate`) mặc định tải hai
// binary Rust từ CDN (`binaries.prisma.sh`) — query engine và "schema engine".
// Máy chặn mạng ra ngoài không tải được nên cả `pnpm install` lẫn
// `pnpm db:generate` đều chết (xem README §"Chạy khi máy chặn mạng").
//
// Cách chặn việc tải:
//   - query engine  : schema.prisma bật preview `queryCompiler` → client dùng
//                     WASM, CLI không tải query engine nữa.
//   - schema engine : chính là file này. Khi cấu hình khai `engine: 'js'` cùng
//                     một driver adapter, Prisma dùng "JS Schema Engine" chạy
//                     migration QUA adapter `pg` thay cho binary — nên CLI bỏ
//                     luôn bước tải schema engine.
//
// Khác với engine mặc định, khi có file cấu hình này Prisma KHÔNG tự nạp `.env`
// nữa; ta tự nạp bằng `dotenv` để `DATABASE_URL` có mặt lúc migrate.
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'packages/db/prisma/schema.prisma',

  // Dùng driver adapter cho tầng migrate vẫn là tính năng thử nghiệm → phải bật.
  experimental: { adapter: true },

  // 'js' = JS Schema Engine chạy migration qua driver adapter, không cần binary
  // schema engine. `adapter` chỉ được gọi khi chạy lệnh `prisma migrate …`;
  // `prisma generate` chỉ cần biết CÓ adapter để bỏ qua bước tải binary.
  engine: 'js',
  adapter: async () => new PrismaPg({ connectionString: process.env['DATABASE_URL'] }),
});
