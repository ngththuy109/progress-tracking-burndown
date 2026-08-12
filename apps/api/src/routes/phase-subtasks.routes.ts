import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PhaseSubtaskResponse } from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import { resolveEpicInProject } from '../services/epic-scope.js';
import { projectCtxOf, type AuthzGuards } from '../adapters/project-scope.js';
import {
  buildPhaseSubtaskList,
  type LoadedSubtask,
  type PhaseDefinitionLite,
} from '../services/phase-subtasks.service.js';

/**
 * Endpoint liệt kê Sub-task theo Phase — mount theo tenant:
 * `GET /api/projects/:projectKey/epics/:epicKey/phase-subtasks` (VIEWER trở lên).
 *
 * Tầng này CHỈ điều phối: guard kiểm quyền, `resolveEpicInProject` neo Epic vào
 * đúng tenant, rồi gọi hàm thuần. Không một dòng logic gom nhóm nào ở đây — nó
 * nằm ở `phase-subtasks.service`.
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
  readonly guards: AuthzGuards;
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

  app.get(
    '/api/projects/:projectKey/epics/:epicKey/phase-subtasks',
    { preHandler: deps.guards.requireProject('VIEWER') },
    async (req, reply) =>
      handle(reply, async (): Promise<PhaseSubtaskResponse> => {
        const epicKey = paramEpicKey(req);
        const meta = await resolveEpicInProject(
          (k) => deps.reads.epicMeta(k),
          epicKey,
          projectCtxOf(req).projectKey,
        );

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
