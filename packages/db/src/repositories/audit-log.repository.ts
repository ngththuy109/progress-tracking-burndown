import { Prisma } from '@prisma/client';
import type { PrismaClient } from '../client.js';

/**
 * Nhật ký thao tác quản trị nhạy cảm — hiện dùng cho các thao tác trên kết nối
 * Jira của tenant (sửa / test). Xem lý do ở schema.prisma (bảng 15).
 *
 * NGUYÊN TẮC: `detail` chỉ chứa cờ/enum (boolean, chuỗi ngắn định danh) —
 * TUYỆT ĐỐI không đưa token, URL, email hay bất kỳ giá trị người dùng nhập nào
 * vào đây. Ghi audit là một phần của thao tác: ghi thất bại thì request thất
 * bại (thà lỗi rõ còn hơn có thao tác không dấu vết).
 */

export interface AuditEntryRow {
  readonly id: string;
  readonly actorId: string;
  readonly action: string;
  readonly projectKey: string | null;
  readonly detail: unknown;
  readonly at: Date;
}

export interface InsertAuditArgs {
  readonly actorId: string;
  readonly action: string;
  readonly projectKey?: string | null;
  /** JSON chỉ chứa cờ/enum — người gọi chịu trách nhiệm không nhét bí mật. */
  readonly detail?: unknown;
}

export async function insertAuditEntry(prisma: PrismaClient, args: InsertAuditArgs): Promise<void> {
  await prisma.adminAuditLog.create({
    data: {
      actorId: args.actorId,
      action: args.action,
      projectKey: args.projectKey ?? null,
      detail:
        args.detail === undefined || args.detail === null
          ? Prisma.DbNull
          : (args.detail as Prisma.InputJsonValue),
    },
  });
}

/** Các dòng gần nhất của MỘT dự án — màn hình quản trị xem lịch sử sửa kết nối. */
export async function listAuditEntries(
  prisma: PrismaClient,
  projectKey: string,
  limit = 50,
): Promise<AuditEntryRow[]> {
  const rows = await prisma.adminAuditLog.findMany({
    where: { projectKey },
    orderBy: { at: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    id: String(r.id),
    actorId: r.actorId,
    action: r.action,
    projectKey: r.projectKey,
    detail: r.detail ?? null,
    at: r.at,
  }));
}
