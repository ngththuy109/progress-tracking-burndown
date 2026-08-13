import { ResultCodeError } from 'ldapts';
import type { LdapTestResponse } from '@app/shared';

/**
 * Đăng nhập LDAP — logic thuần, KHÔNG chạm mạng trực tiếp.
 *
 * Mọi kết nối đi qua `LdapClientFactory` tiêm từ ngoài: production đưa vào
 * factory dựng `ldapts.Client` thật (main.ts), test đưa vào client giả. Nhờ
 * vậy toàn bộ nhánh lỗi (sai mật khẩu, server chết, filter hỏng…) kiểm được
 * bằng vitest mà không cần một server LDAP nào.
 *
 * Ba chế độ xác định user — SUY RA từ trường nào được khai:
 *   - Direct bind (OpenLDAP): CHỈ `userDnTemplate` chứa {username} → thế
 *     username (đã escape theo luật DN) rồi bind thẳng bằng mật khẩu người
 *     dùng; đọc email bằng base-read trên chính DN vừa bind.
 *   - Direct bind + tự tra email (Active Directory): `userDnTemplate` (vd
 *     `congty.vn\{username}` hoặc `{username}@congty.vn`) + `searchBase` +
 *     `userFilter`, KHÔNG có tài khoản dịch vụ. Bind bằng mật khẩu người dùng,
 *     rồi tra email bằng subtree search TRÊN CHÍNH KẾT NỐI ĐÓ — vì DN kiểu
 *     `DOMAIN\user`/UPN không đọc base được.
 *   - Search-then-bind (Active Directory): bind tài khoản dịch vụ → search
 *     `userFilter` (đã escape theo RFC 4515) trong `searchBase` → bind DN tìm
 *     được trên MỘT KẾT NỐI MỚI.
 *
 * AN TOÀN QUAN TRỌNG NHẤT: mật khẩu RỖNG bị từ chối TRƯỚC khi chạm client.
 * LDAP coi bind với mật khẩu rỗng là ANONYMOUS BIND và trả "thành công" —
 * không chặn sớm thì ai cũng đăng nhập được bằng ô mật khẩu bỏ trống.
 */

// ---------------------------------------------------------------------------
// Cổng client — ldapts cắm vừa, test dùng giả
// ---------------------------------------------------------------------------

// `attributes` để mutable (không readonly) CÓ CHỦ ĐÍCH: kiểu này phải gán
// được vào `SearchOptions` của ldapts (vốn khai `string[]`).
export interface LdapSearchOptions {
  readonly scope: 'base' | 'sub';
  readonly filter?: string;
  readonly attributes?: string[];
}

/** Một entry LDAP — ldapts trả string | string[] | Buffer | Buffer[] theo attribute. */
export interface LdapEntry {
  readonly dn: string;
  readonly [attribute: string]: unknown;
}

export interface LdapClient {
  bind(dn: string, password: string): Promise<void>;
  search(baseDn: string, options: LdapSearchOptions): Promise<{ searchEntries: LdapEntry[] }>;
  unbind(): Promise<void>;
}

/**
 * Dựng MỘT kết nối mới. `allowSelfSigned` chỉ có nghĩa với ldaps:// — factory
 * thật ánh xạ nó thành `tlsOptions.rejectUnauthorized = false`.
 */
export type LdapClientFactory = (options: {
  url: string;
  allowSelfSigned: boolean;
}) => LdapClient;

/** Cấu hình HIỆU LỰC cho một lượt xác thực — bind password đã GIẢI MÃ sẵn. */
export interface LdapEffectiveConfig {
  readonly serverUrl: string | null;
  readonly bindDn: string | null;
  /** Plaintext — tầng route giải mã bằng TokenBox trước khi gọi vào đây. */
  readonly bindPassword: string | null;
  readonly userDnTemplate: string | null;
  readonly searchBase: string | null;
  readonly userFilter: string;
  readonly emailAttribute: string;
  readonly allowSelfSigned: boolean;
}

// ---------------------------------------------------------------------------
// Escape chống LDAP injection — viết tay, có test riêng
// ---------------------------------------------------------------------------

/**
 * Escape một GIÁ TRỊ nhét vào filter LDAP theo RFC 4515 §3.
 *
 * Không escape thì username 'a)(uid=*' biến '(mail={username})' thành
 * '(mail=a)(uid=*)' — kẻ tấn công tự chế filter, match user tuỳ ý. Bốn ký tự
 * đặc biệt + NUL đổi thành mã hex: \2a \28 \29 \5c \00.
 */
export function escapeLdapFilterValue(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '*':
        out += '\\2a';
        break;
      case '(':
        out += '\\28';
        break;
      case ')':
        out += '\\29';
        break;
      case '\\':
        out += '\\5c';
        break;
      case '\0':
        out += '\\00';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/**
 * Escape một GIÁ TRỊ nhét vào DN (thế {username} trong userDnTemplate) theo
 * RFC 4514 §2.4.
 *
 * Không escape thì username 'a,ou=admins' biến 'uid={username},ou=users,…'
 * thành 'uid=a,ou=admins,ou=users,…' — bind sang một nhánh cây khác hẳn.
 * Escape bằng backslash: , + " \ < > ; = , NUL thành \00, và khoảng trắng/#
 * ở mép giá trị (chúng chỉ đặc biệt ở đầu/cuối).
 */
export function escapeLdapDnValue(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === '\0') {
      out += '\\00';
    } else if ('\\,+"<>;='.includes(ch)) {
      out += `\\${ch}`;
    } else if (ch === ' ' && (i === 0 || i === value.length - 1)) {
      out += '\\ ';
    } else if (ch === '#' && i === 0) {
      out += '\\#';
    } else {
      out += ch;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Xác thực
// ---------------------------------------------------------------------------

export type LdapAuthError = 'LOGIN_FAILED' | 'CONFIG_INVALID' | 'SERVER_UNREACHABLE';
export type LdapAuthResult = { email: string } | { error: LdapAuthError };

interface AuthDeps {
  readonly config: LdapEffectiveConfig;
  readonly username: string;
  readonly password: string;
  readonly clientFactory: LdapClientFactory;
  /** Chi tiết chỉ ghi log server-side — response cho client luôn chung chung. */
  readonly log?: (detail: string) => void;
}

/** Lỗi từ ldapts là "server có trả lời" (mã kết quả LDAP) hay "không tới nơi"? */
function isLdapResultError(err: unknown): err is ResultCodeError {
  return err instanceof ResultCodeError;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Đóng kết nối mà không để lỗi unbind che mất kết quả thật. */
async function quietUnbind(client: LdapClient): Promise<void> {
  try {
    await client.unbind();
  } catch {
    // Kết nối đã đứt thì unbind hỏng là chuyện thường — bỏ qua.
  }
}

/**
 * Đọc giá trị đầu tiên của một attribute (không phân biệt hoa thường — LDAP
 * coi tên attribute là case-insensitive, server trả về theo cách của nó).
 */
function firstAttributeValue(entry: LdapEntry | undefined, attribute: string): string | null {
  if (entry === undefined) return null;
  const wanted = attribute.toLowerCase();
  for (const key of Object.keys(entry)) {
    if (key === 'dn' || key.toLowerCase() !== wanted) continue;
    const raw = entry[key];
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (first === undefined || first === null) return null;
    const text = Buffer.isBuffer(first) ? first.toString('utf8') : String(first);
    const trimmed = text.trim();
    return trimmed === '' ? null : trimmed;
  }
  return null;
}

export async function authenticate(deps: AuthDeps): Promise<LdapAuthResult> {
  const { config, clientFactory, log } = deps;
  const username = deps.username.trim();

  // CHỐT AN TOÀN — phải đứng TRƯỚC mọi lượt bind: LDAP coi mật khẩu rỗng là
  // ANONYMOUS BIND và trả thành công. Không chặn ở đây thì ô mật khẩu bỏ
  // trống đăng nhập được thành BẤT KỲ AI (lỗ hổng kinh điển của form LDAP).
  if (deps.password.trim() === '') {
    log?.('Từ chối mật khẩu rỗng/toàn khoảng trắng trước khi bind.');
    return { error: 'LOGIN_FAILED' };
  }
  if (username === '') return { error: 'LOGIN_FAILED' };

  if (config.serverUrl === null || config.serverUrl.trim() === '') {
    log?.('Cấu hình LDAP thiếu serverUrl.');
    return { error: 'CONFIG_INVALID' };
  }
  const hasTemplate = config.userDnTemplate !== null && config.userDnTemplate.trim() !== '';
  const hasSearchBase = config.searchBase !== null && config.searchBase.trim() !== '';
  if (!hasTemplate && !hasSearchBase) {
    log?.('Cấu hình LDAP phải khai userDnTemplate và/hoặc searchBase.');
    return { error: 'CONFIG_INVALID' };
  }

  const factoryArgs = { url: config.serverUrl, allowSelfSigned: config.allowSelfSigned };

  if (hasTemplate) {
    // ---- Direct bind: bind bằng CHÍNH mật khẩu người dùng --------------------
    const userDn = config.userDnTemplate!.replaceAll('{username}', escapeLdapDnValue(username));
    const client = clientFactory(factoryArgs);
    try {
      try {
        await client.bind(userDn, deps.password);
      } catch (err) {
        if (isLdapResultError(err)) {
          // Sai mật khẩu, DN không tồn tại… — với người dùng đều là "đăng nhập
          // sai", KHÔNG phân biệt (chống dò tên đăng nhập).
          log?.(`Bind trực tiếp bị từ chối: ${errMessage(err)}`);
          return { error: 'LOGIN_FAILED' };
        }
        log?.(`Không kết nối được LDAP: ${errMessage(err)}`);
        return { error: 'SERVER_UNREACHABLE' };
      }

      // LUÔN đọc email sau khi bind — danh tính hệ thống là email (khớp
      // app_user), không phải username LDAP. Đọc trên CHÍNH kết nối vừa xác
      // thực nên KHÔNG cần tài khoản dịch vụ.
      let entry: LdapEntry | undefined;
      try {
        if (hasSearchBase) {
          // Active Directory: DN bind kiểu 'DOMAIN\user' (hoặc UPN) KHÔNG phải
          // một DN đọc base được → tra email bằng subtree search theo userFilter,
          // vẫn trên kết nối đã xác thực của user.
          const filter = config.userFilter.replaceAll(
            '{username}',
            escapeLdapFilterValue(username),
          );
          const res = await client.search(config.searchBase!, {
            scope: 'sub',
            filter,
            attributes: [config.emailAttribute],
          });
          // 0 (không thấy) và >1 (filter nhập nhằng) đều là "đăng nhập sai".
          if (res.searchEntries.length !== 1) {
            log?.(`Filter khớp ${res.searchEntries.length} entry cho một username — từ chối.`);
            return { error: 'LOGIN_FAILED' };
          }
          entry = res.searchEntries[0];
        } else {
          // OpenLDAP: DN dựng từ template là DN thật → đọc base ngay trên nó.
          const res = await client.search(userDn, {
            scope: 'base',
            attributes: [config.emailAttribute],
          });
          entry = res.searchEntries[0];
        }
      } catch (err) {
        if (isLdapResultError(err)) {
          log?.(`Đọc email sau bind thất bại: ${errMessage(err)}`);
          return { error: 'LOGIN_FAILED' };
        }
        log?.(`Mất kết nối LDAP khi đọc email: ${errMessage(err)}`);
        return { error: 'SERVER_UNREACHABLE' };
      }

      const email = firstAttributeValue(entry, config.emailAttribute);
      if (email === null) {
        log?.(
          `Không đọc được attribute email "${config.emailAttribute}" sau khi bind ${userDn} — không cấp phiên được.`,
        );
        return { error: 'LOGIN_FAILED' };
      }
      return { email: email.toLowerCase() };
    } finally {
      await quietUnbind(client);
    }
  }

  // ---- Search-then-bind -----------------------------------------------------
  const bindDn = config.bindDn?.trim() ?? '';
  const bindPassword = config.bindPassword ?? '';
  if (bindDn === '' || bindPassword === '') {
    log?.('Chế độ search-then-bind nhưng thiếu bindDn/bindPassword của tài khoản dịch vụ.');
    return { error: 'CONFIG_INVALID' };
  }

  let userDn: string;
  let email: string;
  const serviceClient = clientFactory(factoryArgs);
  try {
    try {
      await serviceClient.bind(bindDn, bindPassword);
    } catch (err) {
      if (isLdapResultError(err)) {
        // Tài khoản dịch vụ sai là lỗi CẤU HÌNH, không phải lỗi của người đăng
        // nhập — trả CONFIG_INVALID để admin thấy 500 rõ, thay vì 401 đánh lạc.
        log?.(`Bind tài khoản dịch vụ bị từ chối: ${errMessage(err)}`);
        return { error: 'CONFIG_INVALID' };
      }
      log?.(`Không kết nối được LDAP: ${errMessage(err)}`);
      return { error: 'SERVER_UNREACHABLE' };
    }

    let entries: LdapEntry[];
    try {
      const filter = config.userFilter.replaceAll(
        '{username}',
        escapeLdapFilterValue(username),
      );
      const res = await serviceClient.search(config.searchBase!, {
        scope: 'sub',
        filter,
        attributes: [config.emailAttribute],
      });
      entries = res.searchEntries;
    } catch (err) {
      if (isLdapResultError(err)) {
        log?.(`Search user thất bại (base/filter hỏng?): ${errMessage(err)}`);
        return { error: 'CONFIG_INVALID' };
      }
      log?.(`Mất kết nối LDAP khi search: ${errMessage(err)}`);
      return { error: 'SERVER_UNREACHABLE' };
    }

    // 0 kết quả (không có user) và >1 kết quả (filter nhập nhằng) đều là
    // "đăng nhập sai" với người dùng — chi tiết chỉ nằm trong log.
    if (entries.length !== 1) {
      log?.(`Filter khớp ${entries.length} entry cho một username — từ chối.`);
      return { error: 'LOGIN_FAILED' };
    }
    userDn = entries[0]!.dn;
    const found = firstAttributeValue(entries[0], config.emailAttribute);
    if (found === null) {
      log?.(
        `Entry ${userDn} không có attribute email "${config.emailAttribute}" — không cấp phiên được.`,
      );
      return { error: 'LOGIN_FAILED' };
    }
    email = found.toLowerCase();
  } finally {
    await quietUnbind(serviceClient);
  }

  // Bind kiểm mật khẩu người dùng trên KẾT NỐI MỚI — không tái dùng kết nối
  // của tài khoản dịch vụ (bind đè lên nó rồi lỡ dùng tiếp là lẫn quyền).
  const userClient = clientFactory(factoryArgs);
  try {
    await userClient.bind(userDn, deps.password);
  } catch (err) {
    if (isLdapResultError(err)) {
      log?.(`Bind của người dùng bị từ chối: ${errMessage(err)}`);
      return { error: 'LOGIN_FAILED' };
    }
    log?.(`Không kết nối được LDAP khi bind người dùng: ${errMessage(err)}`);
    return { error: 'SERVER_UNREACHABLE' };
  } finally {
    await quietUnbind(userClient);
  }

  return { email };
}

// ---------------------------------------------------------------------------
// Test connection — cùng khuôn 3 bước với test Jira
// ---------------------------------------------------------------------------

/** Username thử cho bước SEARCH — cố ý không tồn tại, 0 kết quả vẫn là PASS. */
export const TEST_PROBE_USERNAME = 'nguoi-dung-thu-khong-ton-tai';

interface TestDeps {
  readonly config: LdapEffectiveConfig;
  readonly clientFactory: LdapClientFactory;
}

type Step = LdapTestResponse['steps'][number];

/**
 * Chạy tuần tự CONNECT → BIND → SEARCH, DỪNG ở bước hỏng đầu tiên.
 *
 * Kiểm tính ĐẦY ĐỦ của cấu hình trước khi chạm mạng — thiếu trường nào báo
 * ngay ở đúng bước liên quan, không để một stacktrace kết nối mờ mịt trả lời
 * thay. Đây cũng là bài kiểm CHỐNG TỰ KHÓA: PUT với enabled=true phải qua
 * được hàm này rồi mới được lưu.
 */
export async function testConnection(deps: TestDeps): Promise<LdapTestResponse> {
  const { config, clientFactory } = deps;
  const steps: Step[] = [];
  const fail = (step: Step['step'], detail: string): LdapTestResponse => {
    steps.push({ step, ok: false, detail });
    return { ok: false, steps };
  };

  // ---- Tính đầy đủ của cấu hình (chưa chạm mạng) ----------------------------
  if (config.serverUrl === null || config.serverUrl.trim() === '') {
    return fail('CONNECT', 'Chưa khai Server URL (ldap:// hoặc ldaps://).');
  }
  const hasTemplate = config.userDnTemplate !== null && config.userDnTemplate.trim() !== '';
  const hasSearchBase = config.searchBase !== null && config.searchBase.trim() !== '';
  if (!hasTemplate && !hasSearchBase) {
    return fail(
      'BIND',
      'Phải khai User DN template (direct bind) hoặc Search base — hoặc cả hai (AD direct-bind + tự tra email).',
    );
  }
  // CHỈ search-then-bind (không template) mới cần tài khoản dịch vụ. Direct bind
  // + tự tra email (có CẢ template lẫn searchBase) bind bằng mật khẩu người dùng
  // nên KHÔNG cần bindDn/bindPassword.
  if (hasSearchBase && !hasTemplate) {
    const bindDn = config.bindDn?.trim() ?? '';
    const bindPassword = config.bindPassword ?? '';
    if (bindDn === '' || bindPassword === '') {
      return fail(
        'BIND',
        'Chế độ search-then-bind cần đủ Bind DN và bind password của tài khoản dịch vụ.',
      );
    }
  }

  const client = clientFactory({
    url: config.serverUrl,
    allowSelfSigned: config.allowSelfSigned,
  });
  try {
    if (hasTemplate) {
      // ---- Direct bind: bind bằng mật khẩu người dùng lúc đăng nhập, ở đây
      // KHÔNG có credential để thử. Chỉ kiểm KẾT NỐI bằng một lượt đọc root DSE
      // nặc danh; server từ chối đọc nặc danh (một mã kết quả LDAP) vẫn tính là
      // NỐI ĐƯỢC — nó đã trả lời.
      try {
        await client.search('', { scope: 'base', attributes: ['1.1'] });
      } catch (err) {
        if (!isLdapResultError(err)) {
          return fail('CONNECT', `Không kết nối được ${config.serverUrl}: ${errMessage(err)}`);
        }
      }
      steps.push({ step: 'CONNECT', ok: true, detail: `Đã kết nối ${config.serverUrl}.` });
      steps.push({
        step: 'BIND',
        ok: true,
        detail: 'direct bind — không dùng tài khoản dịch vụ, chỉ kiểm tra kết nối',
      });
      steps.push({
        step: 'SEARCH',
        ok: true,
        detail: hasSearchBase
          ? `Sẽ tra email bằng chính kết nối của user trong ${config.searchBase} — kiểm khi user đăng nhập thật.`
          : 'Bỏ qua — direct bind xác định DN bằng template, không cần search.',
      });
      return { ok: true, steps };
    }

    // ---- Search-then-bind: bind tài khoản dịch vụ rồi chạy thử filter -------
    try {
      await client.bind(config.bindDn!.trim(), config.bindPassword!);
    } catch (err) {
      if (isLdapResultError(err)) {
        steps.push({ step: 'CONNECT', ok: true, detail: `Đã kết nối ${config.serverUrl}.` });
        return fail('BIND', `Bind tài khoản dịch vụ bị từ chối: ${errMessage(err)}`);
      }
      return fail('CONNECT', `Không kết nối được ${config.serverUrl}: ${errMessage(err)}`);
    }
    steps.push({ step: 'CONNECT', ok: true, detail: `Đã kết nối ${config.serverUrl}.` });
    steps.push({ step: 'BIND', ok: true, detail: 'Bind tài khoản dịch vụ thành công.' });

    try {
      const filter = config.userFilter.replaceAll(
        '{username}',
        escapeLdapFilterValue(TEST_PROBE_USERNAME),
      );
      const res = await client.search(config.searchBase!, {
        scope: 'sub',
        filter,
        attributes: [config.emailAttribute],
      });
      // 0 kết quả là BÌNH THƯỜNG — username thử cố ý không tồn tại; bước này
      // chỉ chứng minh search base + filter hợp lệ về cú pháp và quyền đọc.
      steps.push({
        step: 'SEARCH',
        ok: true,
        detail: `Filter chạy được trong ${config.searchBase} (${res.searchEntries.length} kết quả cho username thử — 0 là bình thường).`,
      });
    } catch (err) {
      return fail(
        'SEARCH',
        isLdapResultError(err)
          ? `Search base/filter bị từ chối: ${errMessage(err)}`
          : `Mất kết nối khi search: ${errMessage(err)}`,
      );
    }
    return { ok: true, steps };
  } finally {
    await quietUnbind(client);
  }
}
