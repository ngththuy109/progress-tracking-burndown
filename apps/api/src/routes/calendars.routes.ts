import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  importHolidaysRequestSchema,
  importMakeupWorkdaysRequestSchema,
  isDateOnly,
  type CalendarSummary,
  type DeleteHolidayResponse,
  type DeleteMakeupWorkdayResponse,
  type Holiday,
  type ImportHolidaysResponse,
  type ImportMakeupWorkdaysResponse,
  type ListCalendarsResponse,
  type ListHolidaysResponse,
  type ListMakeupWorkdaysResponse,
  type MakeupWorkday,
} from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import type { DirtyEpicQueue } from '../services/phase-config.service.js';
import { projectCtxOf, type AuthzGuard, type AuthzGuards } from '../adapters/project-scope.js';

/**
 * Nhóm API lịch làm việc, ngày nghỉ & ngày LÀM BÙ — T-36/T-39 — mount BA nơi
 * theo mô hình multi-tenant:
 *
 *   - `GET /api/calendars` (+ đọc holidays/makeup-workdays của lịch BUILT-IN):
 *     mọi người đã đăng nhập. Lịch built-in (`project_key IS NULL`, ví dụ
 *     VN_STANDARD/JP_STANDARD) dùng chung toàn hệ thống.
 *   - `/api/projects/:projectKey/calendars...`: lịch mà tenant đó nhìn thấy
 *     (built-in + lịch riêng của dự án). Đọc → VIEWER; GHI (import/xoá ngày lễ
 *     và ngày làm bù) → PM, và CHỈ trên lịch riêng của chính dự án — lịch
 *     built-in ảnh hưởng mọi tenant nên PM không sửa được (403).
 *   - `/api/admin/calendars/:calendarId/...`: ADMIN sửa lịch built-in (và mọi
 *     lịch khác khi cần cứu hộ).
 *
 * Lịch của dự án KHÁC bị đối xử như không tồn tại (404) — cùng luật chống dò
 * tenant với project/Epic.
 */

export interface CalendarStore {
  /**
   * Danh sách lịch kèm số ngày lễ/làm bù. `forProject`:
   *   null  → chỉ lịch built-in;
   *   'PAY' → built-in + lịch riêng của PAY.
   */
  list(forProject: string | null): Promise<readonly CalendarSummary[]>;
  /** Chủ của lịch: `{projectKey: null}` = built-in; `null` = lịch không tồn tại. */
  owner(calendarId: string): Promise<{ projectKey: string | null } | null>;
  holidays(calendarId: string, year: number | null): Promise<readonly Holiday[]>;
  importHolidays(args: {
    calendarId: string;
    mode: 'MERGE' | 'REPLACE_YEAR';
    year: number | null;
    holidays: readonly Holiday[];
  }): Promise<{ inserted: number; updated: number; deleted: number }>;
  deleteHoliday(calendarId: string, date: string): Promise<number>;
  makeupWorkdays(calendarId: string, year: number | null): Promise<readonly MakeupWorkday[]>;
  importMakeupWorkdays(args: {
    calendarId: string;
    mode: 'MERGE' | 'REPLACE_YEAR';
    year: number | null;
    makeupWorkdays: readonly MakeupWorkday[];
  }): Promise<{ inserted: number; updated: number; deleted: number }>;
  deleteMakeupWorkday(calendarId: string, date: string): Promise<number>;
  /** Epic đang dùng lịch — `all` để xoá cache biểu đồ, `active` để tính lại. */
  epicsUsing(calendarId: string): Promise<{ all: readonly string[]; active: readonly string[] }>;
}

export interface CalendarRouteDeps {
  readonly store: CalendarStore;
  /** Đánh dấu Epic cần tính lại — worker quét `dirty:epics` sẽ tự backfill. */
  readonly dirty: DirtyEpicQueue;
  /** Xoá cache biểu đồ của một Epic — số cũ tính bằng lịch cũ không dùng được nữa. */
  invalidateChart(epicKey: string): Promise<unknown>;
  readonly guards: AuthzGuards;
}

export function registerCalendarRoutes(app: FastifyInstance, deps: CalendarRouteDeps): void {
  const handle = async (reply: FastifyReply, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await reply.send(await fn());
    } catch (err) {
      if (err instanceof ApiError) {
        await reply.status(err.statusCode).send({
          error: err.code,
          message: err.message,
          ...(err.issues ? { issues: err.issues } : {}),
        });
        return;
      }
      app.log.error({ err }, 'Lỗi ngoài dự kiến ở nhóm API lịch làm việc');
      await reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error.' });
    }
  };

  const authed = { preHandler: deps.guards.requireAuthenticated };
  const admin = { preHandler: deps.guards.requireAdmin };
  const asViewer = { preHandler: deps.guards.requireProject('VIEWER') };
  const asPm = { preHandler: deps.guards.requireProject('PM') };

  /**
   * Lịch vừa đổi → số liệu suy ra từ lịch cũ phải bị vứt bỏ, ngay lập tức:
   * xoá cache biểu đồ của mọi Epic dùng lịch, và đánh dấu Epic ACTIVE để worker
   * tính lại. Thiếu bước này thì import xong biểu đồ vẫn sai tới hết TTL cache
   * và tới job đêm kế tiếp — người dùng sẽ tưởng chức năng import hỏng.
   */
  const propagateCalendarChange = async (calendarId: string): Promise<number> => {
    const epics = await deps.store.epicsUsing(calendarId);
    await Promise.all(epics.all.map((key) => deps.invalidateChart(key)));
    await deps.dirty.add([...epics.active]);
    return epics.active.length;
  };

  const calendarNotFound = (calendarId: string): ApiError =>
    new ApiError(
      404,
      'CALENDAR_NOT_FOUND',
      `Calendar "${calendarId}" does not exist. Known calendars are listed at GET /api/calendars.`,
    );

  /**
   * Quy tắc nhìn/sửa lịch theo phạm vi của route:
   *   - scope null (route built-in / admin): thấy mọi lịch tồn tại; route
   *     built-in tự siết thêm "chỉ built-in" qua `builtinOnly`.
   *   - scope 'PAY': thấy built-in + lịch của PAY; lịch dự án khác → 404.
   */
  const visibleOwner = async (
    calendarId: string,
    scope: string | null,
    builtinOnly: boolean,
  ): Promise<{ projectKey: string | null }> => {
    const owner = await deps.store.owner(calendarId);
    if (owner === null) throw calendarNotFound(calendarId);
    if (builtinOnly && owner.projectKey !== null) throw calendarNotFound(calendarId);
    if (scope !== null && owner.projectKey !== null && owner.projectKey !== scope) {
      // Lịch của tenant khác: trả đúng 404 như không tồn tại — không dò được.
      throw calendarNotFound(calendarId);
    }
    return owner;
  };

  // -------------------------------------------------------------------------
  // Đăng ký MỘT bộ endpoint đọc/ghi cho một phạm vi. Ngày lễ và ngày LÀM BÙ đi
  // cùng khuôn phân quyền/lan truyền — đổi bên nào cũng làm đường Kế hoạch đổi
  // nên đều phải xoá cache biểu đồ + đánh dấu tính lại.
  // -------------------------------------------------------------------------
  interface ScopeArgs {
    readonly prefix: string;
    /** Phạm vi tenant của request; null = không giới hạn theo tenant. */
    scopeOf(req: FastifyRequest): string | null;
    /** true = route chỉ nhìn thấy lịch built-in. */
    readonly builtinOnly: boolean;
    readonly read: { preHandler: AuthzGuard };
    /** Không có `write` = phạm vi đó không mở endpoint ghi. */
    readonly write?: {
      readonly opts: { preHandler: AuthzGuard };
      /** Kiểm quyền GHI trên lịch cụ thể (sau khi đã thấy được nó). */
      assertWritable(owner: { projectKey: string | null }, calendarId: string): void;
    };
  }

  const registerScope = ({ prefix, scopeOf, builtinOnly, read, write }: ScopeArgs): void => {
    app.get(`${prefix}/:calendarId/holidays`, read, async (req, reply) =>
      handle(reply, async (): Promise<ListHolidaysResponse> => {
        const calendarId = calendarIdParam(req);
        await visibleOwner(calendarId, scopeOf(req), builtinOnly);
        const year = yearQuery(req);
        return { calendarId, year, holidays: [...(await deps.store.holidays(calendarId, year))] };
      }),
    );

    app.get(`${prefix}/:calendarId/makeup-workdays`, read, async (req, reply) =>
      handle(reply, async (): Promise<ListMakeupWorkdaysResponse> => {
        const calendarId = calendarIdParam(req);
        await visibleOwner(calendarId, scopeOf(req), builtinOnly);
        const year = yearQuery(req);
        return {
          calendarId,
          year,
          makeupWorkdays: [...(await deps.store.makeupWorkdays(calendarId, year))],
        };
      }),
    );

    if (write === undefined) return;
    const { opts, assertWritable } = write;

    app.post(`${prefix}/:calendarId/holidays/import`, opts, async (req, reply) =>
      handle(reply, async (): Promise<ImportHolidaysResponse> => {
        const calendarId = calendarIdParam(req);
        assertWritable(await visibleOwner(calendarId, scopeOf(req), builtinOnly), calendarId);

        const parsed = importHolidaysRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          // Trả lỗi TỪNG DÒNG và không ghi gì cả — người dán 50 ngày cần biết cả
          // 3 dòng sai ở đâu trong một lượt, không phải sửa một dòng rồi gửi lại.
          throw importInvalid(
            'The holiday list is not valid. Nothing was imported — fix the listed lines and send again.',
            parsed.error,
          );
        }

        const result = await deps.store.importHolidays({
          calendarId,
          mode: parsed.data.mode,
          year: parsed.data.year,
          holidays: parsed.data.holidays,
        });
        const epicsMarkedForRecompute = await propagateCalendarChange(calendarId);
        return { calendarId, ...result, epicsMarkedForRecompute };
      }),
    );

    app.delete(`${prefix}/:calendarId/holidays/:date`, opts, async (req, reply) =>
      handle(reply, async (): Promise<DeleteHolidayResponse> => {
        const calendarId = calendarIdParam(req);
        assertWritable(await visibleOwner(calendarId, scopeOf(req), builtinOnly), calendarId);
        const date = dateParam(req);

        const deleted = await deps.store.deleteHoliday(calendarId, date);
        // Xoá một ngày không tồn tại là no-op: không lan truyền, không báo lỗi —
        // hai người cùng xoá một dòng thì người bấm sau vẫn thấy kết quả đúng.
        const epicsMarkedForRecompute = deleted > 0 ? await propagateCalendarChange(calendarId) : 0;
        return { calendarId, deleted, epicsMarkedForRecompute };
      }),
    );

    app.post(`${prefix}/:calendarId/makeup-workdays/import`, opts, async (req, reply) =>
      handle(reply, async (): Promise<ImportMakeupWorkdaysResponse> => {
        const calendarId = calendarIdParam(req);
        assertWritable(await visibleOwner(calendarId, scopeOf(req), builtinOnly), calendarId);

        const parsed = importMakeupWorkdaysRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          throw importInvalid(
            'The make-up workday list is not valid. Nothing was imported — fix the listed lines and send again.',
            parsed.error,
          );
        }

        const result = await deps.store.importMakeupWorkdays({
          calendarId,
          mode: parsed.data.mode,
          year: parsed.data.year,
          makeupWorkdays: parsed.data.makeupWorkdays,
        });
        const epicsMarkedForRecompute = await propagateCalendarChange(calendarId);
        return { calendarId, ...result, epicsMarkedForRecompute };
      }),
    );

    app.delete(`${prefix}/:calendarId/makeup-workdays/:date`, opts, async (req, reply) =>
      handle(reply, async (): Promise<DeleteMakeupWorkdayResponse> => {
        const calendarId = calendarIdParam(req);
        assertWritable(await visibleOwner(calendarId, scopeOf(req), builtinOnly), calendarId);
        const date = dateParam(req);

        const deleted = await deps.store.deleteMakeupWorkday(calendarId, date);
        const epicsMarkedForRecompute = deleted > 0 ? await propagateCalendarChange(calendarId) : 0;
        return { calendarId, deleted, epicsMarkedForRecompute };
      }),
    );
  };

  // ---- Danh sách lịch ------------------------------------------------------

  // Built-in cho mọi người đã đăng nhập (ô chọn lịch, màn hình Ngày nghỉ).
  app.get('/api/calendars', authed, async (_req, reply) =>
    handle(reply, async (): Promise<ListCalendarsResponse> => ({
      calendars: [...(await deps.store.list(null))],
    })),
  );

  // Built-in + lịch riêng của tenant — cho các màn hình trong một dự án.
  app.get('/api/projects/:projectKey/calendars', asViewer, async (req, reply) =>
    handle(reply, async (): Promise<ListCalendarsResponse> => ({
      calendars: [...(await deps.store.list(projectCtxOf(req).projectKey))],
    })),
  );

  // ---- Đọc lịch built-in (mọi người đã đăng nhập) --------------------------
  registerScope({
    prefix: '/api/calendars',
    scopeOf: () => null,
    builtinOnly: true,
    read: authed,
    // Không có write: sửa built-in đi qua /api/admin/calendars.
  });

  // ---- Lịch trong một dự án ------------------------------------------------
  registerScope({
    prefix: '/api/projects/:projectKey/calendars',
    scopeOf: (req) => projectCtxOf(req).projectKey,
    builtinOnly: false,
    read: asViewer,
    write: {
      opts: asPm,
      assertWritable: (owner, calendarId) => {
        if (owner.projectKey === null) {
          // PM thấy được lịch built-in nhưng KHÔNG sửa được: ngày lễ/làm bù của
          // nó đổi đường Kế hoạch của MỌI tenant đang dùng chung.
          throw new ApiError(
            403,
            'FORBIDDEN',
            `Calendar "${calendarId}" is a built-in shared calendar. Only Admins can edit it — ` +
              'its holidays and make-up workdays change the Planned line of every project using it.',
          );
        }
      },
    },
  });

  // ---- Quản trị (ADMIN) ----------------------------------------------------
  registerScope({
    prefix: '/api/admin/calendars',
    scopeOf: () => null,
    builtinOnly: false,
    read: admin,
    write: { opts: admin, assertWritable: () => undefined },
  });
}

function importInvalid(
  message: string,
  error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> },
): ApiError {
  return new ApiError(
    400,
    'BAD_REQUEST',
    message,
    error.issues.map((i) => ({
      level: 'ERROR' as const,
      code: 'SCHEMA_INVALID',
      message: i.message,
      path: i.path.join('.'),
    })),
  );
}

function calendarIdParam(req: FastifyRequest): string {
  const id = (req.params as { calendarId?: string }).calendarId?.trim();
  if (!id) throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the calendar id.');
  return id;
}

function dateParam(req: FastifyRequest): string {
  const date = (req.params as { date?: string }).date ?? '';
  if (!isDateOnly(date)) {
    throw new ApiError(400, 'BAD_REQUEST', `The date must look like YYYY-MM-DD, got "${date}".`);
  }
  return date;
}

/** `?year=` tuỳ chọn; sai định dạng báo ngay chứ không im lặng bỏ lọc. */
function yearQuery(req: FastifyRequest): number | null {
  const raw = (req.query as Record<string, unknown>)['year'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ApiError(400, 'BAD_REQUEST', `Parameter "year" must be a year like 2026, got "${raw}".`);
  }
  return year;
}
