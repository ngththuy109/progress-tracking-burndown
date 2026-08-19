import {
  findLdapConfig,
  upsertLdapConfig,
  type LdapConfigRow,
  type PrismaClient,
  type UpsertLdapConfigArgs,
} from '@app/db';

/**
 * Cấu hình LDAP — cổng đọc/ghi + loader có cache TTL ngắn.
 *
 * VÌ SAO CẦN CACHE: chế độ xác thực được hỏi trên TỪNG request (hook
 * `onRequest` phải biết "LDAP đang bật không?" trước khi quyết định tin header
 * hay cookie). Tra database mỗi request cho một bảng một dòng gần như bất
 * biến là lãng phí; cache ~10 giây đủ ngắn để admin bật/tắt LDAP thấy hiệu
 * lực gần tức thì, và route admin gọi `invalidate()` ngay sau khi lưu nên
 * tiến trình xử lý request đó thấy config mới lập tức.
 */

export interface LdapConfigStore {
  /** Đọc TƯƠI từ database — dùng cho màn hình admin (không đi qua cache). */
  find(): Promise<LdapConfigRow | null>;
  upsert(args: UpsertLdapConfigArgs): Promise<void>;
}

export function createLdapConfigStore(prisma: PrismaClient): LdapConfigStore {
  return {
    find: () => findLdapConfig(prisma),
    upsert: (args) => upsertLdapConfig(prisma, args),
  };
}

export interface LdapConfigLoader {
  /** Đọc config qua cache TTL. */
  load(): Promise<LdapConfigRow | null>;
  /** Vứt cache — gọi sau khi admin lưu config để tiến trình này thấy ngay. */
  invalidate(): void;
}

export const LDAP_CONFIG_CACHE_TTL_MS = 10_000;

export function createLdapConfigLoader(
  find: () => Promise<LdapConfigRow | null>,
  opts: { ttlMs?: number; now?: () => number } = {},
): LdapConfigLoader {
  const ttlMs = opts.ttlMs ?? LDAP_CONFIG_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;

  // Cache NGUYÊN promise thay vì giá trị: N request đến cùng lúc khi cache
  // nguội chỉ tạo MỘT lượt truy vấn, các request còn lại await chung.
  let cached: { at: number; value: Promise<LdapConfigRow | null> } | null = null;

  return {
    load() {
      const t = now();
      if (cached !== null && t - cached.at < ttlMs) return cached.value;
      const value = find();
      const entry = { at: t, value };
      cached = entry;
      // Truy vấn hỏng thì KHÔNG cache — lần load sau thử lại ngay thay vì
      // găm một promise rejected suốt 10 giây.
      value.catch(() => {
        if (cached === entry) cached = null;
      });
      return value;
    },
    invalidate() {
      cached = null;
    },
  };
}
