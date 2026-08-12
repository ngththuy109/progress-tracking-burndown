import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  PlanConflictCountsResponse,
  PlanConflictsResponse,
  WorkSide,
} from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import { resolveEpicInProject } from '../services/epic-scope.js';
import { projectCtxOf, type AuthzGuards } from '../adapters/project-scope.js';
import {
  computePlanConflicts,
  type PlanCheckSubtask,
  type SideCalendar,
} from '../services/plan-conflicts.service.js';

/**
 * API kiểm tra plan rơi vào ngày nghỉ — T-37 — mount theo tenant:
 *
 *   GET /api/projects/:projectKey/epics/:epicKey/plan-conflicts  (VIEWER trở lên)
 *   GET /api/projects/:projectKey/plan-conflicts/summary          (VIEWER trở lên)
 *
 * Bản tổng hợp CHỈ đếm Epic của tenant trong URL — không còn đường đọc số liệu
 * xuyên dự án.
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
  /** Epic trong sổ của MỘT project — cho endpoint tổng hợp. */
  listEpics(
    projectKey: string,
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
  readonly guards: AuthzGuards;
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

  const asViewer = { preHandler: deps.guards.requireProject('VIEWER') };

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

  app.get(
    '/api/projects/:projectKey/epics/:epicKey/plan-conflicts',
    asViewer,
    async (req, reply) =>
      handle(reply, async (): Promise<PlanConflictsResponse> => {
        const epicKey = epicKeyParam(req);
        const meta = await resolveEpicInProject(
          (k) => deps.reads.epicMeta(k),
          epicKey,
          projectCtxOf(req).projectKey,
        );
        return conflictsOf({ epicKey, ...meta });
      }),
  );

  /**
   * Tổng hợp cho màn hình Epics: số vi phạm của TỪNG Epic trong một lần gọi —
   * chỉ Epic của tenant trong URL.
   */
  app.get('/api/projects/:projectKey/plan-conflicts/summary', asViewer, async (req, reply) =>
    handle(reply, async (): Promise<PlanConflictCountsResponse> => {
      const epics = await deps.reads.listEpics(projectCtxOf(req).projectKey);

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
