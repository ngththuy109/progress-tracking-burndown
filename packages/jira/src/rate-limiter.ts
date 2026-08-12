/**
 * Giới hạn tốc độ gọi Jira — token bucket.
 *
 * PHẢI dùng chung một bucket cho TOÀN HỆ THỐNG, không phải mỗi tiến trình một
 * bucket riêng: 4 worker mỗi cái tự giới hạn 40 req/s thì tổng thành 160 req/s
 * và vẫn bị Jira chặn. Đây là lỗi im lặng — test đơn tiến trình vẫn xanh.
 *
 * Rủi ro R-04 xếp mức ảnh hưởng "Rất cao": bị Jira chặn ảnh hưởng CẢ TỔ CHỨC,
 * không riêng hệ thống này.
 */

/** Trần chủ động, thấp hơn ngưỡng thực tế ~50 req/s của Jira (CONVENTIONS.md C-7). */
export const DEFAULT_RATE_LIMIT_PER_SEC = 40;

export interface RateLimiter {
  /** Chờ tới khi được phép gửi một request. */
  acquire(): Promise<void>;
}

/**
 * Kho lưu token bucket. Cài đặt Redis dùng Lua script để nạp + lấy NGUYÊN TỬ.
 *
 * Đọc-rồi-ghi qua 2 lệnh Redis sẽ tranh chấp giữa các worker.
 */
export interface TokenBucketStore {
  /**
   * Thử lấy 1 token.
   * @returns số mili-giây phải chờ trước khi thử lại; 0 nghĩa là lấy được.
   */
  tryAcquire(key: string, ratePerSec: number, burst: number): Promise<number>;
}

/** Bucket trong RAM — CHỈ dùng cho test và tiến trình đơn lẻ. */
export class InMemoryTokenBucketStore implements TokenBucketStore {
  private tokens = new Map<string, { count: number; lastRefillMs: number }>();

  constructor(private readonly now: () => number) {}

  async tryAcquire(key: string, ratePerSec: number, burst: number): Promise<number> {
    const t = this.now();
    const state = this.tokens.get(key) ?? { count: burst, lastRefillMs: t };

    const elapsedMs = t - state.lastRefillMs;
    const refilled = Math.min(burst, state.count + (elapsedMs * ratePerSec) / 1000);

    if (refilled >= 1) {
      this.tokens.set(key, { count: refilled - 1, lastRefillMs: t });
      return 0;
    }

    this.tokens.set(key, { count: refilled, lastRefillMs: t });
    return Math.ceil(((1 - refilled) / ratePerSec) * 1000);
  }
}

/**
 * Lua script nạp + lấy token nguyên tử trên Redis.
 *
 * Trả về 0 nếu lấy được, hoặc số mili-giây phải chờ.
 */
export const REDIS_TOKEN_BUCKET_LUA = `
local key       = KEYS[1]
local rate      = tonumber(ARGV[1])
local burst     = tonumber(ARGV[2])
local now_ms    = tonumber(ARGV[3])

local data      = redis.call('HMGET', key, 'tokens', 'ts')
local tokens    = tonumber(data[1])
local last_ms   = tonumber(data[2])

if tokens == nil then
  tokens  = burst
  last_ms = now_ms
end

local elapsed = math.max(0, now_ms - last_ms)
tokens = math.min(burst, tokens + (elapsed * rate / 1000))

local wait_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait_ms = math.ceil(((1 - tokens) / rate) * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
redis.call('PEXPIRE', key, 60000)
return wait_ms
`;

/**
 * Khoá Redis của token bucket theo SITE Jira.
 *
 * Jira giới hạn tốc độ THEO SITE, không theo dự án: N dự án cùng trỏ về một site
 * phải chia nhau đúng một bucket. Khoá theo host (không theo URL đầy đủ) để
 * `https://acme.atlassian.net` và `https://acme.atlassian.net/` ra cùng một khoá.
 * Khoá mặc định `ratelimit:jira:tokens` (không hậu tố) vẫn giữ nguyên cho đường
 * legacy đơn site.
 */
export function siteRateLimitKey(baseUrl: string): string {
  return `ratelimit:jira:tokens:${new URL(baseUrl).host}`;
}

export interface TokenBucketOptions {
  readonly store: TokenBucketStore;
  readonly key?: string;
  readonly ratePerSec?: number;
  readonly burst?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class TokenBucketRateLimiter implements RateLimiter {
  private readonly key: string;
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: TokenBucketOptions) {
    this.key = opts.key ?? 'ratelimit:jira:tokens';
    this.ratePerSec = opts.ratePerSec ?? DEFAULT_RATE_LIMIT_PER_SEC;
    this.burst = opts.burst ?? this.ratePerSec;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async acquire(): Promise<void> {
    for (;;) {
      const waitMs = await this.opts.store.tryAcquire(this.key, this.ratePerSec, this.burst);
      if (waitMs === 0) return;
      await this.sleep(waitMs);
    }
  }
}
