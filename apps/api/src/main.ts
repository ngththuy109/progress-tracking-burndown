import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { disconnectPrisma, getPrisma } from '@app/db';
import {
  JiraClient,
  fieldMappingConfigSchema,
  getFields,
  loadStatusIdMap,
  resolveFieldMapping,
  type FieldMappingConfig,
  type StatusMapCache,
} from '@app/jira';
import type { StatusIdMap } from '@app/shared';
import { createServer, DEFAULT_PORT, type ServerDeps } from './server.js';

/**
 * Điểm vào tiến trình API.
 *
 * `server.ts` chỉ DỰNG app (thuần, test được mà không cần hạ tầng). File này là
 * ĐIỂM LẮP RÁP thật: đọc env, mở Prisma/Redis/Jira thật, nạp field mapping và
 * status map một lần lúc khởi động (PRD §2.8, T-04) rồi cho Fastify lắng nghe.
 *
 * Tách khỏi `server.ts` có chủ đích: test import `createServer` mà KHÔNG mở một
 * kết nối hạ tầng nào. Vì vậy dev script trỏ vào `main.ts`, còn test dùng
 * `server.ts`.
 */

const REQUIRED_ENV = [
  'DATABASE_URL',
  'REDIS_URL',
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
] as const;
type EnvName = (typeof REQUIRED_ENV)[number];

class MissingEnvError extends Error {
  constructor(readonly names: readonly string[]) {
    super(
      `Thiếu biến môi trường: ${names.join(', ')}. ` +
        'Sao chép `.env.example` thành `.env` rồi điền, hoặc đặt biến trong môi trường chạy.',
    );
    this.name = 'MissingEnvError';
  }
}

/** Đọc và kiểm biến môi trường. Gom TẤT CẢ biến thiếu rồi báo một lần. */
function readEnv(source: NodeJS.ProcessEnv): Record<EnvName, string> {
  const out = {} as Record<EnvName, string>;
  const missing: string[] = [];
  for (const name of REQUIRED_ENV) {
    const v = source[name]?.trim();
    if (!v) missing.push(name);
    else out[name] = v;
  }
  if (missing.length > 0) throw new MissingEnvError(missing);
  return out;
}

// Hằng số hàng đợi PHẢI khớp `apps/worker/src/queue/queues.ts` (QUEUE_PREFIX và
// QUEUE_NAME.backfill). Hai app không được import lẫn nhau (ARCHITECTURE.md §2)
// nên hằng số này lặp lại có chủ đích — đổi một bên phải đổi cả bên kia, nếu
// không API đẩy job vào một hàng đợi mà worker không hề lắng nghe.
const QUEUE_PREFIX = 'bull:burndown';
const BACKFILL_QUEUE_NAME = 'backfill';

/** Log JSON có cấu trúc, cùng dạng với Fastify logger (C-9). */
function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', name: 'api-bootstrap', ...event }));
}

/** Chỉ lấy host, bỏ hẳn tên đăng nhập / mật khẩu nằm trong URL (C-9). */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(không đọc được)';
  }
}

/** Cache StatusIdMap trên Redis 24h (PRD §4.7) — hiện thực `StatusMapCache` bằng ioredis. */
function createStatusMapCache(redis: Redis): StatusMapCache {
  return {
    get: (key) => redis.get(key),
    set: async (key, value, ttlSeconds) => {
      await redis.set(key, value, 'EX', ttlSeconds);
    },
  };
}

/**
 * Cache cấu hình Phase — tầng service chỉ cần đúng `del` để vô hiệu hoá.
 *
 * `del` nhận key chính xác (`meta:phaseconfig:PAY`) HOẶC mẫu glob
 * (`meta:phaseconfig:*`). Với glob dùng SCAN chứ không KEYS: KEYS chặn cả Redis
 * khi số key lớn (PRD §9).
 */
function createConfigCache(redis: Redis): { del(pattern: string): Promise<void> } {
  return {
    async del(pattern) {
      if (!pattern.includes('*')) {
        await redis.unlink(pattern);
        return;
      }
      const stream = redis.scanStream({ match: pattern, count: 100 });
      for await (const batch of stream) {
        const keys = batch as string[];
        if (keys.length > 0) await redis.unlink(...keys);
      }
    },
  };
}

/**
 * Nạp cấu hình ánh xạ field từ `config/jira-fields.yaml`.
 *
 * Mã custom field khác nhau ở mỗi Jira nên KHÔNG viết cứng (PRD §2.8). Cho phép
 * trỏ file khác qua `JIRA_FIELDS_CONFIG` để dựng nhiều môi trường.
 */
function loadFieldMappingConfig(): FieldMappingConfig {
  const override = process.env['JIRA_FIELDS_CONFIG'];
  const path = override
    ? resolve(override)
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../config/jira-fields.yaml');
  const raw = parseYaml(readFileSync(path, 'utf8'));
  return fieldMappingConfigSchema.parse(raw);
}

async function bootstrap(): Promise<void> {
  const env = readEnv(process.env);
  log({
    event: 'api.starting',
    databaseHost: safeHost(env.DATABASE_URL),
    redisHost: safeHost(env.REDIS_URL),
    jiraBaseUrl: env.JIRA_BASE_URL,
  });

  const prisma = getPrisma();
  // BullMQ BẮT BUỘC `maxRetriesPerRequest: null` trên kết nối nó dùng; kết nối
  // này vừa cho hàng đợi backfill vừa cho cache nên đặt luôn ở đây.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  redis.on('error', (err: Error) => log({ event: 'redis.error', message: err.message }));

  // JiraClient dùng bộ giới hạn tốc độ IN-MEMORY mặc định. Đủ cho API vì nó chỉ
  // tra cứu tương tác lượng nhỏ (kiểm key Epic, duyệt danh sách); ngân sách Redis
  // 40 req/s toàn hệ thống (C-7) tồn tại để ghìm lượt đồng bộ HÀNG LOẠT của
  // worker (R-04), không phải mấy lookup này. Thông tin xác thực đọc từ
  // JIRA_* env qua BasicAuthProvider mặc định.
  const jira = new JiraClient({ logger: (e) => log(e) });

  // Field mapping: nạp MỘT lần, CHẶN khởi động nếu field sai/thiếu (PRD §2.8,
  // E-23) — thà không chạy còn hơn để mọi Phase mất đường Kế hoạch trong im lặng.
  const fieldMapping = resolveFieldMapping(loadFieldMappingConfig(), await getFields(jira));
  for (const w of fieldMapping.warnings) log({ event: 'fieldMapping.warning', message: w });

  // Status map: id trạng thái → nhóm, cache 24h ở Redis (T-04). Changelog Jira
  // chỉ ghi id số nên không có bảng này thì không dựng lại trạng thái quá khứ.
  const statusIdMap: StatusIdMap = await loadStatusIdMap(jira, createStatusMapCache(redis));

  const backfillQueue = new Queue(BACKFILL_QUEUE_NAME, { connection: redis, prefix: QUEUE_PREFIX });

  const deps: ServerDeps = {
    prisma,
    redis,
    jira,
    fieldMapping,
    backfillQueue,
    statusIdMap,
    cache: createConfigCache(redis),
  };

  const app = createServer(deps);

  // Liveness/readiness cho dev và bộ cân bằng tải. `server.ts` cố ý để trống để
  // giữ thuần; gắn ở điểm lắp ráp là đúng chỗ vì chỉ ở đây mới có Prisma/Redis
  // thật để ping. 503 để LB rút tiến trình hỏng ra khỏi vòng quay.
  app.get('/healthz', async (_req, reply) => {
    const [db, cache] = await Promise.all([
      prisma
        .$queryRaw`SELECT 1`.then(() => true)
        .catch(() => false),
      redis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]);
    const ok = db && cache;
    await reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', db, cache });
  });

  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  const host = process.env['HOST'] ?? '0.0.0.0';
  await app.listen({ port, host });
  log({ event: 'api.ready', port, host });

  // Tắt sạch (PRD §9.5): ngừng nhận request TRƯỚC, rồi đóng hàng đợi, Redis,
  // cuối cùng Prisma. Đóng Redis/Prisma sớm là cắt chân request đang dở.
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log({ event: 'api.shutdown', signal });
    try {
      await app.close();
      await backfillQueue.close();
      await redis.quit().catch(() => redis.disconnect());
      await disconnectPrisma();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err: unknown) => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const portInUse = code === 'EADDRINUSE';
  log({
    event: 'api.fatal',
    message: err instanceof Error ? err.message : String(err),
    // Ca hay gặp khi KHỞI ĐỘNG LẠI: tiến trình API cũ chưa nhả cổng (shutdown
    // còn đợi request dở dang drain) nên `app.listen` của tiến trình mới trúng
    // EADDRINUSE. Nói thẳng để không phải đoán.
    ...(portInUse
      ? { hint: `Cổng ${process.env['PORT'] ?? DEFAULT_PORT} đang bận — nhiều khả năng còn một tiến trình API cũ chưa thoát. Dừng nó rồi chạy lại.` }
      : {}),
  });

  // PHẢI thoát HẲN, không chỉ đặt `process.exitCode = 1`.
  //
  // Lúc này bootstrap đã mở Redis (và hàng đợi BullMQ) — những kết nối đó GIỮ
  // event loop sống. Nếu chỉ đặt exitCode mà không exit, tiến trình sẽ nằm lại ở
  // trạng thái "CÒN SỐNG NHƯNG KHÔNG LẮNG NGHE": trình giám sát (tsx watch,
  // Docker, K8s…) thấy PID còn sống nên KHÔNG khởi động lại, còn Vite proxy trả
  // 500 rỗng cho mọi `/api/*` → màn hình chỉ hiện "SERVER_ERROR" chung chung, che
  // mất nguyên nhân thật là API chưa bao giờ bind được cổng. Thoát hẳn để đúng
  // với chủ ý "thà không chạy còn hơn chạy nửa vời" ở trên, và để nơi giám sát
  // có cơ hội dựng lại tiến trình.
  process.exit(1);
});
