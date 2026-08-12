import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  PROJECT_KEY_PATTERN,
  updateProjectJiraRequestSchema,
  upsertMemberRequestSchema,
  upsertProjectRequestSchema,
  type AuditTokenEffect,
  type JiraTestResponse,
  type ListAuditResponse,
  type ListMembersResponse,
  type Principal,
  type ProjectMemberView,
  type ProjectView,
} from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import { normalizeIdentity } from '../adapters/principal.js';
import type { AuthzGuards } from '../adapters/project-scope.js';
import type {
  AuditLogStore,
  ProjectMemberStore,
  ProjectStore,
} from '../adapters/project.adapters.js';

/**
 * Quản trị TENANT — `/api/admin/projects...`, CHỈ ADMIN (guard `requireAdmin`).
 *
 *   GET    /api/admin/projects                        danh mục tenant
 *   PUT    /api/admin/projects/:projectKey            đăng ký / sửa (idempotent)
 *   DELETE /api/admin/projects/:projectKey            xoá (chặn khi còn dữ liệu)
 *   PUT    /api/admin/projects/:projectKey/jira       kết nối Jira riêng
 *   POST   /api/admin/projects/:projectKey/jira/test  thử kết nối 3 bước
 *   GET/PUT/DELETE .../members[...]                   thành viên + role dự án
 *
 * Token Jira là WRITE-ONLY: nhận vào thì mã hóa (AES-256-GCM) rồi lưu, API chỉ
 * trả `hasJiraToken`. Không log, không echo, không trả lại dưới bất kỳ dạng nào.
 */

/** Cổng "Test connection" — bộ chuyển đổi thật ở adapters/jira-test.adapters.ts. */
export interface JiraConnectionTester {
  test(args: {
    baseUrl: string | null;
    email: string | null;
    apiToken: string | null;
    fieldsConfig: unknown;
    projectKey: string;
  }): Promise<JiraTestResponse>;
}

/** Hộp seal/open token — `null` khi APP_ENCRYPTION_KEY chưa được đặt. */
export interface TokenBox {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

export interface ProjectsRouteDeps {
  resolvePrincipal(req: FastifyRequest): Principal | null;
  readonly guards: AuthzGuards;
  readonly projects: ProjectStore;
  readonly members: ProjectMemberStore;
  /** Nhật ký thao tác nhạy cảm — ghi mọi lần sửa/test kết nối Jira. */
  readonly audit: AuditLogStore;
  readonly tokenBox: TokenBox | null;
  readonly jiraTester: JiraConnectionTester;
  /** env JIRA_* — đường fallback cho tenant chưa khai kết nối riêng. */
  readonly envJira: {
    baseUrl: string;
    email: string;
    apiToken: string;
    fieldsConfig: unknown;
  } | null;
  /** Kiểm cấu trúc fieldsConfig (zod của @app/jira, tiêm từ điểm lắp ráp). */
  validateFieldsConfig(v: unknown): { ok: true } | { ok: false; message: string };
}

/** Chuẩn hoá key: trim + viết HOA (khớp key Jira như PAY, CRM). */
export function normalizeProjectKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const v = raw.trim().toUpperCase();
  return v === '' ? null : v;
}

/** Mã lỗi Prisma "vi phạm khoá ngoại" — dùng để đổi thành lỗi nghiệp vụ rõ nghĩa. */
const PRISMA_FK_VIOLATION = 'P2003';

function prismaErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export function registerProjectsRoutes(app: FastifyInstance, deps: ProjectsRouteDeps): void {
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await reply.send(await fn());
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({
          error: err.code,
          message: err.message,
          ...(err.issues ? { issues: err.issues } : {}),
        });
        return;
      }
      app.log.error({ err }, 'Lỗi ngoài dự kiến ở nhóm API quản trị tenant');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const admin = { preHandler: deps.guards.requireAdmin };

  const keyParam = (req: FastifyRequest): string => {
    const key = normalizeProjectKey((req.params as { projectKey?: string }).projectKey);
    if (key === null || !PROJECT_KEY_PATTERN.test(key)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'A project key must be uppercase, start with a letter, and use only A–Z, 0–9 and _ (e.g. PAY, CRM).',
      );
    }
    return key;
  };

  const projectOrThrow = async (projectKey: string): Promise<ProjectView> => {
    const row = await deps.projects.find(projectKey);
    if (row === null) {
      throw new ApiError(404, 'PROJECT_NOT_FOUND', `${projectKey} is not in the project list.`);
    }
    return row;
  };

  // ---- Danh mục tenant -----------------------------------------------------

  app.get('/api/admin/projects', admin, async (_req, reply) =>
    handle(reply, async () => ({ projects: [...(await deps.projects.list())] })),
  );

  app.put('/api/admin/projects/:projectKey', admin, async (req, reply) =>
    handle(reply, async () => {
      const projectKey = keyParam(req);
      // `projectKey` trong body bị ghi đè bằng key của URL — một nguồn sự thật.
      const parsed = upsertProjectRequestSchema.safeParse({
        ...(req.body as Record<string, unknown>),
        projectKey,
      });
      if (!parsed.success) throw badRequest(parsed.error);

      await deps.projects.upsert({
        projectKey,
        displayName: parsed.data.displayName,
        status: parsed.data.status,
        hierarchyDepth: parsed.data.hierarchyDepth,
        timezone: parsed.data.timezone,
        defaultCalendarId: parsed.data.defaultCalendarId,
      });
      return projectOrThrow(projectKey);
    }),
  );

  app.delete('/api/admin/projects/:projectKey', admin, async (req, reply) =>
    handle(reply, async () => {
      const projectKey = keyParam(req);
      try {
        const removed = await deps.projects.remove(projectKey);
        if (!removed) {
          throw new ApiError(404, 'PROJECT_NOT_FOUND', `${projectKey} is not in the project list.`);
        }
      } catch (err) {
        // Còn Epic/issue trỏ vào tenant (FK NoAction) thì KHÔNG xoá được — nói
        // rõ phải gỡ dữ liệu trước thay vì nổ 500 mờ mịt. Thành viên thì rơi
        // theo CASCADE nên không chặn.
        if (prismaErrorCode(err) === PRISMA_FK_VIOLATION) {
          throw new ApiError(
            409,
            'PROJECT_IN_USE',
            `${projectKey} still has tracked Epics or synced data. Remove its Epics first, then delete the project.`,
          );
        }
        throw err;
      }
      return { ok: true };
    }),
  );

  // ---- Kết nối Jira của tenant --------------------------------------------

  app.put('/api/admin/projects/:projectKey/jira', admin, async (req, reply) =>
    handle(reply, async () => {
      const adminPrincipal = deps.resolvePrincipal(req)!;
      const projectKey = keyParam(req);
      const before = await deps.projects.connection(projectKey);
      if (before === null) {
        throw new ApiError(404, 'PROJECT_NOT_FOUND', `${projectKey} is not in the project list.`);
      }

      const parsed = updateProjectJiraRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);

      if (parsed.data.fieldsConfig !== null) {
        const checked = deps.validateFieldsConfig(parsed.data.fieldsConfig);
        if (!checked.ok) {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            `fieldsConfig không hợp lệ: ${checked.message}. ` +
              'Cần cùng cấu trúc với config/jira-fields.yaml — { fieldMapping: { wbsStartDate, wbsEndDate } }.',
          );
        }
      }

      // apiToken: undefined = GIỮ token cũ; null = XÓA; chuỗi = mã hóa rồi lưu.
      let jiraTokenEnc: string | null | undefined;
      let tokenEffect: AuditTokenEffect;
      if (parsed.data.apiToken === undefined) {
        jiraTokenEnc = undefined;
        tokenEffect = 'KEPT';
      } else if (parsed.data.apiToken === null) {
        jiraTokenEnc = null;
        tokenEffect = 'CLEARED';
      } else {
        if (deps.tokenBox === null) {
          // KHÔNG được lưu token thô. Thiếu khóa thì từ chối rõ ràng kèm cách
          // sinh khóa — thà không lưu còn hơn lưu không mã hóa (C-9).
          throw new ApiError(
            400,
            'ENCRYPTION_KEY_MISSING',
            'Chưa đặt APP_ENCRYPTION_KEY nên không thể lưu API token một cách an toàn. ' +
              'Sinh khóa bằng: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" ' +
              'rồi đặt vào biến môi trường APP_ENCRYPTION_KEY (cả api lẫn worker) và thử lại.',
          );
        }
        jiraTokenEnc = deps.tokenBox.seal(parsed.data.apiToken);
        tokenEffect = 'SET';
      }

      // CHỐT AN TOÀN: đổi base URL mà không nhập token mới → TỰ XÓA token đã
      // lưu. Nếu cứ giữ, một ADMIN (hoặc phiên ADMIN bị chiếm) có thể trỏ URL
      // sang server tự kiểm soát rồi bấm Test connection — token bị gửi sang
      // đó. Bắt nhập lại token khi đổi site là cái giá nhỏ, đúng C-9.
      const baseUrlChanged = parsed.data.jiraBaseUrl !== before.jiraBaseUrl;
      if (baseUrlChanged && jiraTokenEnc === undefined && before.jiraTokenEnc !== null) {
        jiraTokenEnc = null;
        tokenEffect = 'AUTO_CLEARED';
      }

      // Kết nối đổi thì bản field mapping đã resolve của lần trước hết tin được
      // — xóa để lần dùng tới resolve lại từ cấu hình mới.
      await deps.projects.updateJira(projectKey, {
        jiraBaseUrl: parsed.data.jiraBaseUrl,
        jiraEmail: parsed.data.jiraEmail,
        ...(jiraTokenEnc !== undefined ? { jiraTokenEnc } : {}),
        jiraFieldsJson: parsed.data.fieldsConfig,
        jiraResolvedJson: null,
      });

      // Dấu vết cho thao tác nhạy cảm — CHỈ cờ/enum, không giá trị nhập vào.
      await deps.audit.record({
        actorId: adminPrincipal.userId,
        action: 'JIRA_CONNECTION_UPDATED',
        projectKey,
        detail: {
          baseUrlChanged,
          emailChanged: parsed.data.jiraEmail !== before.jiraEmail,
          fieldsConfigChanged:
            JSON.stringify(parsed.data.fieldsConfig) !== JSON.stringify(before.jiraFieldsJson),
          token: tokenEffect,
        },
      });

      // Trả view chuẩn (KHÔNG BAO GIỜ chứa token — chỉ hasJiraToken).
      return projectOrThrow(projectKey);
    }),
  );

  app.post('/api/admin/projects/:projectKey/jira/test', admin, async (req, reply) =>
    handle(reply, async (): Promise<JiraTestResponse> => {
      const projectKey = keyParam(req);
      const conn = await deps.projects.connection(projectKey);
      if (conn === null) {
        throw new ApiError(404, 'PROJECT_NOT_FOUND', `${projectKey} is not in the project list.`);
      }

      // Cho phép thử với giá trị CHƯA LƯU (điền form rồi bấm Test trước khi
      // Save): body ghi đè giá trị đã lưu; thiếu thì rơi về DB rồi về env JIRA_*.
      const parsed = updateProjectJiraRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw badRequest(parsed.error);

      const baseUrl = parsed.data.jiraBaseUrl ?? conn.jiraBaseUrl ?? deps.envJira?.baseUrl ?? null;
      const email = parsed.data.jiraEmail ?? conn.jiraEmail ?? deps.envJira?.email ?? null;

      let apiToken: string | null;
      if (typeof parsed.data.apiToken === 'string') {
        apiToken = parsed.data.apiToken;
      } else if (conn.jiraTokenEnc !== null) {
        if (deps.tokenBox === null) {
          throw new ApiError(
            400,
            'ENCRYPTION_KEY_MISSING',
            'Dự án này có token đã mã hóa nhưng APP_ENCRYPTION_KEY chưa được đặt nên không giải mã được. ' +
              'Khôi phục khóa cũ hoặc nhập lại token rồi thử lại.',
          );
        }
        apiToken = deps.tokenBox.open(conn.jiraTokenEnc);
      } else {
        apiToken = deps.envJira?.apiToken ?? null;
      }

      const fieldsConfig =
        parsed.data.fieldsConfig ?? conn.jiraFieldsJson ?? deps.envJira?.fieldsConfig ?? null;

      const result = await deps.jiraTester.test({
        baseUrl,
        email,
        apiToken,
        fieldsConfig,
        projectKey,
      });

      // Test connection GỬI token đã lưu tới baseUrl đang thử — đây chính là
      // thao tác nhạy cảm nhất của nhóm route này, phải để lại dấu vết. Chỉ
      // ghi cờ: thử với giá trị đã lưu hay giá trị chưa-lưu từ form, kết quả.
      await deps.audit.record({
        actorId: deps.resolvePrincipal(req)!.userId,
        action: 'JIRA_CONNECTION_TESTED',
        projectKey,
        detail: {
          ok: result.ok,
          usedUnsavedBaseUrl: parsed.data.jiraBaseUrl !== null,
          usedUnsavedToken: typeof parsed.data.apiToken === 'string',
          failedStep: result.ok ? null : (result.steps.find((s) => !s.ok)?.step ?? null),
        },
      });

      return result;
    }),
  );

  // Lịch sử thao tác trên kết nối Jira của một dự án — 50 dòng gần nhất.
  app.get('/api/admin/projects/:projectKey/audit', admin, async (req, reply) =>
    handle(reply, async (): Promise<ListAuditResponse> => {
      const projectKey = keyParam(req);
      await projectOrThrow(projectKey);
      const rows = await deps.audit.listForProject(projectKey, 50);
      return {
        entries: rows.map((r) => ({
          id: r.id,
          actorId: r.actorId,
          action: r.action,
          projectKey: r.projectKey,
          detail: r.detail ?? null,
          at: r.at.toISOString(),
        })),
      };
    }),
  );

  // ---- Thành viên dự án ----------------------------------------------------

  app.get('/api/admin/projects/:projectKey/members', admin, async (req, reply) =>
    handle(reply, async (): Promise<ListMembersResponse> => {
      const projectKey = keyParam(req);
      await projectOrThrow(projectKey);
      const rows = await deps.members.list(projectKey);
      const members: ProjectMemberView[] = rows.map((m) => ({
        userId: m.userId,
        role: m.role,
        displayName: m.displayName,
        addedBy: m.addedBy,
        addedAt: m.addedAt.toISOString(),
      }));
      return { members };
    }),
  );

  app.put('/api/admin/projects/:projectKey/members', admin, async (req, reply) =>
    handle(reply, async () => {
      const adminPrincipal = deps.resolvePrincipal(req)!;
      const projectKey = keyParam(req);
      await projectOrThrow(projectKey);

      const parsed = upsertMemberRequestSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error);

      const userId = normalizeIdentity(parsed.data.userId);
      if (userId === null) throw new ApiError(400, 'BAD_REQUEST', 'The user email is empty.');

      try {
        await deps.members.upsert({
          projectKey,
          userId,
          role: parsed.data.role,
          addedBy: adminPrincipal.userId,
        });
      } catch (err) {
        // FK `project_member.user_id → app_user`: user chưa được cấp ở màn
        // Users thì chưa thêm vào dự án được — thứ tự cấp quyền là có chủ đích.
        if (prismaErrorCode(err) === PRISMA_FK_VIOLATION) {
          throw new ApiError(
            400,
            'USER_NOT_PROVISIONED',
            `${userId} chưa được cấp tài khoản trong hệ thống. ` +
              'Thêm người này ở màn hình Users (POST /api/admin/users) trước, rồi mới gán vào dự án.',
          );
        }
        throw err;
      }

      return { ok: true, projectKey, userId, role: parsed.data.role };
    }),
  );

  app.delete('/api/admin/projects/:projectKey/members/:userId', admin, async (req, reply) =>
    handle(reply, async () => {
      const projectKey = keyParam(req);
      await projectOrThrow(projectKey);

      const userId = normalizeIdentity((req.params as { userId?: string }).userId);
      if (userId === null) throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the user email.');

      const removed = await deps.members.remove(projectKey, userId);
      if (!removed) {
        throw new ApiError(404, 'NOT_FOUND', `${userId} is not a member of ${projectKey}.`);
      }
      return { ok: true };
    }),
  );
}

function badRequest(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) {
  return new ApiError(
    400,
    'BAD_REQUEST',
    'The request body is not valid. Fix the highlighted fields and send it again.',
    error.issues.map((i) => ({
      level: 'ERROR' as const,
      code: 'SCHEMA_INVALID',
      message: i.message,
      path: i.path.join('.'),
    })),
  );
}
