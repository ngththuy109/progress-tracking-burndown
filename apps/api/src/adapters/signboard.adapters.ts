import type { PrismaClient } from '@app/db';
import type { SignboardPhase, SignboardPic, SignboardStage, SignboardSubtask } from '@app/shared';
import { normalize, normalizePreservingCase } from '@app/engine';
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
  /** JSONB — driver `pg` trả về đã parse. Có thể null (chưa có PIC / cột mới). */
  sb_request_participants: unknown;
}

const d = (v: Date | null): string | null => (v === null ? null : v.toISOString().slice(0, 10));

/**
 * Chuẩn hoá cột JSONB `sb_request_participants` thành `SignboardPic[]`.
 *
 * Dùng chung với khu Data quality của màn Monitoring (`ops.adapters.ts`): cùng
 * một cột dữ liệu thì phải đọc theo cùng một luật, không chép lại thành hai bản.
 *
 * Đọc PHÒNG THỦ: cột do worker ghi (đã đúng hình dạng) nhưng vẫn có thể là null,
 * hoặc dữ liệu cũ trước migration. Bỏ phần tử thiếu `accountId`; `displayName`
 * không phải chuỗi thì coi như `null` (chưa tra được tên).
 */
export function toPics(raw: unknown): SignboardPic[] {
  // Driver `pg` thường trả JSONB đã parse (mảng), nhưng phòng ca trả về chuỗi.
  const value =
    typeof raw === 'string'
      ? ((): unknown => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })()
      : raw;
  if (!Array.isArray(value)) return [];
  const out: SignboardPic[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as { accountId?: unknown; displayName?: unknown };
    if (typeof o.accountId !== 'string' || o.accountId === '') continue;
    out.push({
      accountId: o.accountId,
      displayName: typeof o.displayName === 'string' ? o.displayName : null,
    });
  }
  return out;
}

function toCategory(raw: string | null): 'new' | 'indeterminate' | 'done' {
  return raw === 'done' || raw === 'indeterminate' ? raw : 'new';
}

export function createSignboardReadPort(prisma: PrismaClient): SignboardReadPort {
  const burndown = createBurndownReadPort(prisma);

  return {
    epicMeta: (epicKey) => burndown.epicMeta(epicKey),

    async phases(epicKey, projectKey, stage): Promise<readonly SignboardPhase[]> {
      // Đếm Sub-task theo Phase, đọc THẲNG từ `jira_issue` — cùng nguồn với truy
      // vấn dựng bảng bên dưới. Bảo đảm mỗi Phase liệt kê ở đây mở ra là có ô;
      // dùng `phase_rollup` sẽ lệch khi job tính lại chưa chạy.
      //
      // Có `stage` thì đếm TRONG nhóm tầng-1 đó (cùng điều kiện với `subtasks` —
      // bộ chọn Phase phải khớp bảng). `jsonb_array_length ≥ 2` chặn lá 1 tầng:
      // với chúng group_path[0] chính là phase_code, so với mã GĐ là vô nghĩa.
      const counts = await prisma.$queryRawUnsafe<{ phase_code: string; subtask_count: number }[]>(
        `SELECT i.phase_code, COUNT(*)::int AS subtask_count
           FROM jira_issue i
          WHERE i.epic_key = $1
            AND i.issue_type = 'SUBTASK' AND i.removed_at IS NULL
            AND i.phase_code IS NOT NULL
            ${stage === null ? '' : `AND jsonb_array_length(i.group_path) >= 2 AND i.group_path->>0 = $2`}
          GROUP BY i.phase_code`,
        ...(stage === null ? [epicKey] : [epicKey, stage]),
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

    async stages(epicKey): Promise<{ tierLabel: string | null; items: readonly SignboardStage[] }> {
      // Nhóm tầng-1 CÓ lá trong Epic. Chỉ tính lá `group_path` sâu ≥ 2 — lá 1 tầng
      // thì phần tử đầu là phase_code, không phải một chiều nhóm riêng. Epic 1 tầng
      // (hoặc chưa resync sau khi đổi config) trả rỗng → UI ẩn bộ lọc, chạy như cũ.
      const counts = await prisma.$queryRawUnsafe<{ code: string; subtask_count: number }[]>(
        `SELECT i.group_path->>0 AS code, COUNT(*)::int AS subtask_count
           FROM jira_issue i
          WHERE i.epic_key = $1
            AND i.issue_type = 'SUBTASK' AND i.removed_at IS NULL
            AND jsonb_array_length(i.group_path) >= 2
          GROUP BY 1`,
        epicKey,
      );
      if (counts.length === 0) return { tierLabel: null, items: [] };

      // Nhãn + thứ tự từ cấu hình tầng đang hiệu lực. Màn Cấu trúc tầng chạy trên
      // GLOBAL (single-tenant) nên chỉ đọc GLOBAL — khớp nơi ghi.
      const [tierRows, defs] = await Promise.all([
        prisma.$queryRawUnsafe<{ label_vi: string }[]>(
          `SELECT t.label_vi
             FROM group_tier t
             JOIN phase_config_set s ON s.id = t.config_set_id
            WHERE s.is_active = true AND s.scope = 'GLOBAL' AND t.tier_order = 1`,
        ),
        prisma.$queryRawUnsafe<{ group_code: string; label_vi: string; display_order: number }[]>(
          `SELECT d.group_code, d.label_vi, d.display_order
             FROM group_tier_definition d
             JOIN phase_config_set s ON s.id = d.config_set_id
            WHERE s.is_active = true AND s.scope = 'GLOBAL' AND d.tier_order = 1
            ORDER BY d.display_order`,
        ),
      ]);

      const meta = new Map(defs.map((d) => [d.group_code, { label: d.label_vi, order: d.display_order }]));
      const items: SignboardStage[] = counts.map((c) => ({
        code: c.code,
        label: meta.get(c.code)?.label ?? null,
        subtaskCount: Number(c.subtask_count),
      }));
      // Nhóm có trong định nghĩa đứng trước theo display_order; nhóm lạ xếp sau
      // theo mã — cùng luật sắp với danh sách Phase.
      items.sort((a, b) => {
        const oa = meta.get(a.code)?.order;
        const ob = meta.get(b.code)?.order;
        if (oa !== undefined && ob !== undefined) return oa - ob || a.code.localeCompare(b.code);
        if (oa !== undefined) return -1;
        if (ob !== undefined) return 1;
        return a.code.localeCompare(b.code);
      });

      return { tierLabel: tierRows[0]?.label_vi ?? null, items };
    },

    async subtasks(epicKey, phaseCode, stage): Promise<readonly SignboardSubtask[]> {
      // Dùng index `(epic_key, phase_code, function_name, task_type)` của T-02.
      // Lọc `stage` NGAY TRONG SQL: ô Signboard là kết quả gộp server-side nên
      // phải lọc trước khi dựng bảng (cùng điều kiện với `phases`).
      const rows = await prisma.$queryRawUnsafe<SubtaskRow[]>(
        `SELECT i.issue_key, i.summary, i.function_key, i.function_name, i.sb_phase_raw,
                i.task_type, i.sb_parse_status, i.wbs_start_date, i.wbs_end_date, i.status_category,
                i.sb_request_participants, a.actual_start, a.actual_end
           FROM jira_issue i
           LEFT JOIN subtask_actual_dates a ON a.issue_key = i.issue_key
          WHERE i.epic_key = $1 AND i.phase_code = $2
            AND i.issue_type = 'SUBTASK' AND i.removed_at IS NULL
            ${stage === null ? '' : `AND jsonb_array_length(i.group_path) >= 2 AND i.group_path->>0 = $3`}`,
        ...(stage === null ? [epicKey, phaseCode] : [epicKey, phaseCode, stage]),
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
        pics: toPics(r.sb_request_participants),
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

    async subPhaseMeta(projectKey, phaseCode): Promise<ReadonlyMap<string, SubPhaseMetaEntry>> {
      // Lớp NỀN — cùng nguồn nhãn + thứ tự với `phases()`: định nghĩa Phase đang
      // hiệu lực, bản project ghi đè bản Mặc định. Khoá theo `normalize(phase_code)`
      // để khớp với `[Sub-phase]` thô trong tiêu đề (đã chuẩn hoá cùng cách).
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

      // Lớp ĐÈ — cấu hình Sub-phase order RIÊNG của Phase đang xem (khu ⑤ ở màn
      // Signboard columns). Entry ở đây `pinned`: đứng trước mọi thứ tự "mượn".
      const orders = await prisma.$queryRawUnsafe<
        { phase_code: string; sub_phase_code: string; display_order: number; scope: string }[]
      >(
        `SELECT o.phase_code, o.sub_phase_code, o.display_order, s.scope
           FROM sub_phase_order o
           JOIN phase_config_set s ON s.id = o.config_set_id
          WHERE s.is_active = true
            AND (s.project_key = $1 OR s.scope = 'GLOBAL')
          ORDER BY o.display_order`,
        projectKey,
      );

      // Kế thừa THEO PHẦN, giống mọi phần cấu hình khác (PRD §2.2.6): project có
      // khai bất kỳ dòng nào thì dùng TRỌN bộ của project, không trộn từng dòng
      // với bộ Mặc định — trộn là ra một thứ tự không ai từng khai.
      const hasProjectRows = orders.some((o) => o.scope === 'PROJECT');
      const phaseKey = normalize(phaseCode);
      for (const o of orders) {
        if ((o.scope === 'PROJECT') !== hasProjectRows) continue;
        if (normalize(o.phase_code) !== phaseKey) continue;
        const key = normalize(o.sub_phase_code);
        meta.set(key, {
          // Nhãn đẹp (nếu Sub-phase trùng mã một Phase) vẫn giữ; chỉ thứ tự bị đè.
          label: meta.get(key)?.label ?? normalizePreservingCase(o.sub_phase_code),
          order: o.display_order,
          pinned: true,
        });
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
