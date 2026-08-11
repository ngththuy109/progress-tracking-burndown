import type { FastifyReply, FastifyRequest } from 'fastify';
import { PROJECT_KEY_PATTERN, type Principal, type ProjectRole } from '@app/shared';

/**
 * PHÂN QUYỀN TẬP TRUNG cho mọi route multi-tenant — Phase B.
 *
 * Trước đây mỗi nhóm route tự chế `assertCanRead`/`assertCanOperate`/`requireAdmin`
 * rải rác; giờ toàn bộ đi qua BA guard (Fastify `preHandler`) dựng ở đây:
 *
 *   - `requireAuthenticated` — chỉ cần có principal (401 nếu không).
 *   - `requireAdmin`         — 401 khi chưa đăng nhập, 403 khi không phải ADMIN.
 *   - `requireProject(minRole)` — đọc `:projectKey` từ URL, kiểm membership và
 *     gắn `request.projectCtx = { projectKey, role }` cho handler dùng.
 *
 * LUẬT 404-THAY-VÌ-403 (chống dò tenant): với `requireProject`, dự án KHÔNG tồn
 * tại và dự án TỒN TẠI-nhưng-người-gọi-không-phải-thành-viên trả về CÙNG một
 * `404 PROJECT_NOT_FOUND`. Trả 403 cho người ngoài là xác nhận "dự án này có
 * thật" — đúng thứ multi-tenant phải giấu. 403 chỉ dành cho người ĐÃ ở trong dự
 * án nhưng thiếu bậc quyền (VIEWER gọi route PM) — họ vốn biết dự án tồn tại.
 *
 * ADMIN toàn cục vượt kiểm membership với role hiệu dụng PM, nhưng vẫn ăn 404
 * khi dự án không có thật.
 */

/** Cổng tra "dự án này có trong danh mục không" — bơm từ server.ts. */
export interface ProjectDirectory {
  exists(projectKey: string): Promise<boolean>;
}

export interface ProjectCtx {
  readonly projectKey: string;
  /** Role hiệu dụng trong dự án. ADMIN toàn cục nhận 'PM'. */
  readonly role: ProjectRole;
}

/**
 * `projectCtx` do `requireProject` gắn vào request; handler phía sau guard đọc
 * đồng bộ. `undefined` = route không đi qua guard (đừng đọc ở đó).
 */
declare module 'fastify' {
  interface FastifyRequest {
    projectCtx?: ProjectCtx;
  }
}

/** Guard dạng preHandler: tự gửi phản hồi lỗi (đúng format `{error, message}`) rồi dừng chuỗi. */
export type AuthzGuard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AuthzGuards {
  readonly requireAuthenticated: AuthzGuard;
  readonly requireAdmin: AuthzGuard;
  requireProject(minRole: ProjectRole): AuthzGuard;
}

export const UNAUTHENTICATED_MESSAGE =
  'This request has no signed-in user. Reload the page to sign in again.';

/** Đọc `projectCtx` sau guard — ném sớm nếu route quên gắn `requireProject`. */
export function projectCtxOf(req: FastifyRequest): ProjectCtx {
  const ctx = req.projectCtx;
  if (ctx === undefined) {
    // Lỗi LẬP TRÌNH chứ không phải lỗi người dùng: route có `:projectKey` mà
    // không đăng ký guard. Nổ to ở dev/test còn hơn lặng lẽ bỏ kiểm quyền.
    throw new Error('projectCtx chưa được gắn — route thiếu preHandler requireProject().');
  }
  return ctx;
}

export function createAuthzGuards(deps: {
  resolvePrincipal(req: FastifyRequest): Principal | null;
  readonly directory: ProjectDirectory;
}): AuthzGuards {
  const send = async (
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ): Promise<void> => {
    await reply.status(status).send({ error: code, message });
  };

  const requireAuthenticated: AuthzGuard = async (req, reply) => {
    if (deps.resolvePrincipal(req) === null) {
      await send(reply, 401, 'UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
    }
  };

  const requireAdmin: AuthzGuard = async (req, reply) => {
    const p = deps.resolvePrincipal(req);
    if (p === null) {
      await send(reply, 401, 'UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
      return;
    }
    if (!p.isAdmin) {
      await send(reply, 403, 'FORBIDDEN', 'Only Admins can use this endpoint.');
    }
  };

  const requireProject = (minRole: ProjectRole): AuthzGuard => {
    return async (req, reply) => {
      const p = deps.resolvePrincipal(req);
      if (p === null) {
        await send(reply, 401, 'UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
        return;
      }

      // Chuẩn hoá key như mọi nơi khác (trim + viết HOA) rồi kiểm định dạng —
      // key rác không đáng một lượt truy vấn DB.
      const raw = (req.params as { projectKey?: string }).projectKey?.trim().toUpperCase() ?? '';
      if (!PROJECT_KEY_PATTERN.test(raw)) {
        await send(
          reply,
          400,
          'BAD_REQUEST',
          'A project key must be uppercase, start with a letter, and use only A–Z, 0–9 and _ (e.g. PAY, CRM).',
        );
        return;
      }

      // Không phải thành viên → 404 NGAY, không cần chạm DB: câu trả lời giống
      // hệt ca "dự án không tồn tại" nên người ngoài không suy ra được gì.
      const role: ProjectRole | undefined = p.isAdmin ? 'PM' : p.memberships[raw];
      if (role === undefined || !(await deps.directory.exists(raw))) {
        await send(
          reply,
          404,
          'PROJECT_NOT_FOUND',
          `Project ${raw} does not exist or you do not have access to it.`,
        );
        return;
      }

      // Bậc quyền: PM ≥ VIEWER. Người này LÀ thành viên nên 403 không lộ gì mới.
      if (minRole === 'PM' && role !== 'PM') {
        await send(
          reply,
          403,
          'FORBIDDEN',
          `Only a PM of project ${raw} (or an Admin) can do this. You have view-only access.`,
        );
        return;
      }

      req.projectCtx = { projectKey: raw, role };
    };
  };

  return { requireAuthenticated, requireAdmin, requireProject };
}
