import type { FastifyRequest } from 'fastify';
import { USER_ROLE, type Principal, type UserRole } from '@app/shared';

/**
 * Xác định người gọi từ header do gateway đặt.
 *
 * GĐ 1 CHƯA chốt dùng SSO hay JWT, nên chỗ này cố tình để là một cổng thay thế
 * được. Bản này tin vào header, và điều đó CHỈ an toàn khi API không bao giờ
 * nhận request trực tiếp từ Internet — gateway phải là nơi duy nhất gọi tới và
 * phải xoá sạch các header này khỏi request của client.
 *
 * Ghi rõ ở đây vì đây đúng là loại giả định mà người triển khai sau dễ bỏ sót,
 * và bỏ sót thì bất kỳ ai cũng tự xưng được là ADMIN.
 */
export const HEADER_USER_ID = 'x-user-id';
export const HEADER_USER_ROLE = 'x-user-role';
export const HEADER_USER_PROJECTS = 'x-user-projects';

export function resolvePrincipalFromHeaders(req: FastifyRequest): Principal | null {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const userId = first(headers[HEADER_USER_ID]);
  const role = first(headers[HEADER_USER_ROLE]);

  if (!userId || !role) return null;
  if (!isRole(role)) return null;

  return {
    userId,
    role,
    projects: (first(headers[HEADER_USER_PROJECTS]) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Vai trò lạ bị coi là KHÔNG có quyền, không phải mặc định thành VIEWER. */
function isRole(v: string): v is UserRole {
  return (USER_ROLE as readonly string[]).includes(v);
}
