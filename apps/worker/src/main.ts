// PHẢI đứng TRƯỚC mọi import khác: nạp `.env` ở gốc repo vào process.env trước
// khi @app/db… (hoặc bất kỳ module nào) đọc env. Xem load-env.ts.
import './load-env.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Redis } from 'ioredis';
import {
  TokenBucketRateLimiter,
  createJiraRegistry,
  fieldMappingConfigSchema,
  siteRateLimitKey,
  type FieldMappingConfig,
  type JiraEnvFallback,
  type RateLimiter,
  type StatusMapCache,
  type TokenBucketStore,
} from '@app/jira';
import {
  assertEncryptionKeyUsable,
  assertMigrationsApplied,
  disconnectPrisma,
  findProjectConnection,
  getPrisma,
  open,
  parseEncryptionKey,
} from '@app/db';
import { withTimeout, TimeoutError } from '@app/shared';
import { RedisTokenBucketStore, type EvalRedis } from './queue/redis-token-bucket.js';
import { createShutdown, registerSignalHandlers } from './queue/shutdown.js';
import { wireWorker } from './wire.js';

/**
 * Điểm lắp ráp của worker.
 *
 * Đây là nơi DUY NHẤT biết tới Redis thật, Prisma thật và Jira thật. Mọi tầng
 * dưới chỉ nhìn thấy cổng, nhờ vậy test được mà không cần dựng hạ tầng.
 *
 * Ranh giới (ARCHITECTURE.md §2): worker được import `@app/engine`, `@app/db`,
 * `@app/jira`, `@app/shared`.
 */

/** Giờ chạy job chốt sổ hằng đêm, theo PRD §4.2. */
export const NIGHTLY_CRON = '1 0 * * *';

/** Giờ chạy job đối soát hằng tuần (T-26) — rạng sáng Chủ nhật. */
export const WEEKLY_RECONCILE_CRON = '0 3 * * 0';

/**
 * Lịch quét set `dirty:epics` (T-18): mỗi giờ ở phút 15.
 *
 * Mỗi giờ chứ không phải mỗi phút — gom nhiều lần Lưu cấu hình trong giờ thành
 * MỘT lượt backfill (R-10: tránh tính lại liên tục). Phút 15 để lượt đầu trong
 * ngày chạy sau job đêm 00:01 chừng 15 phút, đúng cam kết E-03 ("job tính lại
 * chạy sau job đêm 15 phút") — worklog lùi ngày mà job đêm phát hiện được nhặt
 * ngay ở lượt này.
 */
export const DIRTY_SWEEP_CRON = '15 * * * *';

/**
 * Hạn chót cho bước KHỞI ĐỘNG, để một phụ thuộc "treo" không giữ tiến trình ở
 * trạng thái "sống mà không làm gì" (xem `withTimeout`).
 *
 * `REDIS_READY_TIMEOUT_MS` bắt riêng ca Redis treo (accept TCP nhưng không trả
 * lời) → thông báo CHÍNH XÁC và thoát nhanh. `BOOTSTRAP_TIMEOUT_MS` là lưới chặn
 * cuối cho MỌI bước treo khác (Jira, DB…). Chỉnh qua env cho môi trường chậm.
 */
function readTimeoutMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
const REDIS_READY_TIMEOUT_MS = readTimeoutMs('REDIS_READY_TIMEOUT_MS', 10_000);
const BOOTSTRAP_TIMEOUT_MS = readTimeoutMs('BOOTSTRAP_TIMEOUT_MS', 60_000);

// ---------------------------------------------------------------------------
// Biến môi trường
// ---------------------------------------------------------------------------

export interface RuntimeEnv {
  readonly redisUrl: string;
  readonly databaseUrl: string;
  /**
   * Bộ ba JIRA_* giờ là TUỲ CHỌN (multi-tenant): mỗi project mang kết nối
   * riêng trong DB; env chỉ còn là đường fallback cho project legacy. `null`
   * nghĩa là không có fallback — project thiếu kết nối riêng sẽ bị registry
   * chặn với thông báo rõ ràng.
   */
  readonly jiraBaseUrl: string | null;
  readonly jiraEmail: string | null;
  readonly jiraApiToken: string | null;
}

export class MissingEnvError extends Error {
  constructor(readonly names: readonly string[]) {
    super(
      `Thiếu biến môi trường: ${names.join(', ')}. ` +
        'Sao chép `.env.example` thành `.env` rồi điền, hoặc đặt biến trong môi trường chạy.',
    );
    this.name = 'MissingEnvError';
  }
}

const REQUIRED_ENV = {
  redisUrl: 'REDIS_URL',
  databaseUrl: 'DATABASE_URL',
} as const;

const OPTIONAL_JIRA_ENV = {
  jiraBaseUrl: 'JIRA_BASE_URL',
  jiraEmail: 'JIRA_EMAIL',
  jiraApiToken: 'JIRA_API_TOKEN',
} as const;

/**
 * Đọc và kiểm biến môi trường.
 *
 * Gom TẤT CẢ biến thiếu rồi báo một lần. Báo từng cái một khiến người dựng môi
 * trường phải chạy đi chạy lại năm lần mới biết còn thiếu những gì.
 *
 * Bộ ba JIRA_* là tuỳ chọn nhưng phải ĐỦ CẢ BA hoặc VẮNG CẢ BA: đặt nửa vời là
 * cấu hình hỏng (cùng quy tắc với kết nối per-project trong registry) — báo
 * thiếu ngay thay vì để job đêm chết khó hiểu.
 */
export function readEnv(source: Readonly<Record<string, string | undefined>>): RuntimeEnv {
  const missing: string[] = [];
  const values: Record<string, string | null> = {};

  for (const [field, name] of Object.entries(REQUIRED_ENV)) {
    const raw = source[name]?.trim();
    if (raw === undefined || raw === '') missing.push(name);
    else values[field] = raw;
  }

  const jiraMissing: string[] = [];
  for (const [field, name] of Object.entries(OPTIONAL_JIRA_ENV)) {
    const raw = source[name]?.trim();
    if (raw === undefined || raw === '') {
      jiraMissing.push(name);
      values[field] = null;
    } else {
      values[field] = raw;
    }
  }
  // Nửa vời (1–2 trên 3) mới là lỗi; vắng cả ba là "không có fallback", hợp lệ.
  if (jiraMissing.length > 0 && jiraMissing.length < 3) missing.push(...jiraMissing);

  if (missing.length > 0) throw new MissingEnvError(missing);

  return values as unknown as RuntimeEnv;
}

/**
 * Cấu hình an toàn để ghi log.
 *
 * KHÔNG BAO GIỜ đưa `jiraApiToken` vào đây (C-9). Một dòng log lỡ tay in cả
 * object cấu hình là token nằm vĩnh viễn trong hệ thống thu thập log.
 */
export function loggableEnv(env: RuntimeEnv): Record<string, unknown> {
  return {
    jiraBaseUrl: env.jiraBaseUrl,
    jiraEmail: env.jiraEmail,
    jiraEnvFallback: env.jiraApiToken !== null,
    redisHost: safeHost(env.redisUrl),
    databaseHost: safeHost(env.databaseUrl),
  };
}

/** Chỉ lấy host, bỏ hẳn phần tên đăng nhập và mật khẩu nằm trong URL. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(không đọc được)';
  }
}

// ---------------------------------------------------------------------------
// Kết nối Redis
// ---------------------------------------------------------------------------

export const REDIS_ROLE = ['queue', 'worker', 'general'] as const;
export type RedisRole = (typeof REDIS_ROLE)[number];

export interface RedisFactoryOptions {
  /**
   * BullMQ BẮT BUỘC giá trị `null`.
   *
   * Mặc định của `ioredis` là 20, và BullMQ sẽ ném lỗi ngay lúc khởi động với
   * một thông báo không nói rõ nguyên nhân.
   */
  readonly maxRetriesPerRequest: null;
}

export const BULLMQ_REDIS_OPTIONS: RedisFactoryOptions = { maxRetriesPerRequest: null };

export interface RedisConnections<T> {
  /** Cho `Queue` — đẩy job. */
  readonly queue: T;
  /** Cho `Worker` — chế độ chờ (blocking). */
  readonly worker: T;
  /** Cho khoá phân tán, token bucket và cache. */
  readonly general: T;
  readonly all: readonly T[];
}

/**
 * Tạo BA kết nối riêng biệt.
 *
 * Dùng chung một kết nối cho cả `Queue` lẫn `Worker` là sai: BullMQ giữ kết nối
 * ở chế độ chờ, và mọi lệnh Redis khác trên cùng kết nối đó sẽ treo — kể cả
 * token bucket giới hạn tốc độ Jira, tức là toàn bộ việc gọi Jira đứng im mà
 * không có lỗi nào báo ra.
 */
export function createRedisConnections<T>(
  create: (url: string, role: RedisRole, options: RedisFactoryOptions) => T,
  url: string,
): RedisConnections<T> {
  const queue = create(url, 'queue', BULLMQ_REDIS_OPTIONS);
  const worker = create(url, 'worker', BULLMQ_REDIS_OPTIONS);
  const general = create(url, 'general', BULLMQ_REDIS_OPTIONS);
  return { queue, worker, general, all: [queue, worker, general] };
}

// ---------------------------------------------------------------------------
// Giới hạn tốc độ Jira
// ---------------------------------------------------------------------------

export interface RateLimiterBuild {
  readonly limiter: RateLimiter;
  /** Lộ ra để test khẳng định được đây là bản Redis, không phải bản in-memory. */
  readonly store: TokenBucketStore;
}

/**
 * Dựng bộ giới hạn tốc độ dùng chung cho MỌI worker.
 *
 * Bắt buộc là bản Redis (C-7). Bản in-memory làm mỗi tiến trình tự giữ 40
 * request/giây riêng; bốn worker thành 160 request/giây và Jira sẽ chặn cả tổ
 * chức (R-04, ảnh hưởng "Rất cao"). Test đơn tiến trình không bao giờ phát hiện
 * được điều đó, nên hàm này cố ý KHÔNG nhận tham số cho phép chọn bản in-memory.
 *
 * `siteHost` (multi-tenant): khoá bucket THEO SITE Jira —
 * `ratelimit:jira:tokens:<host>`, đúng khuôn `siteRateLimitKey` bên `@app/jira`
 * — để N dự án cùng site chia nhau đúng một hạn mức, còn hai site khác nhau
 * không bóp lẫn nhau. Không truyền thì dùng khoá legacy đơn site.
 */
export function buildJiraRateLimiter(
  redis: EvalRedis,
  now?: () => number,
  siteHost?: string,
): RateLimiterBuild {
  const store = new RedisTokenBucketStore(redis, now);
  return {
    store,
    limiter: new TokenBucketRateLimiter({
      store,
      // Đi vòng qua `siteRateLimitKey` (nhận URL) để KHÔNG chép tay tiền tố
      // khoá — lệch một ký tự là hai đường (api test-connection / worker sync)
      // đếm hạn mức trên hai bucket khác nhau.
      ...(siteHost !== undefined ? { key: siteRateLimitKey(`https://${siteHost}`) } : {}),
    }),
  };
}

// ---------------------------------------------------------------------------
// Registry client Jira theo dự án (multi-tenant)
// ---------------------------------------------------------------------------

/**
 * Nạp `config/jira-fields.yaml` — giờ CHỈ dùng làm `fieldsConfig` của đường
 * fallback env; dự án có `jiraFieldsJson` riêng trong DB thì không đụng tới.
 */
export function loadFieldMappingConfig(): FieldMappingConfig {
  const override = process.env['JIRA_FIELDS_CONFIG'];
  const path = override
    ? resolve(override)
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../config/jira-fields.yaml');
  return fieldMappingConfigSchema.parse(parseYaml(readFileSync(path, 'utf8')));
}

/**
 * Đường fallback JIRA_* cho dự án legacy. Vắng cả ba biến → `null` — lúc đó
 * KHÔNG cần cả file YAML: mọi dự án buộc phải có kết nối riêng trong DB.
 */
export function buildEnvFallback(env: RuntimeEnv): JiraEnvFallback | null {
  if (env.jiraBaseUrl === null || env.jiraEmail === null || env.jiraApiToken === null) return null;
  return {
    baseUrl: env.jiraBaseUrl,
    email: env.jiraEmail,
    apiToken: env.jiraApiToken,
    fieldsConfig: loadFieldMappingConfig(),
  };
}

function createStatusMapCache(redis: Redis): StatusMapCache {
  return {
    get: (key) => redis.get(key),
    set: async (key, value, ttlSeconds) => {
      await redis.set(key, value, 'EX', ttlSeconds);
    },
  };
}

// ---------------------------------------------------------------------------
// Điểm vào tiến trình
// ---------------------------------------------------------------------------

/**
 * Điểm lắp ráp thật của worker: mở Redis/Prisma/Jira thật, đấu nối bộ xử lý job
 * (qua `wireWorker`) rồi chạy một BullMQ Worker cho mỗi hàng đợi.
 *
 * Chạy dưới `tsx watch src/main.ts`. Được bảo vệ bằng kiểm "gọi trực tiếp" ở cuối
 * file để test import các hàm export phía trên KHÔNG vô tình mở kết nối.
 */
async function bootstrap(): Promise<void> {
  const env = readEnv(process.env);
  const log = (event: Record<string, unknown>): void =>
    console.log(JSON.stringify({ level: 'info', name: 'worker', ...event }));
  log({ event: 'worker.starting', ...loggableEnv(env) });

  // Ba kết nối RIÊNG BIỆT (xem `createRedisConnections`): dùng chung một kết nối
  // cho Queue lẫn Worker sẽ làm treo mọi lệnh Redis khác.
  const redis = createRedisConnections((url, _role, options) => new Redis(url, options), env.redisUrl);
  for (const conn of redis.all) {
    conn.on('error', (err: Error) => log({ event: 'redis.error', message: err.message }));
  }

  // CHẶN ca Redis "treo" (accept TCP nhưng không trả lời lệnh): không có hạn chót
  // thì lệnh Redis đầu tiên (BullMQ scheduler, token bucket…) chờ MÃI và worker
  // nằm im mà không phát ra lỗi nào. Ping có hạn chót để thoát sớm với thông báo rõ.
  await withTimeout(redis.general.ping(), REDIS_READY_TIMEOUT_MS, 'Redis (ping lúc khởi động)');

  // Kiểm DB ngay lúc khởi động: thà chết sớm với lỗi rõ còn hơn để mọi job đổ vì
  // không có database.
  const prisma = getPrisma();
  await prisma.$queryRaw`SELECT 1`;

  // CHẶN khởi động nếu database còn migration chưa áp. Deploy mã mới mà quên
  // `pnpm db:migrate` thì mọi job chạm cột/bảng mới sẽ đổ hàng loạt vì thiếu
  // schema — thà chết sớm ở đây với đúng lệnh phải chạy.
  await assertMigrationsApplied(prisma, {
    onSkip: (reason, dir) => log({ event: 'migrations.check.skipped', reason, dir }),
  });

  // CHẶN khởi động nếu DB đã có token Jira mã hoá mà APP_ENCRYPTION_KEY thiếu
  // hoặc sai khoá: thà chết ở đây còn hơn một nửa số tenant chết im lặng lúc
  // 2h sáng. Chưa tenant nào nhập token thì KHÔNG bắt buộc đặt khoá.
  await assertEncryptionKeyUsable(prisma, process.env['APP_ENCRYPTION_KEY']);

  // Khoá mã hoá chỉ được parse LƯỜI, khi một hàng project thật sự mang token:
  // hệ thống legacy toàn env JIRA_* không đặt khoá vẫn phải chạy được (ca cấu
  // hình sai thật sự đã bị assertEncryptionKeyUsable ở trên chặn từ lúc boot).
  let cachedEncryptionKey: Buffer | null = null;
  const encryptionKey = (): Buffer =>
    (cachedEncryptionKey ??= parseEncryptionKey(process.env['APP_ENCRYPTION_KEY']));

  // Registry client Jira THEO DỰ ÁN. Khởi động KHÔNG chạm Jira — client, field
  // mapping và status map của từng tenant được dựng lười ở job đầu tiên.
  //
  // Rate limiter khoá THEO SITE trên Redis DÙNG CHUNG (C-7): 40 req/s cho mỗi
  // site trên TOÀN hệ thống, chứ không phải mỗi worker/mỗi dự án một hạn riêng
  // — nếu không bốn worker thành 160 req/s và Jira chặn cả tổ chức (R-04).
  const registry = createJiraRegistry({
    loadConnection: async (projectKey) => {
      const row = await findProjectConnection(prisma, projectKey);
      if (row === null) return null;
      return {
        projectKey: row.projectKey,
        baseUrl: row.jiraBaseUrl,
        email: row.jiraEmail,
        // Giải mã NGAY TẠI BIÊN này; plaintext chỉ sống trong RAM của registry.
        apiTokenPlain: row.jiraTokenEnc === null ? null : open(row.jiraTokenEnc, encryptionKey()),
        fieldsConfig: row.jiraFieldsJson,
        resolvedFields: row.jiraResolvedJson,
      };
    },
    envFallback: buildEnvFallback(env),
    createRateLimiter: (siteHost) =>
      buildJiraRateLimiter(redis.general as unknown as EvalRedis, undefined, siteHost).limiter,
    statusCache: createStatusMapCache(redis.general),
    logger: (e) => log(e),
  });

  // Dựng bảng điều phối, chạy Worker cho cả ba hàng đợi.
  const { workers, queues } = await wireWorker({
    prisma,
    queueConn: redis.queue,
    workerConn: redis.worker,
    generalConn: redis.general,
    registry,
    log,
    nightlyCron: NIGHTLY_CRON,
    weeklyReconcileCron: WEEKLY_RECONCILE_CRON,
    dirtySweepCron: DIRTY_SWEEP_CRON,
  });

  // Tắt sạch (PRD §9.5): đóng worker TRƯỚC (chờ job đang chạy), rồi hàng đợi,
  // Redis, cuối cùng Prisma. Đảo thứ tự là cắt chân job đang cố hoàn tất.
  const shutdown = createShutdown({
    workers: [...workers],
    connections: [
      { close: () => queues.closeAll() },
      ...redis.all.map((conn) => ({
        close: async () => {
          await conn.quit().catch(() => {
            conn.disconnect();
          });
        },
      })),
      { close: () => disconnectPrisma() },
    ],
    log,
    onExit: (code) => process.exit(code),
  });
  registerSignalHandlers(shutdown, process);

  log({ event: 'worker.ready', queues: ['sync', 'backfill', 'reconcile'] });
}

// Chỉ tự chạy khi được gọi TRỰC TIẾP (`tsx watch src/main.ts`), KHÔNG chạy khi
// test import các hàm export ở trên (vd queue.test.ts) — nếu không mỗi lần chạy
// test lại mở kết nối Redis/Prisma thật.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Watchdog toàn bộ khởi động: bất kỳ phụ thuộc nào treo cũng thoát hẳn, không
  // để worker nằm chờ mãi.
  withTimeout(bootstrap(), BOOTSTRAP_TIMEOUT_MS, 'Khởi động worker').catch((err: unknown) => {
    const timedOut = err instanceof TimeoutError;
    console.error(
      JSON.stringify({
        level: 'error',
        name: 'worker',
        event: 'worker.fatal',
        message: err instanceof Error ? err.message : String(err),
        ...(timedOut
          ? { hint: 'Một phụ thuộc không phản hồi khi khởi động — nhiều khả năng Redis treo. Kiểm tra `redis-cli -u $REDIS_URL ping` phải trả PONG; nếu treo thì kill và restart Redis.' }
          : {}),
      }),
    );
    // PHẢI thoát HẲN chứ không chỉ đặt `exitCode`: Redis/BullMQ đang mở GIỮ event
    // loop sống, nên đặt exitCode sẽ để tiến trình "sống mà không làm gì" — trình
    // giám sát thấy PID còn đó nên KHÔNG dựng lại. Thoát hẳn để được restart.
    process.exit(1);
  });
}
