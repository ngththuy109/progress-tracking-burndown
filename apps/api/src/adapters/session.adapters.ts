import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/**
 * Phiên đăng nhập SSO in-app — lưu trên Redis, nhận diện qua cookie `ptb_sess`.
 *
 * VÌ SAO KHÔNG KÝ COOKIE: giá trị cookie chỉ là một session id 32 byte (256 bit)
 * ngẫu nhiên từ CSPRNG, còn nội dung phiên nằm HOÀN TOÀN phía server (Redis).
 * Kẻ tấn công muốn giả phiên phải ĐOÁN TRÚNG 256 bit — khó ngang bẻ chính khoá
 * ký. Chữ ký (kiểu @fastify/cookie signed) chỉ cần khi cookie MANG dữ liệu;
 * ở đây nó không mang gì nên ký thêm chỉ tốn một secret phải quản lý.
 *
 * TTL đặt ngay trên key Redis (`EX`) — phiên tự bốc hơi đúng hạn kể cả khi
 * API không còn chạy, không cần cron dọn.
 */

// ---------------------------------------------------------------------------
// Cổng + hiện thực Redis
// ---------------------------------------------------------------------------

/** Phần Redis mà session store cần — ioredis cắm vừa, test dùng Map. */
export interface SessionRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

export interface SessionStore {
  /** Tạo phiên mới, trả session id (32 byte ngẫu nhiên, base64url). */
  create(userId: string, ttlHours: number): Promise<string>;
  find(sessionId: string): Promise<{ userId: string } | null>;
  destroy(sessionId: string): Promise<void>;
}

/** Trạng thái MỘT lượt đăng nhập OIDC đang dở (giữa /auth/login và /auth/callback). */
export interface LoginState {
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectTo: string;
}

export interface LoginStateStore {
  put(state: string, data: LoginState): Promise<void>;
  /** Lấy VÀ XOÁ — state là dùng-một-lần (chặn replay callback). */
  take(state: string): Promise<LoginState | null>;
}

/**
 * Token ngẫu nhiên từ CSPRNG, mã hoá base64url (an toàn cho cookie/URL).
 * 32 byte = 256 bit — xem chú thích "VÌ SAO KHÔNG KÝ COOKIE" ở đầu file.
 */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

const SESSION_KEY_PREFIX = 'sess:';
const LOGIN_STATE_KEY_PREFIX = 'ssostate:';

/** Lượt đăng nhập phải xong trong 10 phút — quá hạn thì state bốc hơi. */
export const LOGIN_STATE_TTL_S = 10 * 60;

export function createRedisSessionStore(redis: SessionRedis): SessionStore {
  return {
    async create(userId, ttlHours) {
      const sessionId = randomToken(32);
      await redis.set(
        `${SESSION_KEY_PREFIX}${sessionId}`,
        JSON.stringify({ userId }),
        'EX',
        Math.round(ttlHours * 3600),
      );
      return sessionId;
    },

    async find(sessionId) {
      const raw = await redis.get(`${SESSION_KEY_PREFIX}${sessionId}`);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as { userId?: unknown };
        return typeof parsed.userId === 'string' ? { userId: parsed.userId } : null;
      } catch {
        // Giá trị hỏng (ai đó ghi đè key) → coi như không có phiên, đừng nổ 500.
        return null;
      }
    },

    async destroy(sessionId) {
      await redis.del(`${SESSION_KEY_PREFIX}${sessionId}`);
    },
  };
}

export function createRedisLoginStateStore(redis: SessionRedis): LoginStateStore {
  return {
    async put(state, data) {
      await redis.set(
        `${LOGIN_STATE_KEY_PREFIX}${state}`,
        JSON.stringify(data),
        'EX',
        LOGIN_STATE_TTL_S,
      );
    },

    async take(state) {
      const key = `${LOGIN_STATE_KEY_PREFIX}${state}`;
      const raw = await redis.get(key);
      if (raw === null) return null;
      // Xoá NGAY sau khi đọc — mỗi state chỉ đổi được một phiên. GET rồi DEL
      // không nguyên tử, nhưng cửa sổ đua chỉ tồn tại khi kẻ tấn công đã có
      // ĐÚNG state 128-bit trong 10 phút hiệu lực — lúc đó vấn đề nằm ở chỗ khác.
      await redis.del(key);
      try {
        const parsed = JSON.parse(raw) as Partial<LoginState>;
        if (
          typeof parsed.nonce !== 'string' ||
          typeof parsed.verifier !== 'string' ||
          typeof parsed.redirectTo !== 'string'
        ) {
          return null;
        }
        return { nonce: parsed.nonce, verifier: parsed.verifier, redirectTo: parsed.redirectTo };
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Cookie — tự viết phần parse/serialize bé xíu thay vì thêm @fastify/cookie
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'ptb_sess';

/** Đọc header `Cookie` thành map tên → giá trị (giải mã URL nếu có). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    let value = part.slice(eq + 1).trim();
    // Một số client bọc giá trị trong dấu nháy kép (RFC 6265 cho phép).
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Session id trong header Cookie của request, nếu có. */
export function sessionIdOf(req: FastifyRequest): string | null {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * Request này tới qua HTTPS? Tin `x-forwarded-proto` (đứng sau reverse proxy
 * là chuyện mặc định của app này) rồi mới tới protocol của chính socket.
 */
export function isHttpsRequest(req: FastifyRequest): boolean {
  const fwd = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  if (first !== undefined && first !== '') return first === 'https';
  return req.protocol === 'https';
}

/**
 * Giá trị `Set-Cookie` cho phiên mới. HttpOnly chặn JS đọc trộm; SameSite=Lax
 * chặn CSRF cho mọi request "sâu" (POST/PUT từ site khác) mà vẫn cho phép
 * điều hướng top-level quay về từ IdP mang cookie theo.
 */
export function sessionCookieHeader(sessionId: string, args: { maxAgeS: number; secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(args.maxAgeS))}`,
  ];
  if (args.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Giá trị `Set-Cookie` XOÁ phiên (Max-Age=0 — trình duyệt vứt cookie ngay). */
export function clearSessionCookieHeader(secure: boolean): string {
  return sessionCookieHeader('', { maxAgeS: 0, secure });
}
