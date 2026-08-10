import type { PrismaClient } from '@app/db';
import type { SignboardPhase, SignboardSubtask } from '@app/shared';
import { normalize } from '@app/engine';
import type { SignboardReadPort } from '../routes/signboard.routes.js';
import type { ColumnSpec, SubPhaseMetaEntry } from '../services/signboard.service.js';
import { createBurndownReadPort } from './burndown.adapters.js';

/**
 * Nối cổng Signboard vào Prisma.
 *
 * MỘT truy vấn cho cả bảng. Một Phase có thể có 200 Sub-task; gọi từng ticket
 * một sẽ làm API chậm gấp trăm lần mà nhìn code không thấy gì bất thường.
 */

interface SubtaskRow {
  issue_key: string;
  summary: string | null;
  function_key: string | null;
  function_name: string | null;
  sb_phase_raw: string | null;
  task_type: string | null;
  sb_parse_status: string | null;
  wbs_start_date: Date | null;
  wbs_end_date: Date | null;
  actual_start: Date | null;
  actual_end: Date | null;
  status_category: string | null;
}

const d = (v: Date | null): string | null => (v === null ? null : v.toISOString().slice(0, 10));

function toCategory(raw: string | null): 'new' | 'indeterminate' | 'done' {
  return raw === 'done' || raw === 'indeterminate' ? raw : 'new';
}

export function createSignboardReadPort(prisma: PrismaClient): SignboardReadPort {
  const burndown = createBurndownReadPort(prisma);

  return {
    epicMeta: (epicKey) => burndown.epicMeta(epicKey),

    async phases(epicKey, projectKey): Promise<readonly SignboardPhase[]> {
      // Đếm Sub-task theo Phase, đọc THẲNG từ `jira_issue` — cùng nguồn với truy
      // vấn dựng bảng bên dưới. Bảo đảm mỗi Phase liệt kê ở đây mở ra là có ô;
      // dùng `phase_rollup` sẽ lệch khi job tính lại chưa chạy.
      const counts = await prisma.$queryRawUnsafe<{ phase_code: string; subtask_count: number }[]>(
        `SELECT i.phase_code, COUNT(*)::int AS subtask_count
           FROM jira_issue i
          WHERE i.epic_key = $1
            AND i.issue_type = 'SUBTASK' AND i.removed_at IS NULL
            AND i.phase_code IS NOT NULL
          GROUP BY i.phase_code`,
        epicKey,
      );

      // Nhãn + thứ tự hiển thị lấy từ cấu hình đang hiệu lực (bản project ghi đè
      // bản Mặc định), giống cách `phaseLabels` của Burndown làm.
      const defs = await prisma.$queryRawUnsafe<
        { phase_code: string; label_vi: string; display_order: number }[]
      >(
        `SELECT d.phase_code, d.label_vi, d.display_order
           FROM phase_definition d
           JOIN phase_config_set s ON s.id = d.config_set_id
          WHERE s.is_active = true
            AND (s.project_key = $1 OR s.scope = 'GLOBAL')
          ORDER BY CASE WHEN s.project_key = $1 THEN 0 ELSE 1 END, d.display_order`,
        projectKey,
      );

      const meta = new Map<string, { label: string; order: number }>();
      for (const d of defs) {
        if (!meta.has(d.phase_code)) meta.set(d.phase_code, { label: d.label_vi, order: d.display_order });
      }

      const phases: SignboardPhase[] = counts.map((c) => ({
        phaseCode: c.phase_code,
        label: meta.get(c.phase_code)?.label ?? null,
        subtaskCount: Number(c.subtask_count),
      }));

      // Phase có trong cấu hình đứng trước, theo `display_order`; Phase lạ (chưa
      // định nghĩa) xếp sau, theo mã — không im lặng bỏ chúng đi.
      phases.sort((a, b) => {
        const oa = meta.get(a.phaseCode)?.order;
        const ob = meta.get(b.phaseCode)?.order;
        if (oa !== undefined && ob !== undefined) return oa - ob || a.phaseCode.localeCompare(b.phaseCode);
        if (oa !== undefined) return -1;
        if (ob !== undefined) return 1;
        return a.phaseCode.localeCompare(b.phaseCode);
      });

      return phases;
    },

    async subtasks(epicKey, phaseCode): Promise<readonly SignboardSubtask[]> {
      // Dùng index `(epic_key, phase_code, function_name, task_type)` của T-02.
      const rows = await prisma.$queryRawUnsafe<SubtaskRow[]>(
        `SELECT i.issue_key, i.summary, i.function_key, i.function_name, i.sb_phase_raw,
                i.task_type, i.sb_parse_status, i.wbs_start_date, i.wbs_end_date, i.status_category,
                a.actual_start, a.actual_end
           FROM jira_issue i
           LEFT JOIN subtask_actual_dates a ON a.issue_key = i.issue_key
          WHERE i.epic_key = $1 AND i.phase_code = $2
            AND i.issue_type = 'SUBTASK' AND i.removed_at IS NULL`,
        epicKey,
        phaseCode,
      );

      return rows.map((r) => ({
        issueKey: r.issue_key,
        summary: r.summary ?? r.issue_key,
        functionKey: r.function_key,
        functionName: r.function_name,
        subPhaseRaw: r.sb_phase_raw,
        taskType: r.task_type,
        parseStatus: r.sb_parse_status ?? 'UNPARSED',
        planStart: d(r.wbs_start_date),
        planEnd: d(r.wbs_end_date),
        actualStart: d(r.actual_start),
        actualEnd: d(r.actual_end),
        statusCategory: toCategory(r.status_category),
      }));
    },

    async columns(projectKey): Promise<readonly ColumnSpec[]> {
      const rows = await prisma.$queryRawUnsafe<
        { task_code: string; label_vi: string; project_key: string | null }[]
      >(
        `SELECT c.task_code, c.label_vi, s.project_key
           FROM signboard_column c
           JOIN phase_config_set s ON s.id = c.config_set_id
          WHERE s.is_active = true
            AND (s.project_key = $1 OR s.scope = 'GLOBAL')
          ORDER BY CASE WHEN s.project_key = $1 THEN 0 ELSE 1 END, c.display_order`,
        projectKey,
      );

      // Bản của project đứng trước nên ghi đè bản Mặc định một cách tự nhiên.
      const seen = new Map<string, ColumnSpec>();
      for (const r of rows) {
        if (!seen.has(r.task_code)) seen.set(r.task_code, { taskCode: r.task_code, label: r.label_vi });
      }
      return [...seen.values()];
    },

    async subPhaseMeta(projectKey): Promise<ReadonlyMap<string, SubPhaseMetaEntry>> {
      // Cùng nguồn nhãn + thứ tự với `phases()`: định nghĩa Phase đang hiệu lực,
      // bản project ghi đè bản Mặc định. Khoá theo `normalize(phase_code)` để
      // khớp với `[Sub-phase]` thô trong tiêu đề (đã chuẩn hoá cùng cách).
      const defs = await prisma.$queryRawUnsafe<
        { phase_code: string; label_vi: string; display_order: number }[]
      >(
        `SELECT d.phase_code, d.label_vi, d.display_order
           FROM phase_definition d
           JOIN phase_config_set s ON s.id = d.config_set_id
          WHERE s.is_active = true
            AND (s.project_key = $1 OR s.scope = 'GLOBAL')
          ORDER BY CASE WHEN s.project_key = $1 THEN 0 ELSE 1 END, d.display_order`,
        projectKey,
      );

      const meta = new Map<string, SubPhaseMetaEntry>();
      for (const d of defs) {
        const key = normalize(d.phase_code);
        // Bản project đứng trước → giữ lần gặp ĐẦU (ghi đè bản Mặc định).
        if (!meta.has(key)) meta.set(key, { label: d.label_vi, order: d.display_order });
      }
      return meta;
    },

    async rawTaskTypes(epicKey, phaseCode) {
      // `sb_task_raw` là phần TaskName bóc từ tiêu đề, giữ nguyên dù không khớp
      // cột nào — chính là thứ cần để gợi ý cột mới (E-29).
      const rows = await prisma.$queryRawUnsafe<{ issue_key: string; sb_task_raw: string | null }[]>(
        `SELECT issue_key, sb_task_raw
           FROM jira_issue
          WHERE epic_key = $1 AND phase_code = $2
            AND issue_type = 'SUBTASK' AND removed_at IS NULL
            AND task_type IS NULL`,
        epicKey,
        phaseCode,
      );
      return Object.fromEntries(rows.map((r) => [r.issue_key, r.sb_task_raw]));
    },
  };
}
