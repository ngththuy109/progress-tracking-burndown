import pLimit from 'p-limit';
import { type CredentialProvider, BasicAuthProvider, redactHeaders } from './credentials.js';
import {
  type RateLimiter,
  TokenBucketRateLimiter,
  InMemoryTokenBucketStore,
} from './rate-limiter.js';
import {
  JiraHttpError,
  JiraRequestTimeoutError,
  parseRetryAfter,
  withRetry,
  type RetryOptions,
} from './retry.js';

/** Số request đồng thời tối đa (CONVENTIONS.md C-7). Đặt cao hơn sẽ bị Jira trả 429. */
export const MAX_CONCURRENT_JIRA_CALLS = 8;

/**
 * Hạn chót cho MỘT request Jira, mặc định 30 giây.
 *
 * `fetch` của Node KHÔNG có hạn — thiếu nó thì một kết nối treo (server bắt tay
 * TCP nhưng không trả byte nào) để `await` chờ MÃI MÃI, và cả job đứng im không
 * bao giờ kết thúc. 30s dư sức cho một response Jira bình thường (<5s), chỉ bắn
 * khi server thật sự treo. Chỉnh qua `JIRA_REQUEST_TIMEOUT_MS` cho mạng chậm.
 */
export const DEFAULT_JIRA_REQUEST_TIMEOUT_MS = 30_000;

export interface JiraClientOptions {
  readonly credentials?: CredentialProvider;
  readonly rateLimiter?: RateLimiter;
  readonly concurrency?: number;
  readonly fetchImpl?: typeof fetch;
  readonly retry?: RetryOptions;
  readonly logger?: (event: Record<string, unknown>) => void;
  /** Hạn chót cho mỗi request (ms). Mặc định `DEFAULT_JIRA_REQUEST_TIMEOUT_MS`. */
  readonly requestTimeoutMs?: number;
}

/**
 * Lỗi này có phải do `AbortSignal.timeout` bắn không?
 *
 * `AbortSignal.timeout(ms)` huỷ bằng `DOMException` tên `'TimeoutError'`; huỷ tay
 * thì tên `'AbortError'`. Nhận theo `.name` để không phụ thuộc DOMException hay
 * Error, và để một `AbortError` rò ra từ lúc đọc body cũng được quy về treo.
 */
function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
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
  private readonly requestTimeoutMs: number;

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
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_JIRA_REQUEST_TIMEOUT_MS;
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

        // Hạn chót cho request: `fetch` của Node không tự có. Signal tạo NGAY
        // trước fetch (sau khi đã qua token bucket) nên hạn chỉ phủ phần gọi mạng
        // + đọc body, không tính thời gian chờ giãn tốc độ. Khi bắn, nó huỷ cả
        // fetch lẫn stream body đang đọc dở → không có nhánh nào treo lại.
        const signal = AbortSignal.timeout(this.requestTimeoutMs);
        try {
          const res = await this.fetchImpl(url.toString(), {
            method: opts.method ?? 'GET',
            headers,
            signal,
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
        } catch (err) {
          // Quá hạn/huỷ → lỗi treo rõ ràng để `withRetry` thử lại (như 5xx) rồi
          // ném hẳn nếu vẫn treo. JiraHttpError và các lỗi khác đi qua nguyên vẹn.
          if (isTimeoutAbort(err)) {
            throw new JiraRequestTimeoutError(url.toString(), this.requestTimeoutMs);
          }
          throw err;
        }
      }, this.retryOpts),
    );
  }
}
