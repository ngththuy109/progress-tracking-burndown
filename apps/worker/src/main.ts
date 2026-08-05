import { TokenBucketRateLimiter, type RateLimiter, type TokenBucketStore } from '@app/jira';
import { RedisTokenBucketStore, type EvalRedis } from './queue/redis-token-bucket.js';

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

// ---------------------------------------------------------------------------
// Biến môi trường
// ---------------------------------------------------------------------------

export interface RuntimeEnv {
  readonly redisUrl: string;
  readonly databaseUrl: string;
  readonly jiraBaseUrl: string;
  readonly jiraEmail: string;
  readonly jiraApiToken: string;
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
  jiraBaseUrl: 'JIRA_BASE_URL',
  jiraEmail: 'JIRA_EMAIL',
  jiraApiToken: 'JIRA_API_TOKEN',
} as const;

/**
 * Đọc và kiểm biến môi trường.
 *
 * Gom TẤT CẢ biến thiếu rồi báo một lần. Báo từng cái một khiến người dựng môi
 * trường phải chạy đi chạy lại năm lần mới biết còn thiếu những gì.
 */
export function readEnv(source: Readonly<Record<string, string | undefined>>): RuntimeEnv {
  const missing: string[] = [];
  const values: Record<string, string> = {};

  for (const [field, name] of Object.entries(REQUIRED_ENV)) {
    const raw = source[name]?.trim();
    if (raw === undefined || raw === '') missing.push(name);
    else values[field] = raw;
  }

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
 */
export function buildJiraRateLimiter(redis: EvalRedis, now?: () => number): RateLimiterBuild {
  const store = new RedisTokenBucketStore(redis, now);
  return { store, limiter: new TokenBucketRateLimiter({ store }) };
}
