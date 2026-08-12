import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  loginRequestSchema,
  updateLdapConfigRequestSchema,
  type AuthModeResponse,
  type LdapConfigView,
  type LdapTestResponse,
  type Principal,
  type UpdateLdapConfigRequest,
} from '@app/shared';
import { SecretBoxError, type LdapConfigRow } from '@app/db';
import { ApiError } from '../services/phase-config.service.js';
import {
  authenticate,
  testConnection,
  type LdapClientFactory,
  type LdapEffectiveConfig,
} from '../services/ldap.service.js';
import { normalizeIdentity } from '../adapters/principal.js';
import type { AuthzGuards } from '../adapters/project-scope.js';
import type { LdapConfigStore } from '../adapters/ldap-config.adapters.js';
import {
  clearSessionCookieHeader,
  isHttpsRequest,
  sessionCookieHeader,
  sessionIdOf,
  type SessionStore,
} from '../adapters/session.adapters.js';
import type { TokenBox } from './projects.routes.js';

/**
 * Đăng nhập LDAP in-app + quản trị cấu hình LDAP.
 *
 *   GET  /api/auth/mode            (PUBLIC) chế độ đăng nhập hiệu lực
 *   POST /auth/login               (PUBLIC) username/password → phiên + cookie
 *   POST /auth/logout                        huỷ phiên, xoá cookie
 *   GET  /api/admin/auth/ldap      (ADMIN)  xem cấu hình (không bao giờ có password)
 *   PUT  /api/admin/auth/ldap      (ADMIN)  lưu cấu hình (chống tự khoá khi bật)
 *   POST /api/admin/auth/ldap/test (ADMIN)  chạy test 3 bước với giá trị chưa lưu
 *
 * Bind password của tài khoản dịch vụ là WRITE-ONLY, cùng quy ước với token
 * Jira: nhận vào thì mã hoá (AES-256-GCM) rồi lưu, API chỉ trả `hasBindPassword`.
 * Không log, không echo, không trả lại dưới bất kỳ dạng nào.
 *
 * Lỗi đăng nhập LUÔN chung chung ("sai tên đăng nhập hoặc mật khẩu") — không
 * phân biệt sai-user với sai-password, không nhắc lại username trong response.
 */

export interface AuthRouteDeps {
  resolvePrincipal(req: FastifyRequest): Principal | null;
  readonly guards: AuthzGuards;
  /** Đọc/ghi TƯƠI cho màn hình admin. */
  readonly configs: LdapConfigStore;
  /** Đọc QUA CACHE (~10s) cho mode/login — gọi trên đường nóng. */
  loadConfig(): Promise<LdapConfigRow | null>;
  /** Vô hiệu cache sau khi admin lưu. */
  invalidateConfig(): void;
  readonly sessions: SessionStore;
  readonly clientFactory: LdapClientFactory;
  /** Hộp seal/open bind password — `null` khi APP_ENCRYPTION_KEY chưa đặt. */
  readonly tokenBox: TokenBox | null;
  /** env AUTH_FORCE_HEADER=1 — ép chế độ header dù LDAP bật. */
  readonly forceHeader: boolean;
  /** Đồng hồ tiêm được cho throttle; mặc định Date.now. */
  now?(): number;
}

// ---------------------------------------------------------------------------
// Throttle đăng nhập theo IP
// ---------------------------------------------------------------------------

export const LOGIN_THROTTLE_WINDOW_MS = 5 * 60 * 1000;
export const LOGIN_THROTTLE_MAX_FAILURES = 10;

/**
 * Đếm lượt đăng nhập SAI theo IP trong cửa sổ trượt 5 phút — quá 10 lượt thì
 * 429. Chủ đích là ghìm brute-force mật khẩu qua form, không phải rate limit
 * tổng quát.
 *
 * GIỚI HẠN BIẾT TRƯỚC: bộ đếm nằm TRONG BỘ NHỚ TIẾN TRÌNH. Chạy nhiều bản API
 * sau load balancer thì mỗi bản đếm riêng (kẻ tấn công được N×10 lượt), và
 * restart là xoá sạch bộ đếm. Với quy mô nội bộ của app này thế là đủ; cần
 * chặt hơn thì chuyển bộ đếm sang Redis.
 */
function createLoginThrottle(now: () => number) {
  const failures = new Map<string, number[]>();

  const prune = (ip: string): number[] => {
    const cutoff = now() - LOGIN_THROTTLE_WINDOW_MS;
    const kept = (failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) failures.delete(ip);
    else failures.set(ip, kept);
    return kept;
  };

  return {
    isBlocked(ip: string): boolean {
      return prune(ip).length >= LOGIN_THROTTLE_MAX_FAILURES;
    },
    recordFailure(ip: string): void {
      // Dọn mục hết hạn trước khi ghi để Map không phình vô hạn theo thời gian.
      failures.set(ip, [...prune(ip), now()]);
    },
  };
}

// ---------------------------------------------------------------------------
// View + cấu hình hiệu lực
// ---------------------------------------------------------------------------

/** Giá trị mặc định khi CHƯA từng lưu config — khớp default của DB/schema. */
const EMPTY_VIEW: LdapConfigView = {
  enabled: false,
  serverUrl: null,
  bindDn: null,
  hasBindPassword: false,
  userDnTemplate: null,
  searchBase: null,
  userFilter: '(mail={username})',
  emailAttribute: 'mail',
  allowSelfSigned: false,
  sessionTtlHours: 12,
  updatedBy: null,
  updatedAt: null,
};

function toView(row: LdapConfigRow | null): LdapConfigView {
  if (row === null) return EMPTY_VIEW;
  return {
    enabled: row.enabled,
    serverUrl: row.serverUrl,
    bindDn: row.bindDn,
    // WRITE-ONLY: chỉ báo CÓ/KHÔNG, tuyệt đối không đưa bindPasswordEnc ra.
    hasBindPassword: row.bindPasswordEnc !== null,
    userDnTemplate: row.userDnTemplate,
    searchBase: row.searchBase,
    userFilter: row.userFilter,
    emailAttribute: row.emailAttribute,
    allowSelfSigned: row.allowSelfSigned,
    sessionTtlHours: row.sessionTtlHours,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const ENCRYPTION_KEY_MISSING_SAVE =
  'Chưa đặt APP_ENCRYPTION_KEY nên không thể lưu bind password một cách an toàn. ' +
  'Sinh khóa bằng: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" ' +
  'rồi đặt vào biến môi trường APP_ENCRYPTION_KEY (cả api lẫn worker) và thử lại.';

const ENCRYPTION_KEY_MISSING_OPEN =
  'Cấu hình LDAP có bind password đã mã hóa nhưng APP_ENCRYPTION_KEY chưa được đặt (hoặc sai khóa) ' +
  'nên không giải mã được. Khôi phục khóa cũ hoặc nhập lại bind password rồi thử lại.';

const LOGIN_FAILED_MESSAGE = 'Tên đăng nhập hoặc mật khẩu không đúng.';

/**
 * Bind password HIỆU LỰC cho một lượt test/lưu: chuỗi trong body thắng;
 * không gửi trường (undefined) → giải mã password ĐANG LƯU; null → không có.
 */
function effectiveBindPassword(
  requested: string | null | undefined,
  stored: LdapConfigRow | null,
  tokenBox: TokenBox | null,
): string | null {
  if (typeof requested === 'string') return requested;
  if (requested === null) return null;
  if (stored === null || stored.bindPasswordEnc === null) return null;
  if (tokenBox === null) {
    throw new ApiError(400, 'ENCRYPTION_KEY_MISSING', ENCRYPTION_KEY_MISSING_OPEN);
  }
  try {
    return tokenBox.open(stored.bindPasswordEnc);
  } catch (err) {
    if (err instanceof SecretBoxError) {
      throw new ApiError(400, 'ENCRYPTION_KEY_MISSING', ENCRYPTION_KEY_MISSING_OPEN);
    }
    throw err;
  }
}

function effectiveConfigOf(
  data: UpdateLdapConfigRequest,
  bindPassword: string | null,
): LdapEffectiveConfig {
  return {
    serverUrl: data.serverUrl,
    bindDn: data.bindDn,
    bindPassword,
    userDnTemplate: data.userDnTemplate,
    searchBase: data.searchBase,
    userFilter: data.userFilter,
    emailAttribute: data.emailAttribute,
    allowSelfSigned: data.allowSelfSigned,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const now = deps.now ?? (() => Date.now());
  const throttle = createLoginThrottle(now);

  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      const out = await fn();
      if (!reply.sent) await reply.send(out);
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      app.log.error({ err }, 'Lỗi ngoài dự kiến ở nhóm API xác thực');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const admin = { preHandler: deps.guards.requireAdmin };

  /** LDAP có đang là chế độ đăng nhập HIỆU LỰC không (config bật + không bị ép header). */
  const ldapActive = async (): Promise<LdapConfigRow | null> => {
    if (deps.forceHeader) return null;
    const cfg = await deps.loadConfig();
    return cfg !== null && cfg.enabled ? cfg : null;
  };

  // ---- Chế độ đăng nhập (PUBLIC — web hỏi trước khi vẽ form) ----------------

  app.get('/api/auth/mode', async (_req, reply) =>
    handle(reply, async (): Promise<AuthModeResponse> => ({
      mode: (await ldapActive()) !== null ? 'LDAP' : 'HEADER',
    })),
  );

  // ---- Đăng nhập / đăng xuất (PUBLIC) ---------------------------------------

  app.post('/auth/login', async (req, reply) =>
    handle(reply, async () => {
      const cfg = await ldapActive();
      if (cfg === null) {
        // LDAP không hiệu lực thì endpoint này "không tồn tại" — web dựa vào
        // /api/auth/mode, còn ai mò tới đây cũng không dò được gì thêm.
        throw new ApiError(
          404,
          'AUTH_MODE_HEADER',
          'Đăng nhập trong ứng dụng đang tắt — hệ thống nhận danh tính từ cổng SSO.',
        );
      }

      // Throttle TRƯỚC khi chạm LDAP: bị khoá thì không tốn một lượt bind nào.
      const ip = req.ip;
      if (throttle.isBlocked(ip)) {
        throw new ApiError(
          429,
          'TOO_MANY_ATTEMPTS',
          'Quá nhiều lần đăng nhập sai. Đợi vài phút rồi thử lại.',
        );
      }

      const parsed = loginRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, 'BAD_REQUEST', 'Cần đủ tên đăng nhập và mật khẩu.');
      }

      const config = effectiveConfigOfRow(cfg, deps.tokenBox);
      const result = await authenticate({
        config,
        username: parsed.data.username,
        password: parsed.data.password,
        clientFactory: deps.clientFactory,
        // Chi tiết (DN, số entry khớp…) CHỈ vào log server. KHÔNG BAO GIỜ log
        // mật khẩu — hàm authenticate không đưa password vào detail.
        log: (detail) => app.log.warn({ event: 'auth.ldap', detail }, 'Đăng nhập LDAP'),
      });

      if ('error' in result) {
        if (result.error === 'LOGIN_FAILED') {
          throttle.recordFailure(ip);
          // Chung chung có chủ đích: không phân biệt sai-user/sai-password,
          // không nhắc lại username.
          throw new ApiError(401, 'LOGIN_FAILED', LOGIN_FAILED_MESSAGE);
        }
        if (result.error === 'SERVER_UNREACHABLE') {
          throw new ApiError(
            502,
            'LDAP_UNREACHABLE',
            'Không kết nối được máy chủ LDAP. Thử lại sau hoặc báo quản trị viên.',
          );
        }
        throw new ApiError(
          500,
          'CONFIG_INVALID',
          'Cấu hình đăng nhập trên máy chủ chưa đầy đủ. Báo quản trị viên kiểm tra cấu hình LDAP.',
        );
      }

      const email = normalizeIdentity(result.email);
      if (email === null) {
        throttle.recordFailure(ip);
        throw new ApiError(401, 'LOGIN_FAILED', LOGIN_FAILED_MESSAGE);
      }

      const sessionId = await deps.sessions.create(email, cfg.sessionTtlHours);
      await reply
        .header(
          'set-cookie',
          sessionCookieHeader(sessionId, {
            maxAgeS: cfg.sessionTtlHours * 3600,
            secure: isHttpsRequest(req),
          }),
        )
        .status(204)
        .send();
    }),
  );

  app.post('/auth/logout', async (req, reply) =>
    handle(reply, async () => {
      const sessionId = sessionIdOf(req);
      if (sessionId !== null) await deps.sessions.destroy(sessionId);
      // Xoá cookie kể cả khi không có phiên — logout luôn "thành công".
      await reply
        .header('set-cookie', clearSessionCookieHeader(isHttpsRequest(req)))
        .status(204)
        .send();
    }),
  );

  // ---- Quản trị cấu hình LDAP (ADMIN) ---------------------------------------

  app.get('/api/admin/auth/ldap', admin, async (_req, reply) =>
    handle(reply, async (): Promise<LdapConfigView> => toView(await deps.configs.find())),
  );

  app.put('/api/admin/auth/ldap', admin, async (req, reply) =>
    handle(reply, async (): Promise<LdapConfigView> => {
      const adminPrincipal = deps.resolvePrincipal(req)!;

      const parsed = updateLdapConfigRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Cấu hình không hợp lệ: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
        );
      }
      const data = parsed.data;

      // Khai cả hai (hoặc không khai gì) là mơ hồ — server không đoán hộ.
      if ((data.userDnTemplate !== null) === (data.searchBase !== null)) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Phải khai đúng MỘT trong hai: User DN template (direct bind) hoặc Search base (search-then-bind).',
        );
      }

      const before = await deps.configs.find();

      // bindPassword: undefined = GIỮ password cũ; null = XÓA; chuỗi = mã hóa
      // rồi lưu (cùng quy ước tri-state với token Jira).
      let bindPasswordEnc: string | null | undefined;
      if (data.bindPassword === undefined) bindPasswordEnc = undefined;
      else if (data.bindPassword === null) bindPasswordEnc = null;
      else {
        if (deps.tokenBox === null) {
          // KHÔNG được lưu password thô — thà từ chối rõ ràng (C-9).
          throw new ApiError(400, 'ENCRYPTION_KEY_MISSING', ENCRYPTION_KEY_MISSING_SAVE);
        }
        bindPasswordEnc = deps.tokenBox.seal(data.bindPassword);
      }

      // CHỐNG TỰ KHÓA: bật LDAP hỏng là mọi người (kể cả admin) hết đường vào
      // — header bị bỏ qua ngay khi enabled=true có hiệu lực. Vì vậy
      // enabled=true PHẢI qua bài test kết nối với đúng cấu hình sẽ lưu
      // (password giữ lại được GIẢI MÃ để test là thật).
      if (data.enabled) {
        const testResult = await testConnection({
          config: effectiveConfigOf(
            data,
            effectiveBindPassword(data.bindPassword, before, deps.tokenBox),
          ),
          clientFactory: deps.clientFactory,
        });
        if (!testResult.ok) {
          const failed = testResult.steps.find((s) => !s.ok);
          throw new ApiError(
            400,
            'LDAP_TEST_FAILED',
            `Không bật được LDAP vì bài test thất bại ở bước ${failed?.step ?? '?'}: ` +
              `${failed?.detail ?? 'không rõ'} — bật LDAP hỏng là tự khóa mình ra ngoài. ` +
              'Sửa cấu hình (hoặc lưu với enabled=false) rồi thử lại.',
          );
        }
      }

      await deps.configs.upsert({
        enabled: data.enabled,
        serverUrl: data.serverUrl,
        bindDn: data.bindDn,
        ...(bindPasswordEnc !== undefined ? { bindPasswordEnc } : {}),
        userDnTemplate: data.userDnTemplate,
        searchBase: data.searchBase,
        userFilter: data.userFilter,
        emailAttribute: data.emailAttribute,
        allowSelfSigned: data.allowSelfSigned,
        sessionTtlHours: data.sessionTtlHours,
        updatedBy: adminPrincipal.userId,
      });
      // Loader đường nóng cache ~10s — vô hiệu để tiến trình này thấy ngay.
      deps.invalidateConfig();

      return toView(await deps.configs.find());
    }),
  );

  app.post('/api/admin/auth/ldap/test', admin, async (req, reply) =>
    handle(reply, async (): Promise<LdapTestResponse> => {
      // Cho phép thử với giá trị CHƯA LƯU (điền form rồi bấm Test trước khi
      // Save). bindPassword không gửi → dùng password ĐANG LƯU (giải mã).
      const parsed = updateLdapConfigRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Cấu hình không hợp lệ: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
        );
      }
      const stored = await deps.configs.find();
      return testConnection({
        config: effectiveConfigOf(
          parsed.data,
          effectiveBindPassword(parsed.data.bindPassword, stored, deps.tokenBox),
        ),
        clientFactory: deps.clientFactory,
      });
    }),
  );
}

/** Cấu hình hiệu lực từ dòng ĐÃ LƯU (giải mã bind password nếu có). */
function effectiveConfigOfRow(row: LdapConfigRow, tokenBox: TokenBox | null): LdapEffectiveConfig {
  let bindPassword: string | null = null;
  if (row.bindPasswordEnc !== null) {
    if (tokenBox === null) {
      // Có password mã hóa mà mất khóa → authenticate sẽ trả CONFIG_INVALID
      // (search-then-bind thiếu credential) → 500 với thông điệp an toàn.
      bindPassword = null;
    } else {
      try {
        bindPassword = tokenBox.open(row.bindPasswordEnc);
      } catch (err) {
        if (!(err instanceof SecretBoxError)) throw err;
        bindPassword = null;
      }
    }
  }
  return {
    serverUrl: row.serverUrl,
    bindDn: row.bindDn,
    bindPassword,
    userDnTemplate: row.userDnTemplate,
    searchBase: row.searchBase,
    userFilter: row.userFilter,
    emailAttribute: row.emailAttribute,
    allowSelfSigned: row.allowSelfSigned,
  };
}
