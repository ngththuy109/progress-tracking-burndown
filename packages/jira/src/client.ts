import pLimit from 'p-limit';
import { type CredentialProvider, BasicAuthProvider, redactHeaders } from './credentials.js';
import {
  type RateLimiter,
  TokenBucketRateLimiter,
  InMemoryTokenBucketStore,
} from './rate-limiter.js';
import { JiraHttpError, parseRetryAfter, withRetry, type RetryOptions } from './retry.js';

/** Số request đồng thời tối đa (CONVENTIONS.md C-7). Đặt cao hơn sẽ bị Jira trả 429. */
export const MAX_CONCURRENT_JIRA_CALLS = 8;

export interface JiraClientOptions {
  readonly credentials?: CredentialProvider;
  readonly rateLimiter?: RateLimiter;
  readonly concurrency?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retry?: RetryOptions;
  readonly logger?: (event: Record<string, unknown>) => void;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
}

/**
 * Client gọi Jira Cloud REST API v3.
 *
 * CHỈ ĐỌC. Không có endpoint ghi nào — hệ thống không bao giờ sửa dữ liệu trên
 * Jira (PRD §1.4).
 */
export class JiraClient {
  private readonly credentials: CredentialProvider;
  private readonly rateLimiter: RateLimiter;
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly fetchImpl: typeof fetch;
  private readonly retryOpts: RetryOptions;
  private readonly logger: (event: Record<string, unknown>) => void;

  /** Đếm để T-11 ghi vào `sync_run.rate_limit_hits`. */
  private _apiCalls = 0;
  private _rateLimitHits = 0;

  constructor(opts: JiraClientOptions = {}) {
    this.credentials = opts.credentials ?? new BasicAuthProvider();
    this.rateLimiter =
      opts.rateLimiter ??
      new TokenBucketRateLimiter({ store: new InMemoryTokenBucketStore(() => Date.now()) });
    this.limit = pLimit(opts.concurrency ?? MAX_CONCURRENT_JIRA_CALLS);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger ?? (() => {});
    this.retryOpts = {
      ...opts.retry,
      onRateLimited: () => {
        this._rateLimitHits++;
        opts.retry?.onRateLimited?.();
      },
    };
  }

  get apiCallsMade(): number {
    return this._apiCalls;
  }

  get rateLimitHits(): number {
    return this._rateLimitHits;
  }

  resetCounters(): void {
    this._apiCalls = 0;
    this._rateLimitHits = 0;
  }

  /** Gọi một endpoint. Tự giãn tốc độ, giới hạn song song và thử lại. */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.limit(() =>
      withRetry(async () => {
        await this.rateLimiter.acquire();

        const { baseUrl, authHeader } = await this.credentials.get();
        const url = new URL(`${baseUrl}${path}`);
        for (const [k, v] of Object.entries(opts.query ?? {})) {
          if (v !== undefined) url.searchParams.set(k, String(v));
        }

        const headers: Record<string, string> = {
          Authorization: authHeader,
          Accept: 'application/json',
        };
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

        this._apiCalls++;
        this.logger({
          msg: 'jira.request',
          method: opts.method ?? 'GET',
          url: url.toString(),
          // C-9: cấm ghi token vào log
          headers: redactHeaders(headers),
        });

        const res = await this.fetchImpl(url.toString(), {
          method: opts.method ?? 'GET',
          headers,
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new JiraHttpError(
            res.status,
            url.toString(),
            body,
            parseRetryAfter(res.headers.get('retry-after'), Date.now()),
          );
        }

        return (await res.json()) as T;
      }, this.retryOpts),
    );
  }
}
