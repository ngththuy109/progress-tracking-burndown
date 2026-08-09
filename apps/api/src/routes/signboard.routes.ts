import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { localDateOf } from '@app/engine';
import type {
  DateOnly,
  Principal,
  SignboardPhase,
  SignboardPhasesResponse,
  SignboardResponse,
  SignboardSubtask,
  UnparsedResponse,
  WorkCalendar,
} from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import { buildSignboard, buildUnparsedList, type ColumnSpec } from '../services/signboard.service.js';

/**
 * Ba endpoint bảng Signboard — PRD §6.
 *
 * KHÔNG cache. Trạng thái ô phụ thuộc "hôm nay"; cache qua nửa đêm sẽ trả trạng
 * thái của hôm qua và KHÔNG AI NHẬN RA — bảng vẫn hiện, chỉ là sai.
 */

export interface SignboardReadPort {
  epicMeta(epicKey: string): Promise<{ projectKey: string; calendar: WorkCalendar } | null>;
  /**
   * Các Phase CÓ Sub-task trong Epic, kèm nhãn và số lượng, sắp theo cấu hình.
   *
   * Chính là danh sách để PM chọn thay vì gõ tay — mỗi mục ở đây bảo đảm mở ra
   * bảng sẽ có dữ liệu.
   */
  phases(epicKey: string, projectKey: string): Promise<readonly SignboardPhase[]>;
  /** MỘT truy vấn lấy mọi Sub-task của `(epicKey, phaseCode)`. */
  subtasks(epicKey: string, phaseCode: string): Promise<readonly SignboardSubtask[]>;
  /** Cột đang hiệu lực, đã gộp kế thừa, sắp theo `display_order`. */
  columns(projectKey: string): Promise<readonly ColumnSpec[]>;
  /** `TaskName` thô bóc từ tiêu đề — chỉ dùng để gợi ý cột mới. */
  rawTaskTypes(epicKey: string, phaseCode: string): Promise<Readonly<Record<string, string | null>>>;
}

export interface SignboardRouteDeps {
  readonly reads: SignboardReadPort;
  resolvePrincipal(req: FastifyRequest): Principal | null;
  /** Đồng hồ, nhận qua cổng để test đóng băng được. */
  readonly now: () => Date;
}

export function registerSignboardRoutes(app: FastifyInstance, deps: SignboardRouteDeps): void {
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await reply.send(await fn());
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      app.log.error({ err }, 'Unexpected error in the Signboard API');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  /**
   * Phần dùng chung: xác thực + tra Epic + kiểm quyền, CHƯA đọc `phaseCode`.
   *
   * Bộ chọn Phase chỉ cần tới đây (không có Phase nào để đọc); bảng thì gọi tiếp
   * `context` để lấy thêm `phaseCode`.
   */
  async function epicContext(req: FastifyRequest) {
    const principal = deps.resolvePrincipal(req);
    if (!principal) throw new ApiError(401, 'UNAUTHENTICATED', 'This request has no signed-in user. Reload the page to sign in again.');

    const epicKey = param(req, 'epicKey');

    const meta = await deps.reads.epicMeta(epicKey);
    if (meta === null) {
      throw new ApiError(
        404,
        'EPIC_NOT_FOUND',
        `Epic ${epicKey} is not tracked. Add it on the Epics screen first.`,
      );
    }
    if (principal.role === 'PM' && !principal.projects.includes(meta.projectKey)) {
      throw new ApiError(403, 'FORBIDDEN', `You are not assigned to project ${meta.projectKey}.`);
    }

    return { epicKey, meta };
  }

  async function context(req: FastifyRequest) {
    const { epicKey, meta } = await epicContext(req);
    const phaseCode = param(req, 'phaseCode');
    return { epicKey, phaseCode, meta };
  }

  /**
   * "Hôm nay" theo múi giờ của lịch Epic, KHÔNG theo múi giờ máy chủ.
   *
   * Lấy `new Date()` của máy chủ (thường chạy UTC) sẽ làm bảng đổi trạng thái
   * lúc 7 giờ sáng giờ Việt Nam thay vì lúc nửa đêm.
   */
  function resolveAsOfDate(req: FastifyRequest, calendar: WorkCalendar): DateOnly {
    const raw = (req.query as { asOfDate?: string }).asOfDate?.trim();
    if (raw === undefined || raw === '') return localDateOf(deps.now().getTime(), calendar.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new ApiError(400, 'BAD_REQUEST', `asOfDate must look like YYYY-MM-DD, got "${raw}".`);
    }
    return raw;
  }

  app.get('/api/signboard/epic/:epicKey/phases', async (req, reply) =>
    handle(reply, async (): Promise<SignboardPhasesResponse> => {
      const { epicKey, meta } = await epicContext(req);
      return { epicKey, phases: await deps.reads.phases(epicKey, meta.projectKey) };
    }),
  );

  app.get('/api/signboard/epic/:epicKey/phase/:phaseCode', async (req, reply) =>
    handle(reply, async (): Promise<SignboardResponse> => {
      const { epicKey, phaseCode, meta } = await context(req);
      const [subtasks, columns] = await Promise.all([
        deps.reads.subtasks(epicKey, phaseCode),
        deps.reads.columns(meta.projectKey),
      ]);

      return buildSignboard({
        epicKey,
        phaseCode,
        asOfDate: resolveAsOfDate(req, meta.calendar),
        columns,
        subtasks,
      });
    }),
  );

  app.get('/api/signboard/epic/:epicKey/phase/:phaseCode/unparsed', async (req, reply) =>
    handle(reply, async (): Promise<UnparsedResponse> => {
      const { epicKey, phaseCode } = await context(req);
      const [subtasks, raw] = await Promise.all([
        deps.reads.subtasks(epicKey, phaseCode),
        deps.reads.rawTaskTypes(epicKey, phaseCode),
      ]);

      return buildUnparsedList({
        epicKey,
        phaseCode,
        subtasks,
        rawTaskTypeOf: (s) => raw[s.issueKey] ?? null,
      });
    }),
  );

  app.get('/api/config/signboard-columns', async (req, reply) =>
    handle(reply, async () => {
      const projectKey = (req.query as { project?: string }).project?.trim() ?? '';
      return { project: projectKey === '' ? null : projectKey, columns: await deps.reads.columns(projectKey) };
    }),
  );
}

function param(req: FastifyRequest, name: string): string {
  const value = (req.params as Record<string, string | undefined>)[name]?.trim();
  if (value === undefined || value === '') {
    throw new ApiError(400, 'BAD_REQUEST', `The URL is missing the "${name}" parameter.`);
  }
  return value;
}
