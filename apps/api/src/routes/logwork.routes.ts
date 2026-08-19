import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  DateOnly,
  LogworkResponse,
  LogworkSettingsResponse,
  Principal,
  WorkCalendar,
} from '@app/shared';
import {
  DEFAULT_HOURS_PER_DAY,
  logworkExemptionRequestSchema,
  logworkSetHoursRequestSchema,
} from '@app/shared';
import {
  countWorkdays,
  endOfDayUtcMs,
  localDateOf,
  startOfDayUtcMs,
  weekOf,
} from '@app/engine';
import { ApiError } from '../services/phase-config.service.js';
import {
  buildLogworkReport,
  type EpicCapacity,
  type LoadedLogworkSubtask,
  type LogworkExemptionRow,
  type WorklogSumRow,
} from '../services/logwork.service.js';

/**
 * Endpoint theo dõi LOG WORK — TOÀN ĐỘI (mọi Epic người xem được phép thấy).
 *
 * Tầng này CHỈ điều phối: đọc tham số, kiểm quyền, tính sẵn số ngày công + giờ
 * kỳ vọng (prorate theo múi giờ từng Epic), gọi cổng đọc, gọi hàm thuần. Không
 * một dòng logic gom nhóm nào ở đây — nó nằm ở `logwork.service`.
 *
 * Đọc-only từ Postgres: KHÔNG gọi Jira. "Sang Jira log" là deep-link ở web.
 */

/** Khi không thấy Epic nào (PM chưa được gán) — vẫn cần một múi giờ để dựng tuần mặc định. */
const FALLBACK_TIMEZONE = 'Asia/Ho_Chi_Minh';
/** Chặn quét worklog cả năm do nhập khoảng vô lý. */
const MAX_RANGE_DAYS = 366;

/** Một Epic thấy được, kèm dữ liệu cần để tính capacity. */
export interface VisibleEpic {
  readonly epicKey: string;
  readonly projectKey: string;
  readonly calendarId: string;
  /** Giờ/ngày cấu hình riêng cho project; `null` → dùng giờ/ngày của lịch rồi tới mặc định. */
  readonly expectedHoursPerDay: number | null;
}

export interface LogworkReadPort {
  /** Epic ACTIVE người xem được phép thấy. `projectKeys=null` (ADMIN/VIEWER) = tất cả. */
  visibleEpics(projectKeys: readonly string[] | null): Promise<readonly VisibleEpic[]>;
  /** Dựng `WorkCalendar` cho từng `calendarId` — LUÔN trả đủ (thiếu lịch → mặc định + cảnh báo). */
  calendars(calendarIds: readonly string[]): Promise<ReadonlyMap<string, WorkCalendar>>;
  /** MỘT truy vấn: mọi Sub-task đang mở của các Epic, kèm participant. */
  openSubtasks(epicKeys: readonly string[]): Promise<readonly LoadedLogworkSubtask[]>;
  /** Tổng giây log theo (issue, tác giả) trong cửa sổ `[startMs, endMs]`, cho các Epic đã cho. */
  worklogSums(
    epicKeys: readonly string[],
    startMs: number,
    endMs: number,
  ): Promise<readonly WorklogSumRow[]>;
  /** Các bản "PM đã verify — thôi theo dõi" của những Epic đã cho. */
  exemptionsForEpics(epicKeys: readonly string[]): Promise<readonly LogworkExemptionRow[]>;
  /** Giờ/ngày cấu hình RIÊNG của từng project (`null` = chưa cấu hình). */
  projectHours(projectKeys: readonly string[]): Promise<ReadonlyMap<string, number | null>>;
}

export interface LogworkWritePort {
  /** Từ `issueKey` suy ra Epic + project — SERVER tự tra, KHÔNG tin client (kiểm quyền). */
  issueEpicProject(issueKey: string): Promise<{ epicKey: string; projectKey: string } | null>;
  upsertExemption(args: {
    accountId: string;
    issueKey: string;
    epicKey: string;
    projectKey: string;
    exemptedBy: string;
    note: string | null;
  }): Promise<void>;
  deleteExemption(accountId: string, issueKey: string): Promise<void>;
  setProjectHours(projectKey: string, expectedHoursPerDay: number | null): Promise<void>;
}

export interface LogworkRouteDeps {
  readonly reads: LogworkReadPort;
  readonly writes: LogworkWritePort;
  resolvePrincipal(req: FastifyRequest): Principal | null;
  /** Đồng hồ đi qua cổng để test đóng băng được — "kỳ này" phụ thuộc hôm nay. */
  now(): Date;
}

export function registerLogworkRoutes(app: FastifyInstance, deps: LogworkRouteDeps): void {
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await reply.send(await fn());
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({ error: err.code, message: err.message });
        return;
      }
      app.log.error({ err }, 'Unexpected error in the Log work API');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const requirePrincipal = (req: FastifyRequest): Principal => {
    const p = deps.resolvePrincipal(req);
    if (!p) {
      throw new ApiError(
        401,
        'UNAUTHENTICATED',
        'This request has no signed-in user. Reload the page to sign in again.',
      );
    }
    return p;
  };

  app.get('/api/logwork', async (req, reply) =>
    handle(reply, async (): Promise<LogworkResponse> => {
      const principal = requirePrincipal(req);

      // PM chỉ thấy project mình phụ trách; ADMIN/VIEWER thấy tất cả.
      const projectKeys = principal.role === 'PM' ? principal.projects : null;
      const epics = await deps.reads.visibleEpics(projectKeys);

      // Không Epic nào (PM chưa được gán project có Epic) → báo cáo rỗng, vẫn hợp lệ.
      if (epics.length === 0) {
        const { from, to } = resolvePeriod(req, FALLBACK_TIMEZONE, deps.now());
        const today = localDateOf(deps.now().getTime(), FALLBACK_TIMEZONE);
        return emptyReport(from, to, to >= today);
      }

      const calendarIds = [...new Set(epics.map((e) => e.calendarId))];
      const calendars = await deps.reads.calendars(calendarIds);
      const calOf = (e: VisibleEpic): WorkCalendar => calendars.get(e.calendarId) ?? fallbackCalendar(e.calendarId);

      const refTz = mostCommonTimezone(epics, calOf);
      const { from, to } = resolvePeriod(req, refTz, deps.now());

      // Tính sẵn cho từng Epic: số ngày công (prorate theo múi giờ Epic) + giờ/ngày.
      const nowMs = deps.now().getTime();
      const perEpic: Record<string, EpicCapacity> = {};
      const warnings = new Set<string>();
      let partialPeriod = false;
      for (const e of epics) {
        const cal = calOf(e);
        const today = localDateOf(nowMs, cal.timezone);
        // Kỳ đang diễn ra: chỉ tính tới hôm nay (min(to, today)) để giữa tuần
        // không phải ai cũng "behind".
        const capTo = to < today ? to : today;
        const effectiveWorkdays = capTo < from ? 0 : countWorkdays(from, capTo, cal);
        if (to >= today) partialPeriod = true;
        perEpic[e.epicKey] = {
          projectKey: e.projectKey,
          effectiveWorkdays,
          hoursPerDay: e.expectedHoursPerDay ?? cal.hoursPerDay ?? DEFAULT_HOURS_PER_DAY,
        };
        for (const w of cal.warnings) warnings.add(w);
      }

      const epicKeys = epics.map((e) => e.epicKey);

      // Cửa sổ worklog tính theo múi giờ TỪNG Epic: gom Epic theo múi giờ, mỗi
      // nhóm một truy vấn (issue key toàn cục là duy nhất nên ghép không đụng nhau).
      const byTz = new Map<string, string[]>();
      for (const e of epics) {
        const tz = calOf(e).timezone;
        const list = byTz.get(tz);
        if (list) list.push(e.epicKey);
        else byTz.set(tz, [e.epicKey]);
      }
      const worklogSums: WorklogSumRow[] = [];
      for (const [tz, keys] of byTz) {
        const rows = await deps.reads.worklogSums(keys, startOfDayUtcMs(from, tz), endOfDayUtcMs(to, tz));
        worklogSums.push(...rows);
      }

      const [subtasks, exemptions] = await Promise.all([
        deps.reads.openSubtasks(epicKeys),
        deps.reads.exemptionsForEpics(epicKeys),
      ]);

      return buildLogworkReport({
        from,
        to,
        perEpic,
        partialPeriod,
        visibleEpicCount: epics.length,
        warnings: [...warnings],
        includeUnassignedAuthors: true,
        subtasks,
        worklogSums,
        exemptions,
      });
    }),
  );

  // ---- Cấu hình giờ/ngày kỳ vọng theo project ----

  app.get('/api/logwork/settings', async (req, reply) =>
    handle(reply, async (): Promise<LogworkSettingsResponse> => {
      const principal = requirePrincipal(req);
      const projectKeys = principal.role === 'PM' ? principal.projects : null;
      const epics = await deps.reads.visibleEpics(projectKeys);
      const distinct = [...new Set(epics.map((e) => e.projectKey))].sort();
      const hours = await deps.reads.projectHours(distinct);
      return {
        defaultHoursPerDay: DEFAULT_HOURS_PER_DAY,
        projects: distinct.map((projectKey) => ({
          projectKey,
          expectedHoursPerDay: hours.get(projectKey) ?? null,
          canEdit: canEditProject(principal, projectKey),
        })),
      };
    }),
  );

  app.put('/api/logwork/settings/:projectKey', async (req, reply) =>
    handle(reply, async () => {
      const principal = requirePrincipal(req);
      const projectKey = paramProjectKey(req);
      assertCanVerify(principal, projectKey);
      const parsed = logworkSetHoursRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'expectedHoursPerDay must be a number greater than 0 and at most 24, or null to reset to the calendar default.',
        );
      }
      await deps.writes.setProjectHours(projectKey, parsed.data.expectedHoursPerDay);
      return { ok: true };
    }),
  );

  // ---- PM "verify — thôi theo dõi" một cặp (member, ticket) ----

  app.post('/api/logwork/exemptions', async (req, reply) =>
    handle(reply, async () => {
      const principal = requirePrincipal(req);
      const parsed = logworkExemptionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, 'BAD_REQUEST', 'A verify request needs a non-empty accountId and issueKey.');
      }
      // SERVER tự tra project của ticket — không tin client gửi projectKey.
      const loc = await deps.writes.issueEpicProject(parsed.data.issueKey);
      if (loc === null) {
        throw new ApiError(404, 'ISSUE_NOT_FOUND', `Ticket ${parsed.data.issueKey} is not tracked.`);
      }
      assertCanVerify(principal, loc.projectKey);
      await deps.writes.upsertExemption({
        accountId: parsed.data.accountId,
        issueKey: parsed.data.issueKey,
        epicKey: loc.epicKey,
        projectKey: loc.projectKey,
        exemptedBy: principal.userId,
        note: parsed.data.note ?? null,
      });
      return { ok: true };
    }),
  );

  app.delete('/api/logwork/exemptions', async (req, reply) =>
    handle(reply, async () => {
      const principal = requirePrincipal(req);
      const accountId = strQuery(req, 'accountId');
      const issueKey = strQuery(req, 'issueKey');
      const loc = await deps.writes.issueEpicProject(issueKey);
      if (loc === null) {
        throw new ApiError(404, 'ISSUE_NOT_FOUND', `Ticket ${issueKey} is not tracked.`);
      }
      assertCanVerify(principal, loc.projectKey);
      await deps.writes.deleteExemption(accountId, issueKey);
      return { ok: true };
    }),
  );
}

/** ADMIN sửa mọi project; PM chỉ project mình phụ trách; VIEWER không. */
function canEditProject(principal: Principal, projectKey: string): boolean {
  return principal.role === 'ADMIN' || (principal.role === 'PM' && principal.projects.includes(projectKey));
}

function assertCanVerify(principal: Principal, projectKey: string): void {
  if (canEditProject(principal, projectKey)) return;
  throw new ApiError(
    403,
    'FORBIDDEN',
    `You can only change log-work settings for your own projects. ${projectKey} is not one of them.`,
  );
}

function paramProjectKey(req: FastifyRequest): string {
  const key = (req.params as { projectKey?: string }).projectKey?.trim();
  if (key === undefined || key === '') {
    throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the project key.');
  }
  return key;
}

function strQuery(req: FastifyRequest, name: string): string {
  const raw = (req.query as Record<string, unknown>)[name];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'BAD_REQUEST', `Query parameter "${name}" is required.`);
  }
  return raw.trim();
}

/** `?from=`/`?to=` cùng có hoặc cùng vắng (vắng → tuần chứa hôm nay ở `refTz`). */
function resolvePeriod(req: FastifyRequest, refTz: string, now: Date): { from: DateOnly; to: DateOnly } {
  const rawFrom = dateQuery(req, 'from');
  const rawTo = dateQuery(req, 'to');

  let from: DateOnly;
  let to: DateOnly;
  if (rawFrom === null && rawTo === null) {
    const wk = weekOf(localDateOf(now.getTime(), refTz));
    from = wk.from;
    to = wk.to;
  } else if (rawFrom !== null && rawTo !== null) {
    from = rawFrom;
    to = rawTo;
  } else {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Provide both "from" and "to", or neither (which defaults to the current week).',
    );
  }

  // So chuỗi 'YYYY-MM-DD' là hợp lệ cho thứ tự ngày.
  if (to < from) {
    throw new ApiError(400, 'BAD_REQUEST', `The "to" date (${to}) must be on or after "from" (${from}).`);
  }
  const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  if (spanDays > MAX_RANGE_DAYS) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `The range ${from} → ${to} spans more than ${MAX_RANGE_DAYS} days; pick a shorter window.`,
    );
  }
  return { from, to };
}

/** `?from=` và `?to=` là tuỳ chọn; sai định dạng phải báo ngay, không im lặng bỏ qua. */
function dateQuery(req: FastifyRequest, name: 'from' | 'to'): DateOnly | null {
  const raw = (req.query as Record<string, unknown>)[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, 'BAD_REQUEST', `Parameter "${name}" must look like YYYY-MM-DD, got "${value}".`);
  }
  return value;
}

/** Múi giờ phổ biến nhất trong các Epic thấy được; hoà thì lấy theo thứ tự chữ cái. */
function mostCommonTimezone(epics: readonly VisibleEpic[], calOf: (e: VisibleEpic) => WorkCalendar): string {
  const counts = new Map<string, number>();
  for (const e of epics) {
    const tz = calOf(e).timezone;
    counts.set(tz, (counts.get(tz) ?? 0) + 1);
  }
  let best = FALLBACK_TIMEZONE;
  let bestCount = -1;
  for (const [tz, count] of counts) {
    if (count > bestCount || (count === bestCount && tz < best)) {
      best = tz;
      bestCount = count;
    }
  }
  return best;
}

function fallbackCalendar(calendarId: string): WorkCalendar {
  return {
    calendarId,
    timezone: 'Asia/Tokyo',
    workdaysMask: 31,
    hoursPerDay: DEFAULT_HOURS_PER_DAY,
    holidays: new Set(),
    makeupWorkdays: new Set(),
    warnings: [],
  };
}

function emptyReport(from: DateOnly, to: DateOnly, partialPeriod: boolean): LogworkResponse {
  return {
    from,
    to,
    members: [],
    totalMembers: 0,
    totalNotLogged: 0,
    visibleEpicCount: 0,
    hasParticipantData: false,
    partialPeriod,
    warnings: [],
  };
}
