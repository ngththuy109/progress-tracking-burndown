/**
 * Lớp gọi API — NƠI DUY NHẤT trong `apps/web` được phép gọi `fetch`.
 *
 * Vì sao gom về một chỗ: mọi màn hình đều phải xử lý ba trạng thái giống nhau
 * (đang tải / lỗi / rỗng). Nếu component tự gọi `fetch` thì tới màn hình thứ ba
 * mỗi chỗ sẽ xử lý lỗi một kiểu, và không ai gỡ lại được nữa.
 *
 * Ba việc lớp này làm, không việc nào khác:
 *   1. Ghép URL và gửi request.
 *   2. Đổi MỌI lỗi thành `ApiError` có mã và câu nói rõ cách khắc phục.
 *   3. Kiểm dữ liệu trả về bằng zod NGAY TẠI BIÊN.
 *
 * Việc lớp này KHÔNG làm: **không tự thử lại**. TanStack Query lo phần đó
 * (`api/query-client.ts`) và nó biết thêm ngữ cảnh mà chỗ này không biết —
 * query nào còn được quan tâm, người dùng còn ở màn hình đó không.
 */

/**
 * Bất cứ thứ gì có `.parse()`.
 *
 * Khai theo hình dạng thay vì buộc kiểu `ZodType` để `apps/web` không cần phụ
 * thuộc trực tiếp vào zod — mọi schema của `@app/shared` đều khớp sẵn.
 */
export interface ResponseParser<T> {
  parse(input: unknown): T;
}

/** Một lỗi cụ thể của một trường, do API trả kèm khi HTTP 400. */
export interface ApiErrorIssue {
  readonly level: 'ERROR' | 'WARNING';
  readonly code: string;
  readonly message: string;
  /** Đường dẫn tới đúng trường gây lỗi, để màn hình neo thông báo. */
  readonly path: string | null;
}

export interface ApiErrorArgs {
  readonly code: string;
  readonly message: string;
  /** `null` khi request còn chưa tới được máy chủ. */
  readonly status: number | null;
  readonly issues?: readonly ApiErrorIssue[] | undefined;
  readonly cause?: unknown;
}

/**
 * Lỗi DUY NHẤT mà lớp API ném ra.
 *
 * `message` LUÔN là câu người dùng đọc được, và luôn nói cả điều sai lẫn cách
 * khắc phục (CONVENTIONS.md C-9). Câu thô của trình duyệt — `Failed to fetch`,
 * `Unexpected token < in JSON` — nằm ở `cause`, chỉ hiện trong phần "Technical
 * details" của `ErrorState`.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly issues: readonly ApiErrorIssue[];

  constructor(args: ApiErrorArgs) {
    super(args.message, { cause: args.cause });
    this.name = 'ApiError';
    this.code = args.code;
    this.status = args.status;
    this.issues = args.issues ?? [];
  }
}

// ---------------------------------------------------------------------------
// Câu chữ cho từng mã HTTP
// ---------------------------------------------------------------------------

/**
 * Câu dùng khi máy chủ KHÔNG kèm `message` — ví dụ khi lỗi đến từ proxy hoặc
 * cân bằng tải, chúng trả HTML chứ không trả JSON của mình.
 *
 * Mỗi câu gồm hai phần: điều gì sai, và người dùng làm gì tiếp (C-9).
 */
export function fallbackMessage(status: number): { code: string; message: string } {
  if (status === 400) {
    return {
      code: 'BAD_REQUEST',
      message: 'Some of the values you sent are not valid. Fix the highlighted fields and try again.',
    };
  }
  if (status === 401) {
    return {
      code: 'UNAUTHENTICATED',
      message: 'Your session has expired. Reload the page to sign in again.',
    };
  }
  if (status === 403) {
    return {
      code: 'FORBIDDEN',
      message: 'You do not have permission to do this. Ask an admin if you need access.',
    };
  }
  if (status === 404) {
    return {
      code: 'NOT_FOUND',
      message: 'Not found. It may have just been deleted — reload the list and try again.',
    };
  }
  if (status === 409) {
    return {
      code: 'CONFLICT',
      message: 'Someone else just changed this data. Reload the page to get the latest version, then retry.',
    };
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      message: 'The server is busy. Wait about a minute, then click "Try again".',
    };
  }
  if (status >= 500) {
    return {
      code: 'SERVER_ERROR',
      message:
        'The server failed while handling this request. Try again in a few minutes; if it keeps failing, send the error code below to your dev team.',
    };
  }
  return {
    code: 'HTTP_ERROR',
    message: `The server returned error ${status}. Try again; if it keeps failing, send the error code below to your dev team.`,
  };
}

export const NETWORK_ERROR_MESSAGE =
  'Cannot reach the server. Check your network, make sure the API is running, then click "Try again".';

export const RESPONSE_SHAPE_MESSAGE =
  'The server returned data in an unexpected format, so this screen cannot display it. ' +
  'This is a system problem, not something you did wrong — send the error code below to your dev team.';

// ---------------------------------------------------------------------------
// Ghép URL
// ---------------------------------------------------------------------------

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Readonly<Record<string, QueryValue>>;

export function buildUrl(baseUrl: string, path: string, query?: QueryParams | undefined): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    // CẠM BẪY: `String(undefined)` cho ra chuỗi `"undefined"`. Không bỏ qua ở
    // đây thì API nhận `?project=undefined` và đi tìm một project tên là
    // "undefined" — trả về rỗng, không báo lỗi, và mất cả buổi để lần ra.
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return `${baseUrl}${path}${qs === '' ? '' : `?${qs}`}`;
}

/**
 * Ghép đường dẫn API THEO PHẠM VI DỰ ÁN (multi-tenant).
 *
 * Mọi endpoint nghiệp vụ nằm dưới `/api/projects/:projectKey/...`; helper này
 * là NƠI DUY NHẤT ghép tiền tố đó. `projectKey` được encode phòng ký tự lạ —
 * key hợp lệ vốn chỉ có A-Z0-9_, nhưng giá trị đến từ URL nên không tin sẵn.
 */
export function projectApiPath(projectKey: string, suffix: string): string {
  return `/projects/${encodeURIComponent(projectKey)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Đọc thân lỗi do API trả về
// ---------------------------------------------------------------------------

interface ServerErrorBody {
  readonly code: string | null;
  readonly message: string | null;
  readonly issues: readonly ApiErrorIssue[];
}

const EMPTY_ERROR_BODY: ServerErrorBody = { code: null, message: null, issues: [] };

async function readErrorBody(res: Response): Promise<ServerErrorBody> {
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    // Không phải JSON: gần như chắc chắn là trang lỗi HTML của proxy. Không có
    // gì đọc được thì dùng câu mặc định, đừng bịa.
    return EMPTY_ERROR_BODY;
  }
  if (raw === null || typeof raw !== 'object') return EMPTY_ERROR_BODY;

  const obj = raw as Record<string, unknown>;
  return {
    code: typeof obj['error'] === 'string' ? obj['error'] : null,
    message: typeof obj['message'] === 'string' ? obj['message'] : null,
    issues: readIssues(obj['issues']),
  };
}

function readIssues(raw: unknown): readonly ApiErrorIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: ApiErrorIssue[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o['message'] !== 'string') continue;
    out.push({
      level: o['level'] === 'WARNING' ? 'WARNING' : 'ERROR',
      code: typeof o['code'] === 'string' ? o['code'] : 'UNKNOWN',
      message: o['message'],
      path: typeof o['path'] === 'string' ? o['path'] : null,
    });
  }
  return out;
}

/**
 * Query bị huỷ (đổi màn hình, đổi tham số lọc) KHÔNG phải là lỗi.
 *
 * Bọc nó thành `ApiError` sẽ làm màn hình chớp một thông báo đỏ mỗi lần người
 * dùng gõ vào ô tìm kiếm.
 */
function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions<T> {
  readonly parser: ResponseParser<T>;
  readonly method?: HttpMethod | undefined;
  readonly body?: unknown;
  readonly query?: QueryParams | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface CallOptions {
  readonly query?: QueryParams | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ApiClient {
  request<T>(path: string, options: RequestOptions<T>): Promise<T>;
  get<T>(path: string, parser: ResponseParser<T>, options?: CallOptions): Promise<T>;
  post<T>(path: string, body: unknown, parser: ResponseParser<T>, options?: CallOptions): Promise<T>;
  put<T>(path: string, body: unknown, parser: ResponseParser<T>, options?: CallOptions): Promise<T>;
  patch<T>(path: string, body: unknown, parser: ResponseParser<T>, options?: CallOptions): Promise<T>;
  delete<T>(path: string, parser: ResponseParser<T>, options?: CallOptions): Promise<T>;
}

export interface ApiClientOptions {
  readonly baseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** Cùng gốc với trang web; Vite proxy chuyển tiếp sang API khi chạy dev. */
export const DEFAULT_BASE_URL = '/api';

/** Parser cho endpoint không trả thân (HTTP 204). */
export const noContent: ResponseParser<null> = { parse: () => null };

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  // CẠM BẪY: `const f = options.fetchImpl ?? globalThis.fetch` rồi gọi `f(...)`
  // làm mất liên kết `this` với `window`, và một số trình duyệt ném
  // "Illegal invocation". Bọc lại bằng mũi tên là xong.
  const doFetch: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(path: string, opts: RequestOptions<T>): Promise<T> {
    const url = buildUrl(baseUrl, path, opts.query);
    const hasBody = opts.body !== undefined;

    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers: hasBody ? { 'Content-Type': 'application/json' } : {},
      // Gửi kèm cookie phiên đăng nhập do cổng SSO đặt. Cùng gốc thì trình duyệt
      // vốn đã gửi, nhưng khai `include` tường minh để không phụ thuộc mặc định
      // (và vẫn đúng nếu sau này API nằm khác gốc).
      credentials: 'include',
      ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (cause) {
      if (isAbort(cause)) throw cause;
      throw new ApiError({
        code: 'NETWORK',
        message: NETWORK_ERROR_MESSAGE,
        status: null,
        cause,
      });
    }

    if (!res.ok) {
      const body = await readErrorBody(res);
      const fallback = fallbackMessage(res.status);
      throw new ApiError({
        // Câu của máy chủ cụ thể hơn câu mặc định nên được ưu tiên — API vốn đã
        // viết sẵn thông báo cho người dùng đọc.
        code: body.code ?? fallback.code,
        message: body.message ?? fallback.message,
        status: res.status,
        issues: body.issues,
      });
    }

    let payload: unknown = null;
    if (res.status !== 204) {
      try {
        payload = await res.json();
      } catch (cause) {
        throw new ApiError({
          code: 'RESPONSE_NOT_JSON',
          message: RESPONSE_SHAPE_MESSAGE,
          status: res.status,
          cause,
        });
      }
    }

    try {
      // Kiểm NGAY TẠI BIÊN. Bỏ bước này thì một trường thiếu sẽ lộ ra dưới dạng
      // `undefined` ở giữa màn hình, cách chỗ gây lỗi rất xa.
      return opts.parser.parse(payload);
    } catch (cause) {
      throw new ApiError({
        code: 'RESPONSE_SHAPE_INVALID',
        message: RESPONSE_SHAPE_MESSAGE,
        status: res.status,
        cause,
      });
    }
  }

  const withBody =
    (method: HttpMethod) =>
    <T>(path: string, body: unknown, parser: ResponseParser<T>, opts: CallOptions = {}): Promise<T> =>
      request(path, { parser, method, body, ...opts });

  return {
    request,
    get: (path, parser, opts = {}) => request(path, { parser, method: 'GET', ...opts }),
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
    delete: (path, parser, opts = {}) => request(path, { parser, method: 'DELETE', ...opts }),
  };
}

/** Đọc gốc API từ biến môi trường của Vite; mặc định là cùng gốc với trang. */
function baseUrlFromEnv(): string {
  const env: unknown = import.meta.env;
  if (env === null || typeof env !== 'object') return DEFAULT_BASE_URL;
  const value = (env as Record<string, unknown>)['VITE_API_BASE_URL'];
  return typeof value === 'string' && value !== '' ? value : DEFAULT_BASE_URL;
}

/** Bản dùng chung của cả app. Test tự tạo bản riêng bằng `createApiClient`. */
export const apiClient: ApiClient = createApiClient({ baseUrl: baseUrlFromEnv() });
