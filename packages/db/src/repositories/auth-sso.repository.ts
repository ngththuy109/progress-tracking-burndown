import type { PrismaClient } from '../client.js';

/**
 * Cấu hình SSO (OIDC in-app) — bảng MỘT DÒNG `auth_sso_config` (id = 1).
 *
 * `clientSecretEnc` là secret ĐÃ MÃ HÓA (secret-box, APP_ENCRYPTION_KEY) —
 * tầng route/adapter chịu trách nhiệm không bao giờ đưa nó vào response API.
 * Chưa có dòng nào = SSO chưa từng được cấu hình → chế độ header cũ.
 */

export interface SsoConfigRow {
  readonly enabled: boolean;
  readonly issuerUrl: string | null;
  readonly clientId: string | null;
  readonly clientSecretEnc: string | null;
  readonly scopes: string;
  readonly emailClaim: string;
  readonly sessionTtlHours: number;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

export async function findSsoConfig(prisma: PrismaClient): Promise<SsoConfigRow | null> {
  const row = await prisma.authSsoConfig.findUnique({ where: { id: 1 } });
  if (row === null) return null;
  return {
    enabled: row.enabled,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    clientSecretEnc: row.clientSecretEnc,
    scopes: row.scopes,
    emailClaim: row.emailClaim,
    sessionTtlHours: row.sessionTtlHours,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export interface UpsertSsoConfigArgs {
  readonly enabled: boolean;
  readonly issuerUrl: string | null;
  readonly clientId: string | null;
  /** undefined = GIỮ secret cũ; null = xóa; chuỗi = secret ĐÃ mã hóa. */
  readonly clientSecretEnc?: string | null;
  readonly scopes: string;
  readonly emailClaim: string;
  readonly sessionTtlHours: number;
  readonly updatedBy: string;
}

export async function upsertSsoConfig(
  prisma: PrismaClient,
  args: UpsertSsoConfigArgs,
): Promise<void> {
  const patch = {
    enabled: args.enabled,
    issuerUrl: args.issuerUrl,
    clientId: args.clientId,
    ...(args.clientSecretEnc !== undefined ? { clientSecretEnc: args.clientSecretEnc } : {}),
    scopes: args.scopes,
    emailClaim: args.emailClaim,
    sessionTtlHours: args.sessionTtlHours,
    updatedBy: args.updatedBy,
  };
  await prisma.authSsoConfig.upsert({
    where: { id: 1 },
    create: { id: 1, ...patch },
    update: patch,
  });
}
