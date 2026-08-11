import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  PlanConflictCountsResponse,
  PlanConflictsResponse,
  Principal,
  WorkSide,
} from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import { assertCanRead } from './burndown.routes.js';
import {
  computePlanConflicts,
  type PlanCheckSubtask,
  type SideCalendar,
} from '../services/plan-conflicts.service.js';

/**
 * API kiểm tra plan rơi vào ngày nghỉ — T-37.
 *
 * Hệ thống đồng bộ MỘT CHIỀU từ Jira về, nên "kiểm tra khi làm plan" nghĩa là:
 * sau mỗi lần sync, báo cáo Sub-task nào có ngày bắt đầu/kết thúc kế hoạch rơi
 * trúng ngày nghỉ của phía làm nó — PM sửa plan trên Jira rồi sync lại. Cùng
 * mẫu với báo cáo "thiếu ngày kế hoạch" (R-08).
 *
 * Tính LÚC ĐỌC, không lưu snapshot: danh sách vi phạm phụ thuộc lịch nghỉ và
 * cấu hình cột — hai thứ đổi được bất kỳ lúc nào, chốt sẵn từ đêm hôm trước sẽ
 * hiện kết quả cũ.
 */

export interface PlanConflictReadPort {
  /** `null` = Epic không có trong sổ theo dõi. */
  epicMeta(epicKey: string): Promise<{ projectKey: string; calendarId: string } | null>;
  /** Epic trong sổ (lọc theo project nếu có) — cho endpoint tổng hợp. */
  listEpics(
    projectKey: string | null,
  ): Promise<readonly { epicKey: string; projectKey: string; calendarId: string }[]>;
  /** Sub-task còn hoạt động có ít nhất một ngày kế hoạch, kèm Phase của Task cha. */
  subtasksForCheck(epicKey: string): Promise<readonly PlanCheckSubtask[]>;
  /** `task_code` cột Signboard → phía làm, từ cấu hình đang hiệu lực của project. */
  columnSides(projectKey: string): Promise<ReadonlyMap<string, WorkSide>>;
  /** Lịch làm việc kèm nhãn ngày lễ. Lịch không tồn tại → mặc định T2–T6. */
  sideCalendar(calendarId: string): Promise<SideCalendar>;
}

export interface PlanConflictRouteDeps {
  readonly reads: PlanConflictReadPort;
  resolvePrincipal(req: FastifyRequest): Principal | null;
}

/** Lịch chuẩn phía khách hàng — phía JP review theo lịch này. */
export const JP_REVIEW_CALENDAR_ID = 'JP_STANDARD';

export function registerPlanConflictRoutes(app: FastifyInstance, deps: PlanConflictRouteDeps): void {
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await reply.send(await fn());
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      app.log.error({ err }, 'Lỗi ngoài dự kiến ở API kiểm tra plan-ngày nghỉ');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const requirePrincipal = (req: FastifyRequest): Principal => {
    const p = deps.resolvePrincipal(req);
    if (!p) throw new ApiError(401, 'UNAUTHENTICATED', 'This request has no signed-in user. Reload the page to sign in again.');
    return p;
  };

  const conflictsOf = async (epic: {
    epicKey: string;
    projectKey: string;
    calendarId: string;
  }): Promise<PlanConflictsResponse> => {
    const [subtasks, columnSides, vn, jp] = await Promise.all([
      deps.reads.subtasksForCheck(epic.epicKey),
      deps.reads.columnSides(epic.projectKey),
      // Phía VN làm theo lịch THỰC THI của chính Epic; phía JP review theo lịch
      // chuẩn khách hàng. Hai phía nghỉ khác ngày — đó chính là lý do tồn tại
      // của cả chức năng này.
      deps.reads.sideCalendar(epic.calendarId),
      deps.reads.sideCalendar(JP_REVIEW_CALENDAR_ID),
    ]);
    return computePlanConflicts({
      epicKey: epic.epicKey,
      subtasks,
      columnSides,
      calendars: { VN: vn, JP: jp },
    });
  };

  app.get('/api/epics/:epicKey/plan-conflicts', async (req, reply) =>
    handle(reply, async (): Promise<PlanConflictsResponse> => {
      const principal = requirePrincipal(req);
      const epicKey = epicKeyParam(req);

      const meta = await deps.reads.epicMeta(epicKey);
      if (meta === null) {
        throw new ApiError(
          404,
          'EPIC_NOT_FOUND',
          `Epic ${epicKey} is not tracked. Add it on the Epics screen first.`,
        );
      }
      assertCanRead(principal, meta.projectKey);

      return conflictsOf({ epicKey, ...meta });
    }),
  );

  /**
   * Tổng hợp cho màn hình Epics: số vi phạm của TỪNG Epic trong một lần gọi.
   * PM chỉ nhận số của project mình phụ trách — cùng luật với biểu đồ (§9.3).
   */
  app.get('/api/plan-conflicts/summary', async (req, reply) =>
    handle(reply, async (): Promise<PlanConflictCountsResponse> => {
      const principal = requirePrincipal(req);
      const project = queryString(req, 'project');

      const epics = (await deps.reads.listEpics(project)).filter(
        (e) => principal.role !== 'PM' || principal.projects.includes(e.projectKey),
      );

      // Tuần tự sẽ chậm khi có nhiều Epic; chạy đồng thời cả danh sách — mỗi
      // Epic chỉ là vài query đọc.
      const results = await Promise.all(epics.map((e) => conflictsOf(e)));
      return {
        counts: results
          .filter((r) => r.summary.total > 0)
          .map((r) => ({ epicKey: r.epicKey, total: r.summary.total })),
      };
    }),
  );
}

function epicKeyParam(req: FastifyRequest): string {
  const key = (req.params as { epicKey?: string }).epicKey?.trim();
  if (!key) throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the Epic key.');
  return key;
}

function queryString(req: FastifyRequest, name: string): string | null {
  const raw = (req.query as Record<string, unknown>)[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim();
}
