import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { localDateOf } from '@app/engine';
import type {
  DateOnly,
  SignboardPhase,
  SignboardPhasesResponse,
  SignboardResponse,
  SignboardSubtask,
  UnparsedResponse,
  WorkCalendar,
} from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import { resolveEpicInProject } from '../services/epic-scope.js';
import { projectCtxOf, type AuthzGuards } from '../adapters/project-scope.js';
import {
  buildSignboard,
  buildUnparsedList,
  type ColumnSpec,
  type SubPhaseMetaEntry,
} from '../services/signboard.service.js';

/**
 * Ba endpoint bảng Signboard — PRD §6 — mount theo tenant:
 * `/api/projects/:projectKey/epics/:epicKey/signboard[...]` (VIEWER trở lên),
 * cộng `GET /api/projects/:projectKey/config/signboard-columns` cho cấu hình cột.
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
  /**
   * Nhãn + thứ tự cho nhóm Sub-phase khi mở `phaseCode`, khoá đã chuẩn hoá.
   *
   * Nguồn thứ tự, mạnh trước yếu: (1) cấu hình **Sub-phase order** của chính
   * `phaseCode` (bảng `sub_phase_order`, bản project ghi đè bản Mặc định) —
   * entry `pinned`; (2) Sub-phase trùng mã một Phase thì "mượn" nhãn +
   * `display_order` của Phase đó.
   */
  subPhaseMeta(projectKey: string, phaseCode: string): Promise<ReadonlyMap<string, SubPhaseMetaEntry>>;
  /** `TaskName` thô bóc từ tiêu đề — chỉ dùng để gợi ý cột mới. */
  rawTaskTypes(epicKey: string, phaseCode: string): Promise<Readonly<Record<string, string | null>>>;
}

export interface SignboardRouteDeps {
  readonly reads: SignboardReadPort;
  readonly guards: AuthzGuards;
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

  const asViewer = { preHandler: deps.guards.requireProject('VIEWER') };

  /**
   * Phần dùng chung: tra Epic + neo vào đúng tenant, CHƯA đọc `phaseCode`.
   * (Quyền đã do guard `requireProject('VIEWER')` kiểm trước khi vào handler.)
   *
   * Bộ chọn Phase chỉ cần tới đây (không có Phase nào để đọc); bảng thì gọi tiếp
   * `context` để lấy thêm `phaseCode`.
   */
  async function epicContext(req: FastifyRequest) {
    const epicKey = param(req, 'epicKey');
    const meta = await resolveEpicInProject(
      (k) => deps.reads.epicMeta(k),
      epicKey,
      projectCtxOf(req).projectKey,
    );
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

  app.get('/api/projects/:projectKey/epics/:epicKey/signboard/phases', asViewer, async (req, reply) =>
    handle(reply, async (): Promise<SignboardPhasesResponse> => {
      const { epicKey, meta } = await epicContext(req);
      return { epicKey, phases: await deps.reads.phases(epicKey, meta.projectKey) };
    }),
  );

  app.get('/api/projects/:projectKey/epics/:epicKey/signboard/phase/:phaseCode', asViewer, async (req, reply) =>
    handle(reply, async (): Promise<SignboardResponse> => {
      const { epicKey, phaseCode, meta } = await context(req);
      const [subtasks, columns, subPhaseMeta] = await Promise.all([
        deps.reads.subtasks(epicKey, phaseCode),
        deps.reads.columns(meta.projectKey),
        deps.reads.subPhaseMeta(meta.projectKey, phaseCode),
      ]);

      return buildSignboard({
        epicKey,
        phaseCode,
        asOfDate: resolveAsOfDate(req, meta.calendar),
        columns,
        subtasks,
        subPhaseMeta,
      });
    }),
  );

  app.get('/api/projects/:projectKey/epics/:epicKey/signboard/phase/:phaseCode/unparsed', asViewer, async (req, reply) =>
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

  // Cấu hình cột đã gộp kế thừa của MỘT tenant. Bản GLOBAL thuần nằm trong
  // payload của /api/admin/config/phase — không cần endpoint đọc riêng.
  app.get('/api/projects/:projectKey/config/signboard-columns', asViewer, async (req, reply) =>
    handle(reply, async () => {
      const projectKey = projectCtxOf(req).projectKey;
      return { project: projectKey, columns: await deps.reads.columns(projectKey) };
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
