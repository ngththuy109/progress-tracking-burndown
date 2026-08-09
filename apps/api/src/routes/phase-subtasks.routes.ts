import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Principal, PhaseSubtaskResponse } from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import {
  buildPhaseSubtaskList,
  type LoadedSubtask,
  type PhaseDefinitionLite,
} from '../services/phase-subtasks.service.js';

/**
 * Endpoint liệt kê Sub-task theo Phase — cho một Epic.
 *
 * Tầng này CHỈ điều phối: đọc tham số, kiểm quyền, gọi cổng, gọi hàm thuần.
 * Không một dòng logic gom nhóm nào ở đây — nó nằm ở `phase-subtasks.service`.
 *
 * KHÔNG cache: danh sách này bám sát dữ liệu Jira mới nhất, và nó rẻ (một truy
 * vấn Sub-task + một truy vấn Phase). Cache lại chỉ tổ để PM thấy ticket cũ sau
 * khi resync mà không hiểu vì sao.
 */

export interface PhaseSubtaskReadPort {
  /** Epic có trong sổ theo dõi không, và thuộc project nào. */
  epicMeta(epicKey: string): Promise<{ projectKey: string } | null>;
  /** MỘT truy vấn lấy mọi Sub-task đang hoạt động của Epic. */
  subtasks(epicKey: string): Promise<readonly LoadedSubtask[]>;
  /** Phase đang hiệu lực, đã gộp kế thừa, sắp theo `display_order`. */
  phaseDefinitions(projectKey: string): Promise<readonly PhaseDefinitionLite[]>;
}

export interface PhaseSubtaskRouteDeps {
  readonly reads: PhaseSubtaskReadPort;
  resolvePrincipal(req: FastifyRequest): Principal | null;
}

export function registerPhaseSubtaskRoutes(app: FastifyInstance, deps: PhaseSubtaskRouteDeps): void {
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await reply.send(await fn());
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      app.log.error({ err }, 'Unexpected error in the Phase sub-tasks API');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  app.get('/api/epic/:epicKey/phase-subtasks', async (req, reply) =>
    handle(reply, async (): Promise<PhaseSubtaskResponse> => {
      const principal = deps.resolvePrincipal(req);
      if (!principal) {
        throw new ApiError(
          401,
          'UNAUTHENTICATED',
          'This request has no signed-in user. Reload the page to sign in again.',
        );
      }

      const epicKey = paramEpicKey(req);

      const meta = await deps.reads.epicMeta(epicKey);
      if (meta === null) {
        throw new ApiError(
          404,
          'EPIC_NOT_FOUND',
          `Epic ${epicKey} is not tracked. Add it on the Epics screen first.`,
        );
      }

      // VIEWER và ADMIN xem tất cả (dữ liệu báo cáo); PM chỉ xem project mình
      // phụ trách — cùng luật với biểu đồ Burndown và Signboard.
      if (principal.role === 'PM' && !principal.projects.includes(meta.projectKey)) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          `You are not assigned to project ${meta.projectKey}, so you cannot view this Epic’s sub-tasks. ` +
            'Ask an admin if you need access.',
        );
      }

      const [subtasks, definitions] = await Promise.all([
        deps.reads.subtasks(epicKey),
        deps.reads.phaseDefinitions(meta.projectKey),
      ]);

      return buildPhaseSubtaskList({ epicKey, definitions, subtasks });
    }),
  );
}

function paramEpicKey(req: FastifyRequest): string {
  const key = (req.params as { epicKey?: string }).epicKey?.trim();
  if (key === undefined || key === '') {
    throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the Epic key.');
  }
  return key;
}
