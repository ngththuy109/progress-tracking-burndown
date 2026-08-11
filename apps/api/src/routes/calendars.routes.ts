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
  type Principal,
} from '@app/shared';
import { ApiError } from '../services/phase-config.service.js';
import type { DirtyEpicQueue } from '../services/phase-config.service.js';

/**
 * Nhóm API lịch làm việc & ngày nghỉ — T-36.
 *
 * Đây là đường NẠP DỮ LIỆU duy nhất của bảng `calendar_holiday`. Trước card này
 * bảng đó không có cách nào nhận dữ liệu (T-02/T-12 để lại "cho card vận hành
 * sau"), nên đường Kế hoạch cháy đều qua cả tuần nghỉ lễ — E-14 thành hiện thực.
 *
 * Đọc: mọi người đã đăng nhập (màn hình Ngày nghỉ và ô chọn lịch ở màn Epics).
 * Ghi: CHỈ ADMIN — ngày lễ ảnh hưởng đường Kế hoạch của MỌI Epic dùng lịch đó,
 * không phải thứ từng PM tự sửa theo dự án của mình.
 */

export interface CalendarStore {
  list(): Promise<readonly CalendarSummary[]>;
  exists(calendarId: string): Promise<boolean>;
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
  resolvePrincipal(req: FastifyRequest): Principal | null;
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

  const requirePrincipal = (req: FastifyRequest): Principal => {
    const p = deps.resolvePrincipal(req);
    if (!p) throw new ApiError(401, 'UNAUTHENTICATED', 'This request has no signed-in user. Reload the page to sign in again.');
    return p;
  };

  const requireAdmin = (req: FastifyRequest): Principal => {
    const p = requirePrincipal(req);
    if (p.role !== 'ADMIN') {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only Admins can edit the work calendar. Holidays and make-up workdays change the Planned line of every Epic using the calendar.',
      );
    }
    return p;
  };

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

  app.get('/api/calendars', async (req, reply) =>
    handle(reply, async (): Promise<ListCalendarsResponse> => {
      requirePrincipal(req);
      return { calendars: [...(await deps.store.list())] };
    }),
  );

  app.get('/api/calendars/:calendarId/holidays', async (req, reply) =>
    handle(reply, async (): Promise<ListHolidaysResponse> => {
      requirePrincipal(req);
      const calendarId = calendarIdParam(req);
      await assertCalendarExists(deps, calendarId);
      const year = yearQuery(req);
      return {
        calendarId,
        year,
        holidays: [...(await deps.store.holidays(calendarId, year))],
      };
    }),
  );

  app.post('/api/calendars/:calendarId/holidays/import', async (req, reply) =>
    handle(reply, async (): Promise<ImportHolidaysResponse> => {
      requireAdmin(req);
      const calendarId = calendarIdParam(req);
      await assertCalendarExists(deps, calendarId);

      const parsed = importHolidaysRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        // Trả lỗi TỪNG DÒNG và không ghi gì cả — người dán 50 ngày cần biết cả
        // 3 dòng sai ở đâu trong một lượt, không phải sửa một dòng rồi gửi lại.
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'The holiday list is not valid. Nothing was imported — fix the listed lines and send again.',
          parsed.error.issues.map((i) => ({
            level: 'ERROR' as const,
            code: 'SCHEMA_INVALID',
            message: i.message,
            path: i.path.join('.'),
          })),
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

  app.delete('/api/calendars/:calendarId/holidays/:date', async (req, reply) =>
    handle(reply, async (): Promise<DeleteHolidayResponse> => {
      requireAdmin(req);
      const calendarId = calendarIdParam(req);
      await assertCalendarExists(deps, calendarId);

      const date = (req.params as { date?: string }).date ?? '';
      if (!isDateOnly(date)) {
        throw new ApiError(400, 'BAD_REQUEST', `The date must look like YYYY-MM-DD, got "${date}".`);
      }

      const deleted = await deps.store.deleteHoliday(calendarId, date);
      // Xoá một ngày không tồn tại là no-op: không lan truyền, không báo lỗi —
      // hai người cùng xoá một dòng thì người bấm sau vẫn thấy kết quả đúng.
      const epicsMarkedForRecompute = deleted > 0 ? await propagateCalendarChange(calendarId) : 0;
      return { calendarId, deleted, epicsMarkedForRecompute };
    }),
  );

  // -------------------------------------------------------------------------
  // Ngày LÀM BÙ — cùng khuôn phân quyền/lan truyền với ngày lễ. Đổi lịch làm bù
  // cũng làm đường Kế hoạch đổi nên phải xoá cache biểu đồ + đánh dấu tính lại.
  // -------------------------------------------------------------------------

  app.get('/api/calendars/:calendarId/makeup-workdays', async (req, reply) =>
    handle(reply, async (): Promise<ListMakeupWorkdaysResponse> => {
      requirePrincipal(req);
      const calendarId = calendarIdParam(req);
      await assertCalendarExists(deps, calendarId);
      const year = yearQuery(req);
      return {
        calendarId,
        year,
        makeupWorkdays: [...(await deps.store.makeupWorkdays(calendarId, year))],
      };
    }),
  );

  app.post('/api/calendars/:calendarId/makeup-workdays/import', async (req, reply) =>
    handle(reply, async (): Promise<ImportMakeupWorkdaysResponse> => {
      requireAdmin(req);
      const calendarId = calendarIdParam(req);
      await assertCalendarExists(deps, calendarId);

      const parsed = importMakeupWorkdaysRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'The make-up workday list is not valid. Nothing was imported — fix the listed lines and send again.',
          parsed.error.issues.map((i) => ({
            level: 'ERROR' as const,
            code: 'SCHEMA_INVALID',
            message: i.message,
            path: i.path.join('.'),
          })),
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

  app.delete('/api/calendars/:calendarId/makeup-workdays/:date', async (req, reply) =>
    handle(reply, async (): Promise<DeleteMakeupWorkdayResponse> => {
      requireAdmin(req);
      const calendarId = calendarIdParam(req);
      await assertCalendarExists(deps, calendarId);

      const date = (req.params as { date?: string }).date ?? '';
      if (!isDateOnly(date)) {
        throw new ApiError(400, 'BAD_REQUEST', `The date must look like YYYY-MM-DD, got "${date}".`);
      }

      const deleted = await deps.store.deleteMakeupWorkday(calendarId, date);
      const epicsMarkedForRecompute = deleted > 0 ? await propagateCalendarChange(calendarId) : 0;
      return { calendarId, deleted, epicsMarkedForRecompute };
    }),
  );
}

async function assertCalendarExists(deps: CalendarRouteDeps, calendarId: string): Promise<void> {
  if (!(await deps.store.exists(calendarId))) {
    throw new ApiError(
      404,
      'CALENDAR_NOT_FOUND',
      `Calendar "${calendarId}" does not exist. Known calendars are listed at GET /api/calendars.`,
    );
  }
}

function calendarIdParam(req: FastifyRequest): string {
  const id = (req.params as { calendarId?: string }).calendarId?.trim();
  if (!id) throw new ApiError(400, 'BAD_REQUEST', 'The URL is missing the calendar id.');
  return id;
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
