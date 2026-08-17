import type { PrismaClient } from '@app/db';
import {
  deleteExemption,
  listExemptionsForEpics,
  listVisibleActiveEpics,
  upsertExemption,
} from '@app/db';
import {
  DEFAULT_HOURS_PER_DAY,
  DEFAULT_WORKDAYS_MASK,
  UNCLASSIFIED_PHASE,
  workdaysMaskWarning,
  type StatusCategory,
  type WorkCalendar,
} from '@app/shared';
import type { LogworkReadPort, LogworkWritePort, VisibleEpic } from '../routes/logwork.routes.js';
import type {
  LoadedLogworkSubtask,
  LogworkParticipant,
  WorklogSumRow,
} from '../services/logwork.service.js';

/**
 * Nối cổng "Log work" vào Prisma — file DUY NHẤT của nhóm này biết Prisma.
 *
 * Đọc-only từ Postgres. Truy vấn theo TẬP Epic (không N+1): một truy vấn Sub-task,
 * một `groupBy` worklog cho mỗi múi giờ, một truy vấn exemption.
 */

const n = (v: bigint | number | null): number => (v === null ? 0 : Number(v));

function toCategory(raw: string): StatusCategory {
  return raw === 'done' || raw === 'indeterminate' ? raw : 'new';
}

/**
 * Chuẩn hoá cột JSONB `sb_request_participants` thành participant — đọc PHÒNG THỦ
 * (cột do worker ghi nhưng có thể null / dữ liệu cũ). Bỏ phần tử thiếu `accountId`;
 * `displayName` không phải chuỗi coi như `null` (chưa tra được tên).
 * Sao lại từ `signboard.adapters.ts` `toPics` — repo chấp nhận trùng nhỏ kiểu này.
 */
function toParticipants(raw: unknown): LogworkParticipant[] {
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
  const out: LogworkParticipant[] = [];
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

export function createLogworkReadPort(prisma: PrismaClient): LogworkReadPort {
  return {
    async visibleEpics(projectKeys): Promise<readonly VisibleEpic[]> {
      const epics = await listVisibleActiveEpics(prisma, projectKeys);
      if (epics.length === 0) return [];

      const projectKeysDistinct = [...new Set(epics.map((e) => e.projectKey))];
      const projects = await prisma.project.findMany({
        where: { projectKey: { in: projectKeysDistinct } },
        select: { projectKey: true, expectedHoursPerDay: true },
      });
      const hoursByProject = new Map<string, number | null>(
        projects.map((p) => [p.projectKey, p.expectedHoursPerDay]),
      );

      return epics.map((e) => ({
        epicKey: e.epicKey,
        projectKey: e.projectKey,
        calendarId: e.calendarId,
        expectedHoursPerDay: hoursByProject.get(e.projectKey) ?? null,
      }));
    },

    async calendars(calendarIds): Promise<ReadonlyMap<string, WorkCalendar>> {
      const map = new Map<string, WorkCalendar>();
      const ids = [...calendarIds];
      if (ids.length === 0) return map;

      const [cals, holidays, makeups] = await Promise.all([
        prisma.workCalendar.findMany({
          where: { calendarId: { in: ids } },
          select: { calendarId: true, timezone: true, workdaysMask: true, hoursPerDay: true },
        }),
        prisma.calendarHoliday.findMany({
          where: { calendarId: { in: ids } },
          select: { calendarId: true, holidayDate: true },
        }),
        prisma.calendarMakeupWorkday.findMany({
          where: { calendarId: { in: ids } },
          select: { calendarId: true, workDate: true },
        }),
      ]);

      const holidaysByCal = new Map<string, Set<string>>();
      for (const h of holidays) {
        const iso = h.holidayDate.toISOString().slice(0, 10);
        const set = holidaysByCal.get(h.calendarId) ?? new Set<string>();
        set.add(iso);
        holidaysByCal.set(h.calendarId, set);
      }
      const makeupByCal = new Map<string, Set<string>>();
      for (const m of makeups) {
        const iso = m.workDate.toISOString().slice(0, 10);
        const set = makeupByCal.get(m.calendarId) ?? new Set<string>();
        set.add(iso);
        makeupByCal.set(m.calendarId, set);
      }

      const found = new Map(cals.map((c) => [c.calendarId, c]));
      for (const id of ids) {
        const c = found.get(id);
        const warnings: string[] = [];
        if (c === undefined) {
          // Lịch không tồn tại → mặc định + NÓI RA (giống burndown epicMeta): sai
          // lịch làm lệch số ngày công mà nhìn số vẫn thấy hợp lý.
          warnings.push(
            `Work calendar "${id}" does not exist; capacity falls back to Mon–Fri, Asia/Tokyo, no holidays. ` +
              'Pick a real calendar for the Epic on the Epics screen.',
          );
          map.set(id, {
            calendarId: id,
            timezone: 'Asia/Tokyo',
            workdaysMask: DEFAULT_WORKDAYS_MASK,
            hoursPerDay: DEFAULT_HOURS_PER_DAY,
            holidays: new Set(),
            makeupWorkdays: new Set(),
            warnings,
          });
          continue;
        }
        const hol = holidaysByCal.get(id) ?? new Set<string>();
        if (hol.size === 0) {
          warnings.push(
            `No holiday is registered on work calendar "${id}", so capacity treats holiday weeks as working days. ` +
              'An Admin can import them on the Days off screen.',
          );
        }
        const maskWarning = workdaysMaskWarning(c.workdaysMask);
        if (maskWarning !== null) warnings.push(maskWarning);

        map.set(id, {
          calendarId: id,
          timezone: c.timezone,
          workdaysMask: c.workdaysMask,
          hoursPerDay: Number(c.hoursPerDay),
          holidays: hol,
          makeupWorkdays: makeupByCal.get(id) ?? new Set(),
          warnings,
        });
      }
      return map;
    },

    async openSubtasks(epicKeys): Promise<readonly LoadedLogworkSubtask[]> {
      if (epicKeys.length === 0) return [];
      const rows = await prisma.jiraIssue.findMany({
        where: {
          epicKey: { in: [...epicKeys] },
          issueType: 'SUBTASK',
          removedAt: null,
          statusCategory: { not: 'done' },
        },
        select: {
          issueKey: true,
          epicKey: true,
          summary: true,
          parentKey: true,
          phaseCode: true,
          statusCategory: true,
          originalEstimateS: true,
          sbRequestParticipants: true,
        },
      });
      return rows.map((r) => ({
        issueKey: r.issueKey,
        epicKey: r.epicKey ?? '',
        summary: r.summary,
        parentKey: r.parentKey,
        phaseCode: r.phaseCode ?? UNCLASSIFIED_PHASE,
        statusCategory: toCategory(r.statusCategory),
        originalEstimateSeconds: n(r.originalEstimateS),
        participants: toParticipants(r.sbRequestParticipants),
      }));
    },

    async worklogSums(epicKeys, startMs, endMs): Promise<readonly WorklogSumRow[]> {
      if (epicKeys.length === 0) return [];
      const groups = await prisma.worklogEntry.groupBy({
        by: ['issueKey', 'authorId'],
        where: {
          epicKey: { in: [...epicKeys] },
          isDeleted: false,
          startedAt: { gte: new Date(startMs), lte: new Date(endMs) },
        },
        _sum: { timeSpentS: true },
      });
      return groups.map((g) => ({
        issueKey: g.issueKey,
        authorId: g.authorId,
        seconds: n(g._sum.timeSpentS),
      }));
    },

    exemptionsForEpics(epicKeys) {
      return listExemptionsForEpics(prisma, epicKeys);
    },

    async projectHours(projectKeys): Promise<ReadonlyMap<string, number | null>> {
      const map = new Map<string, number | null>();
      if (projectKeys.length === 0) return map;
      const rows = await prisma.project.findMany({
        where: { projectKey: { in: [...projectKeys] } },
        select: { projectKey: true, expectedHoursPerDay: true },
      });
      for (const r of rows) map.set(r.projectKey, r.expectedHoursPerDay);
      return map;
    },
  };
}

/** Cổng GHI của màn Log work — exemption (verify) + cấu hình giờ/ngày theo project. */
export function createLogworkWritePort(prisma: PrismaClient): LogworkWritePort {
  return {
    async issueEpicProject(issueKey) {
      const issue = await prisma.jiraIssue.findUnique({
        where: { issueKey },
        select: { epicKey: true },
      });
      if (!issue || issue.epicKey === null) return null;
      const epic = await prisma.trackedEpic.findUnique({
        where: { epicKey: issue.epicKey },
        select: { projectKey: true },
      });
      if (!epic) return null;
      return { epicKey: issue.epicKey, projectKey: epic.projectKey };
    },

    upsertExemption: (args) => upsertExemption(prisma, args),
    deleteExemption: (accountId, issueKey) => deleteExemption(prisma, accountId, issueKey),

    async setProjectHours(projectKey, expectedHoursPerDay) {
      // Project trong danh mục PM phụ trách luôn có sẵn dòng; upsert cho chắc.
      await prisma.project.upsert({
        where: { projectKey },
        create: { projectKey, expectedHoursPerDay },
        update: { expectedHoursPerDay },
      });
    },
  };
}
