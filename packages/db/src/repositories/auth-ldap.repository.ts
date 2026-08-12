import type { PrismaClient } from '../client.js';

/**
 * Cấu hình đăng nhập LDAP — bảng MỘT DÒNG `auth_ldap_config` (id = 1).
 *
 * `bindPasswordEnc` là mật khẩu tài khoản dịch vụ ĐÃ MÃ HÓA (secret-box,
 * APP_ENCRYPTION_KEY) — tầng route/adapter chịu trách nhiệm không bao giờ đưa
 * nó vào response API. Chưa có dòng nào = LDAP chưa từng được cấu hình →
 * chế độ header cũ.
 */

export interface LdapConfigRow {
  readonly enabled: boolean;
  readonly serverUrl: string | null;
  readonly bindDn: string | null;
  readonly bindPasswordEnc: string | null;
  readonly userDnTemplate: string | null;
  readonly searchBase: string | null;
  readonly userFilter: string;
  readonly emailAttribute: string;
  readonly allowSelfSigned: boolean;
  readonly sessionTtlHours: number;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

export async function findLdapConfig(prisma: PrismaClient): Promise<LdapConfigRow | null> {
  const row = await prisma.authLdapConfig.findUnique({ where: { id: 1 } });
  if (row === null) return null;
  return {
    enabled: row.enabled,
    serverUrl: row.serverUrl,
    bindDn: row.bindDn,
    bindPasswordEnc: row.bindPasswordEnc,
    userDnTemplate: row.userDnTemplate,
    searchBase: row.searchBase,
    userFilter: row.userFilter,
    emailAttribute: row.emailAttribute,
    allowSelfSigned: row.allowSelfSigned,
    sessionTtlHours: row.sessionTtlHours,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export interface UpsertLdapConfigArgs {
  readonly enabled: boolean;
  readonly serverUrl: string | null;
  readonly bindDn: string | null;
  /** undefined = GIỮ mật khẩu cũ; null = xóa; chuỗi = mật khẩu ĐÃ mã hóa. */
  readonly bindPasswordEnc?: string | null;
  readonly userDnTemplate: string | null;
  readonly searchBase: string | null;
  readonly userFilter: string;
  readonly emailAttribute: string;
  readonly allowSelfSigned: boolean;
  readonly sessionTtlHours: number;
  readonly updatedBy: string;
}

export async function upsertLdapConfig(
  prisma: PrismaClient,
  args: UpsertLdapConfigArgs,
): Promise<void> {
  const patch = {
    enabled: args.enabled,
    serverUrl: args.serverUrl,
    bindDn: args.bindDn,
    ...(args.bindPasswordEnc !== undefined ? { bindPasswordEnc: args.bindPasswordEnc } : {}),
    userDnTemplate: args.userDnTemplate,
    searchBase: args.searchBase,
    userFilter: args.userFilter,
    emailAttribute: args.emailAttribute,
    allowSelfSigned: args.allowSelfSigned,
    sessionTtlHours: args.sessionTtlHours,
    updatedBy: args.updatedBy,
  };
  await prisma.authLdapConfig.upsert({
    where: { id: 1 },
    create: { id: 1, ...patch },
    update: patch,
  });
}
