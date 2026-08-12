import type { PrismaClient } from '@app/db';
import { UNCLASSIFIED_PHASE, type StatusCategory } from '@app/shared';
import type { PhaseSubtaskReadPort } from '../routes/phase-subtasks.routes.js';
import type { LoadedSubtask, PhaseDefinitionLite } from '../services/phase-subtasks.service.js';
import { createBurndownReadPort } from './burndown.adapters.js';

/**
 * Nối cổng "Sub-task theo Phase" vào Prisma.
 *
 * MỘT truy vấn cho toàn bộ Sub-task của Epic (một Phase có thể có hàng trăm
 * ticket; gọi lẻ từng cái sẽ làm API chậm gấp trăm lần mà nhìn code không thấy
 * gì bất thường), MỘT truy vấn cho bộ Phase đang hiệu lực.
 */

interface SubtaskRow {
  issue_key: string;
  summary: string | null;
  parent_key: string | null;
  phase_code: string | null;
  status_category: string | null;
  original_estimate_s: bigint | number | null;
  time_spent_s: bigint | number | null;
  remaining_estimate_s: bigint | number | null;
  wbs_start_date: Date | null;
  wbs_end_date: Date | null;
  actual_start: Date | null;
  actual_end: Date | null;
  function_name: string | null;
  task_type: string | null;
}

const n = (v: bigint | number | null): number => (v === null ? 0 : Number(v));
const d = (v: Date | null): string | null => (v === null ? null : v.toISOString().slice(0, 10));

function toCategory(raw: string | null): StatusCategory {
  return raw === 'done' || raw === 'indeterminate' ? raw : 'new';
}

export function createPhaseSubtaskReadPort(prisma: PrismaClient): PhaseSubtaskReadPort {
  const burndown = createBurndownReadPort(prisma);

  return {
    // `epicMeta` của Burndown trả kèm `calendar`; ở đây chỉ cần `projectKey`,
    // nên nhận nguyên object rộng hơn — cấu trúc vẫn khớp cổng.
    epicMeta: (epicKey) => burndown.epicMeta(epicKey),

    async subtasks(epicKey): Promise<readonly LoadedSubtask[]> {
      const rows = await prisma.$queryRawUnsafe<SubtaskRow[]>(
        // Dùng index `(epic_key, issue_type)` của T-02. Chỉ lấy ticket ĐANG
        // HOẠT ĐỘNG: đã gỡ khỏi Epic thì không còn thuộc danh sách "hiện tại".
        // Ngày thực tế LEFT JOIN từ `subtask_actual_dates` (job dựng lại ghi,
        // T-14) — ticket chưa được tính vẫn phải hiện ra, chỉ trống hai ô đó.
        `SELECT i.issue_key, i.summary, i.parent_key, i.phase_code, i.status_category,
                i.original_estimate_s, i.time_spent_s, i.remaining_estimate_s,
                i.wbs_start_date, i.wbs_end_date,
                i.function_name, i.task_type, a.actual_start, a.actual_end
           FROM jira_issue i
           LEFT JOIN subtask_actual_dates a ON a.issue_key = i.issue_key
          WHERE i.epic_key = $1 AND i.issue_type = 'SUBTASK' AND i.removed_at IS NULL`,
        epicKey,
      );

      return rows.map((r) => ({
        issueKey: r.issue_key,
        summary: r.summary ?? r.issue_key,
        parentKey: r.parent_key,
        // `phase_code` rỗng gom vào UNCLASSIFIED — cùng quy ước với endpoint giải
        // thích số liệu (T-25), để hai màn hình không đếm lệch nhau.
        phaseCode: r.phase_code ?? UNCLASSIFIED_PHASE,
        statusCategory: toCategory(r.status_category),
        planStart: d(r.wbs_start_date),
        planEnd: d(r.wbs_end_date),
        actualStart: d(r.actual_start),
        actualEnd: d(r.actual_end),
        originalEstimateSeconds: n(r.original_estimate_s),
        timeSpentSeconds: n(r.time_spent_s),
        remainingEstimateSeconds: n(r.remaining_estimate_s),
        functionName: r.function_name,
        taskType: r.task_type,
      }));
    },

    async phaseDefinitions(projectKey): Promise<readonly PhaseDefinitionLite[]> {
      const rows = await prisma.$queryRawUnsafe<
        { phase_code: string; label_vi: string; color_hex: string | null; display_order: number }[]
      >(
        `SELECT d.phase_code, d.label_vi, d.color_hex, d.display_order
           FROM phase_definition d
           JOIN phase_config_set s ON s.id = d.config_set_id
          WHERE s.is_active = true
            AND (s.project_key = $1 OR s.scope = 'GLOBAL')
          ORDER BY CASE WHEN s.project_key = $1 THEN 0 ELSE 1 END, d.display_order`,
        projectKey,
      );

      // Bản của project đứng trước nên ghi đè bản Mặc định một cách tự nhiên.
      const seen = new Map<string, PhaseDefinitionLite>();
      for (const r of rows) {
        if (!seen.has(r.phase_code)) {
          seen.set(r.phase_code, {
            phaseCode: r.phase_code,
            label: r.label_vi,
            colorHex: r.color_hex,
            displayOrder: r.display_order,
          });
        }
      }
      return [...seen.values()];
    },
  };
}
