/**
 * Thử lại khi Jira trả 429 hoặc 5xx — CONVENTIONS.md C-7.
 *
 * Ba quy tắc dễ làm sai:
 *
 * 1. CÓ header `Retry-After` thì ưu tiên TUYỆT ĐỐI, chờ đúng số giây Jira yêu cầu.
 *    Không dùng công thức lùi của mình.
 *
 * 2. Luôn CỘNG NHIỄU NGẪU NHIÊN. Nếu 20 job cùng bị 429 và cùng chờ đúng 4 giây,
 *    chúng sẽ lại đồng loạt gọi lại cùng lúc → 429 tiếp.
 *
 * 3. KHÔNG thử lại 4xx khác 429. Thử lại 404 là vô nghĩa và tốn quota; thử lại
 *    401 chỉ làm chậm thông báo "token sai" cho người vận hành.
 */

export const MAX_RETRIES = 5;
export const BASE_DELAY_MS = 1000;
export const MAX_JITTER_MS = 500;

export class JiraHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`Jira trả HTTP ${status} cho ${url}`);
    this.name = 'JiraHttpError';
  }
}

/**
 * Jira KHÔNG phản hồi trong hạn cho MỘT request — TCP có thể đã bắt tay nhưng
 * server treo, không trả byte nào.
 *
 * Vì sao cần một lớp lỗi riêng: `fetch` của Node KHÔNG có hạn mặc định, nên một
 * kết nối treo để `await` nằm chờ MÃI MÃI — job "đang chạy" vĩnh viễn, không bao
 * giờ xong cũng không bao giờ hỏng, và BullMQ cứ gia hạn khoá nên nó không hề
 * bị coi là "stalled". `client.ts` gắn hạn bằng `AbortSignal` rồi ném lỗi này để
 * biến "treo im lặng" thành lỗi thật. Coi như 5xx: ĐÁNG thử lại (server chỉ đang
 * chập chờn), nhưng có trần lần thử nên không thể chạy vô hạn.
 */
export class JiraRequestTimeoutError extends Error {
  constructor(
    public readonly url: string,
    public readonly ms: number,
  ) {
    super(`Jira không phản hồi ${url} trong ${ms}ms`);
    this.name = 'JiraRequestTimeoutError';
  }
}

/**
 * Nhận diện lỗi Jira "issue key không tồn tại" — issue đã BỊ XOÁ khỏi Jira.
 *
 * JQL tham chiếu một key đã bị xoá (`key = "X"`, `parent = "X"`, `key IN (...)`)
 * bị Jira Cloud trả **HTTP 400**, KHÔNG phải 404, kèm câu nguyên văn:
 *   "An issue with key 'X' does not exist for the field 'key'."
 * (xem chú thích `getIssue` trong endpoints.ts). Vì truy vấn `search/jql` do hệ
 * thống tự dựng nên LUÔN đúng cú pháp, một 400 mang đúng câu này gần như chắc
 * chắn nghĩa là key đã biến mất — nơi gọi coi đó là "Epic đã bị xoá" thay vì đổ
 * job với lỗi khó hiểu.
 *
 * Khớp CẢ "issue with key" LẪN "does not exist" để KHÔNG nhầm với 400 khác cũng
 * chứa "does not exist" (ví dụ tên field cấu hình sai: "Field 'X' does not
 * exist…"). Nhầm hai loại này sẽ xoá mềm nhầm toàn bộ Epic khi thực ra chỉ là
 * lỗi cấu hình.
 */
export function isIssueDoesNotExistError(err: unknown): boolean {
  if (!(err instanceof JiraHttpError) || err.status !== 400) return false;
  const body = err.body.toLowerCase();
  return body.includes('issue with key') && body.includes('does not exist');
}

/** Chỉ 429 và 5xx mới đáng thử lại. */
export function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Đọc header `Retry-After`. Jira trả về **số giây** hoặc **HTTP date** — xử lý cả hai.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);

  return undefined;
}

export interface RetryOptions {
  readonly maxRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Tách ra để test kiểm chứng được là nhiễu thật sự tồn tại. */
  readonly random?: () => number;
  readonly onRateLimited?: () => void;
}

/**
 * Khoảng chờ trước lần thử thứ `attempt` (đếm từ 0): 1s, 2s, 4s, 8s, 16s + nhiễu.
 */
export function backoffDelayMs(attempt: number, random: () => number): number {
  return BASE_DELAY_MS * 2 ** attempt + Math.floor(random() * MAX_JITTER_MS);
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Đáng thử lại: 429/5xx của Jira, HOẶC request treo quá hạn (coi như server
      // đang chập chờn). Mọi lỗi khác — 4xx, mất mạng (ECONNRESET), lỗi phân tích —
      // ném NGAY: thử lại 404/401 chỉ tốn quota và làm chậm thông báo cho vận hành.
      const retryable =
        (err instanceof JiraHttpError && isRetryable(err.status)) ||
        err instanceof JiraRequestTimeoutError;
      if (!retryable) throw err;
      if (attempt === maxRetries) break;

      if (err instanceof JiraHttpError && err.status === 429) opts.onRateLimited?.();

      // Retry-After của Jira ưu tiên tuyệt đối; không có (kể cả khi treo) thì dùng
      // công thức lùi.
      const delay =
        (err instanceof JiraHttpError ? err.retryAfterMs : undefined) ??
        backoffDelayMs(attempt, random);
      await sleep(delay);
    }
  }

  throw lastError;
}
