import type { PrismaClient } from '@app/db';
import { getCalendar } from '@app/db';
import { WORK_SIDE, type WorkSide } from '@app/shared';
import type { PlanConflictReadPort } from '../routes/plan-conflicts.routes.js';
import type { PlanCheckSubtask, SideCalendar } from '../services/plan-conflicts.service.js';

/**
 * Nối cổng kiểm tra plan-ngày nghỉ vào Prisma.
 *
 * File DUY NHẤT của nhóm plan-conflicts biết tới Prisma — tầng service là hàm
 * thuần, tầng route chỉ điều phối; cả hai test được không cần PostgreSQL.
 */
export function createPlanConflictReadPort(prisma: PrismaClient): PlanConflictReadPort {
  return {
    async epicMeta(epicKey) {
      const row = await prisma.trackedEpic.findUnique({
        where: { epicKey },
        select: { projectKey: true, calendarId: true },
      });
      return row === null ? null : { projectKey: row.projectKey, calendarId: row.calendarId };
    },

    async listEpics(projectKey) {
      return prisma.trackedEpic.findMany({
        where: projectKey === null ? {} : { projectKey },
        select: { epicKey: true, projectKey: true, calendarId: true },
        orderBy: { epicKey: 'asc' },
      });
    },

    async subtasksForCheck(epicKey): Promise<PlanCheckSubtask[]> {
      const rows = await prisma.jiraIssue.findMany({
        where: {
          epicKey,
          issueType: 'SUBTASK',
          removedAt: null,
          // Không có ngày kế hoạch nào thì thuộc báo cáo R-08, không thuộc đây.
          OR: [{ wbsStartDate: { not: null } }, { wbsEndDate: { not: null } }],
        },
        select: {
          issueKey: true,
          summary: true,
          parentKey: true,
          taskType: true,
          wbsStartDate: true,
          wbsEndDate: true,
        },
        orderBy: { issueKey: 'asc' },
      });

      // Phase lấy từ TASK CHA — nguồn phân loại chính thức (PRD §2.9.2), không
      // lấy `[Phase]` trong tiêu đề Sub-task.
      const parentKeys = [...new Set(rows.map((r) => r.parentKey).filter((k): k is string => k !== null))];
      const parents = parentKeys.length
        ? await prisma.jiraIssue.findMany({
            where: { issueKey: { in: parentKeys } },
            select: { issueKey: true, phaseCode: true },
          })
        : [];
      const phaseByParent = new Map(parents.map((p) => [p.issueKey, p.phaseCode]));

      // Cột `wbs_*` là DATE — cắt phần ngày từ mốc nửa đêm UTC, KHÔNG đổi múi
      // giờ (cùng quy tắc với ngày lễ, xem calendar.repository.ts).
      const toDateOnly = (d: Date | null): string | null =>
        d === null ? null : d.toISOString().slice(0, 10);

      return rows.map((r) => ({
        issueKey: r.issueKey,
        summary: r.summary,
        parentKey: r.parentKey,
        phaseCode: r.parentKey === null ? null : (phaseByParent.get(r.parentKey) ?? null),
        taskType: r.taskType,
        wbsStartDate: toDateOnly(r.wbsStartDate),
        wbsEndDate: toDateOnly(r.wbsEndDate),
      }));
    },

    async columnSides(projectKey) {
      // Cấu hình đang hiệu lực: bản của project đứng trước bản Mặc định để ghi
      // đè tự nhiên — cùng câu truy vấn với `phaseLabels` của Burndown.
      const rows = await prisma.$queryRawUnsafe<{ task_code: string; side: string }[]>(
        `SELECT c.task_code, c.side
           FROM signboard_column c
           JOIN phase_config_set s ON s.id = c.config_set_id
          WHERE s.is_active = true
            AND (s.project_key = $1 OR s.scope = 'GLOBAL')
          ORDER BY CASE WHEN s.project_key = $1 THEN 0 ELSE 1 END, c.display_order`,
        projectKey,
      );

      const out = new Map<string, WorkSide>();
      for (const r of rows) {
        if (!out.has(r.task_code)) {
          out.set(r.task_code, (WORK_SIDE as readonly string[]).includes(r.side) ? (r.side as WorkSide) : 'VN');
        }
      }
      return out;
    },

    async sideCalendar(calendarId): Promise<SideCalendar> {
      // KHÔNG truyền cache: API đọc lịch mỗi request để ngày lễ vừa import có
      // hiệu lực ngay. Query rất nhẹ (một lịch + vài chục ngày lễ).
      const calendar = await getCalendar(prisma, calendarId);
      const labels = await prisma.calendarHoliday.findMany({
        where: { calendarId },
        select: { holidayDate: true, label: true },
      });
      return {
        calendar,
        holidayLabels: new Map(
          labels.map((l) => [l.holidayDate.toISOString().slice(0, 10), l.label]),
        ),
      };
    },
  };
}
