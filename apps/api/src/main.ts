// PHẢI đứng TRƯỚC mọi import khác: nạp `.env` ở gốc repo vào process.env trước
// khi @app/db… (hoặc bất kỳ module nào) đọc env. Xem load-env.ts.
import './load-env.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Redis } from 'ioredis';
import { Queue, type JobsOptions } from 'bullmq';
import {
  assertEncryptionKeyUsable,
  assertMigrationsApplied,
  disconnectPrisma,
  getPrisma,
  findProjectConnection,
  open as openSecret,
  parseEncryptionKey,
  seal as sealSecret,
} from '@app/db';
import {
  createJiraRegistry,
  fieldMappingConfigSchema,
  InMemoryTokenBucketStore,
  TokenBucketRateLimiter,
  type FieldMappingConfig,
  type StatusMapCache,
} from '@app/jira';
import { withTimeout, TimeoutError } from '@app/shared';
import { createServer, DEFAULT_PORT, type ServerDeps } from './server.js';
import { authConfigFromEnv } from './adapters/principal.js';
import { createJiraConnectionTester } from './adapters/jira-test.adapters.js';
import type { TokenBox } from './routes/projects.routes.js';

/**
 * Điểm vào tiến trình API.
 *
 * `server.ts` chỉ DỰNG app (thuần, test được mà không cần hạ tầng). File này là
 * ĐIỂM LẮP RÁP thật: đọc env, mở Prisma/Redis thật rồi cho Fastify lắng nghe.
 *
 * KHÁC TRƯỚC (Phase B, multi-tenant): KHÔNG còn bước "nạp field mapping + status
 * map + kiểm Jira" lúc boot. Kết nối Jira giờ THEO TENANT — registry
 * (@app/jira `createJiraRegistry`) dựng client theo yêu cầu từ bảng `project`,
 * dự án legacy rơi về env JIRA_* (giờ là biến TUỲ CHỌN). Admin kiểm kết nối
 * bằng endpoint "Test connection" thay vì bằng việc boot thành công.
 *
 * Tách khỏi `server.ts` có chủ đích: test import `createServer` mà KHÔNG mở một
 * kết nối hạ tầng nào. Vì vậy dev script trỏ vào `main.ts`, còn test dùng
 * `server.ts`.
 */

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL'] as const;
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

// Hằng số hàng đợi PHẢI khớp `apps/worker/src/queue/queues.ts` (QUEUE_PREFIX,
// QUEUE_NAME.backfill và DEFAULT_JOB_OPTIONS). Hai app không được import lẫn
// nhau (ARCHITECTURE.md §2) nên hằng số này lặp lại có chủ đích — đổi một bên
// phải đổi cả bên kia, nếu không API đẩy job vào một hàng đợi mà worker không
// hề lắng nghe.
const QUEUE_PREFIX = 'bull:burndown';
const BACKFILL_QUEUE_NAME = 'backfill';

// Thiếu khối này thì job do API đẩy (backfill khi thêm Epic, sync-epic khi
// resync) lấy mặc định của BullMQ: KHÔNG thử lại, và bị GIỮ LẠI VĨNH VIỄN sau
// khi xong — xác job completed đó nuốt lặng lẽ mọi lượt resync sau của cùng
// Epic vì jobId chống trùng vẫn còn trong Redis.
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  // Giữ job hỏng để điều tra — `enqueueReplacingFinished` sẽ dọn khi đẩy lượt mới.
  removeOnFail: false,
};

/**
 * Hạn chót cho bước KHỞI ĐỘNG, để một phụ thuộc "treo" không giữ tiến trình ở
 * trạng thái "sống mà không lắng nghe" (xem `withTimeout`).
 *
 * `REDIS_READY_TIMEOUT_MS` bắt riêng ca Redis treo (accept TCP nhưng không trả
 * lời) → cho thông báo CHÍNH XÁC và thoát nhanh. `BOOTSTRAP_TIMEOUT_MS` là lưới
 * chặn cuối cho MỌI bước treo khác (DB…). Chỉnh qua env để hợp môi trường khởi
 * động chậm.
 */
function readTimeoutMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
const REDIS_READY_TIMEOUT_MS = readTimeoutMs('REDIS_READY_TIMEOUT_MS', 10_000);
const BOOTSTRAP_TIMEOUT_MS = readTimeoutMs('BOOTSTRAP_TIMEOUT_MS', 60_000);

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
 * Nạp cấu hình ánh xạ field từ `config/jira-fields.yaml` — giờ chỉ còn là
 * FALLBACK cho tenant chưa khai `jiraFieldsJson` riêng. Không có file cũng
 * không chặn boot nữa: tenant tự khai qua màn hình quản trị.
 */
function loadFieldMappingConfig(): FieldMappingConfig | null {
  const override = process.env['JIRA_FIELDS_CONFIG'];
  const path = override
    ? resolve(override)
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../config/jira-fields.yaml');
  try {
    const raw = parseYaml(readFileSync(path, 'utf8'));
    return fieldMappingConfigSchema.parse(raw);
  } catch (err) {
    log({
      event: 'jira.fieldsconfig.skipped',
      path,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function bootstrap(): Promise<void> {
  const env = readEnv(process.env);
  log({
    event: 'api.starting',
    databaseHost: safeHost(env.DATABASE_URL),
    redisHost: safeHost(env.REDIS_URL),
  });

  const prisma = getPrisma();

  // CHẶN khởi động nếu database còn lạc hậu so với mã. Deploy quên `pnpm db:migrate`
  // thì mọi truy vấn chạm cột/bảng mới nổ `500 INTERNAL_ERROR` mờ mịt trên TỪNG
  // request (đúng ca màn hình "Signboard columns" thiếu cột signboard_column.side).
  // Kiểm một lần ở đây → một lỗi rõ kèm đúng lệnh phải chạy, thay vì hàng loạt 500
  // khó truy. Cũng là lượt chạm DB đầu tiên nên bắt luôn ca database không tới được.
  await assertMigrationsApplied(prisma, {
    onSkip: (reason, dir) => log({ event: 'migrations.check.skipped', reason, dir }),
  });

  // CHẶN khởi động nếu DB đã có token Jira mã hóa mà APP_ENCRYPTION_KEY thiếu
  // hoặc sai — thà không chạy còn hơn để một nửa số tenant chết im lặng lúc sync.
  await assertEncryptionKeyUsable(prisma, process.env['APP_ENCRYPTION_KEY']);

  // Hộp mã hóa token tenant. Chưa đặt khóa cũng chạy được (chế độ 1 site cũ
  // dùng env JIRA_*) — nhưng lưu token riêng cho tenant sẽ bị chặn với lỗi rõ.
  const rawKey = process.env['APP_ENCRYPTION_KEY']?.trim();
  const tokenBox: TokenBox | null = rawKey
    ? (() => {
        const key = parseEncryptionKey(rawKey); // ném lỗi rõ nếu sai độ dài
        return {
          seal: (plaintext: string) => sealSecret(plaintext, key),
          open: (sealed: string) => openSecret(sealed, key),
        };
      })()
    : null;

  // BullMQ BẮT BUỘC `maxRetriesPerRequest: null` trên kết nối nó dùng; kết nối
  // này vừa cho hàng đợi backfill vừa cho cache nên đặt luôn ở đây.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  redis.on('error', (err: Error) => log({ event: 'redis.error', message: err.message }));

  // CHẶN ca Redis "treo": instance accept TCP nhưng không trả lời lệnh nào. Không
  // có hạn chót thì mọi lệnh sau chờ MÃI — `maxRetriesPerRequest: null` khiến
  // lệnh không bao giờ bị bỏ, mà treo kiểu này KHÔNG phát ra event `error` nên
  // `.catch` bên dưới chẳng bao giờ chạy. Ping có hạn chót biến "treo im lặng"
  // thành lỗi rõ, để bootstrap thoát hẳn.
  await withTimeout(redis.ping(), REDIS_READY_TIMEOUT_MS, 'Redis (ping lúc khởi động)');

  // env JIRA_* giờ là FALLBACK TUỲ CHỌN cho tenant chưa khai kết nối riêng.
  // Thiếu cũng không chặn boot — tenant nào thiếu kết nối sẽ nhận lỗi rõ ràng
  // đúng lúc nó cần Jira (JiraConnectionError), không phải 500 mờ mịt lúc boot.
  const jiraBaseUrl = process.env['JIRA_BASE_URL']?.trim();
  const jiraEmail = process.env['JIRA_EMAIL']?.trim();
  const jiraApiToken = process.env['JIRA_API_TOKEN']?.trim();
  const fallbackFieldsConfig = loadFieldMappingConfig();
  const envJira =
    jiraBaseUrl && jiraEmail && jiraApiToken
      ? {
          baseUrl: jiraBaseUrl,
          email: jiraEmail,
          apiToken: jiraApiToken,
          fieldsConfig: fallbackFieldsConfig,
        }
      : null;
  log({ event: 'jira.mode', envFallback: envJira !== null });

  // Registry client Jira THEO TENANT. Rate limiter in-memory là ĐỦ cho API: nó
  // chỉ tra cứu tương tác lượng nhỏ (kiểm key Epic, duyệt danh sách); ngân sách
  // Redis 40 req/s toàn hệ thống (C-7) tồn tại để ghìm lượt đồng bộ HÀNG LOẠT
  // của worker (R-04), không phải mấy lookup này. Registry tự bảo đảm N dự án
  // cùng site chia nhau MỘT bucket + một trần song song.
  const jiraRegistry = createJiraRegistry({
    async loadConnection(projectKey) {
      const row = await findProjectConnection(prisma, projectKey);
      if (row === null) return null;
      return {
        projectKey: row.projectKey,
        baseUrl: row.jiraBaseUrl,
        email: row.jiraEmail,
        // Giải mã Ở ĐÂY (tầng lắp ráp giữ khóa); registry chỉ nhận plaintext
        // trong RAM. Token mã hóa mà thiếu khóa thì assertEncryptionKeyUsable đã
        // chặn boot ở trên rồi.
        apiTokenPlain:
          row.jiraTokenEnc === null || tokenBox === null ? null : tokenBox.open(row.jiraTokenEnc),
        fieldsConfig: row.jiraFieldsJson,
        resolvedFields: row.jiraResolvedJson,
      };
    },
    envFallback: envJira,
    createRateLimiter: () =>
      new TokenBucketRateLimiter({ store: new InMemoryTokenBucketStore(() => Date.now()) }),
    statusCache: createStatusMapCache(redis),
    logger: (e) => log(e),
  });

  const backfillQueue = new Queue(BACKFILL_QUEUE_NAME, {
    connection: redis,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  const deps: ServerDeps = {
    prisma,
    redis,
    jiraRegistry,
    backfillQueue,
    cache: createConfigCache(redis),
    // Danh tính do cổng SSO đặt vào header; quyền tra `app_user`. Cấu hình
    // qua AUTH_* (xem adapters/principal.ts và config/auth-proxy/).
    auth: authConfigFromEnv(process.env),
    tokenBox,
    // "Test connection" dựng JiraClient theo yêu cầu — không đụng registry để
    // giá trị đang thử (chưa lưu) không lẫn vào cache kết nối thật.
    jiraTester: createJiraConnectionTester({ logger: (e) => log(e) }),
    envJira,
    validateFieldsConfig: (v) => {
      const parsed = fieldMappingConfigSchema.safeParse(v);
      return parsed.success
        ? { ok: true }
        : { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
    },
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

// Watchdog toàn bộ khởi động: nếu bootstrap KHÔNG xong trong `BOOTSTRAP_TIMEOUT_MS`
// (bất kỳ phụ thuộc nào treo), thoát hẳn thay vì nằm im chờ mãi.
withTimeout(bootstrap(), BOOTSTRAP_TIMEOUT_MS, 'Khởi động API').catch((err: unknown) => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const portInUse = code === 'EADDRINUSE';
  const timedOut = err instanceof TimeoutError;
  log({
    event: 'api.fatal',
    message: err instanceof Error ? err.message : String(err),
    // Ca hay gặp khi KHỞI ĐỘNG LẠI: tiến trình API cũ chưa nhả cổng (shutdown
    // còn đợi request dở dang drain) nên `app.listen` của tiến trình mới trúng
    // EADDRINUSE. Nói thẳng để không phải đoán.
    ...(portInUse
      ? { hint: `Cổng ${process.env['PORT'] ?? DEFAULT_PORT} đang bận — nhiều khả năng còn một tiến trình API cũ chưa thoát. Dừng nó rồi chạy lại.` }
      : {}),
    // Treo lúc khởi động: gần như luôn là một phụ thuộc không phản hồi. Redis
    // treo (accept TCP nhưng không trả PONG) là thủ phạm thường gặp nhất.
    ...(timedOut
      ? { hint: 'Một phụ thuộc không phản hồi khi khởi động — nhiều khả năng Redis treo. Kiểm tra `redis-cli -u $REDIS_URL ping` phải trả PONG; nếu treo thì kill và restart Redis.' }
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
