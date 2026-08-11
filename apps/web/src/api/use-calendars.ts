import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  deleteHolidayResponseSchema,
  deleteMakeupWorkdayResponseSchema,
  importHolidaysResponseSchema,
  importMakeupWorkdaysResponseSchema,
  listCalendarsResponseSchema,
  listHolidaysResponseSchema,
  listMakeupWorkdaysResponseSchema,
  SIDE_CALENDAR_ID,
  type DeleteHolidayResponse,
  type DeleteMakeupWorkdayResponse,
  type ImportHolidaysRequest,
  type ImportHolidaysResponse,
  type ImportMakeupWorkdaysRequest,
  type ImportMakeupWorkdaysResponse,
  type ListCalendarsResponse,
  type ListHolidaysResponse,
  type ListMakeupWorkdaysResponse,
} from '@app/shared';
import { useProjectKey } from '../project/project-context.js';
import { apiClient, projectApiPath, type ApiClient } from './client.js';

/**
 * Hook của màn hình "Ngày nghỉ" (T-36) và ô chọn lịch ở màn Epics — bản
 * multi-tenant.
 *
 * ĐỌC: mọi lịch dự án dùng được (kể cả lịch built-in VN/JP) đi qua
 * `/api/projects/:projectKey/calendars...`.
 * GHI: lịch BUILT-IN (VN_STANDARD/JP_STANDARD) chỉ ADMIN sửa được, qua
 * `/api/admin/calendars/...`; lịch riêng của dự án sửa qua đường dự án (PM).
 *
 * Sau khi sửa ngày lễ phải làm mới CẢ hai nhóm dữ liệu suy ra từ lịch:
 * biểu đồ Burndown (server đã xoá cache phía nó, client cũng phải quên bản đã
 * tải) và báo cáo plan-conflicts. Thiếu bước này thì import xong màn hình vẫn
 * hiện số cũ tới lần F5 kế tiếp — trông y hệt "chức năng hỏng".
 */

/** Lịch built-in dùng chung — sửa ở khu quản trị, không sửa theo dự án. */
export const BUILTIN_CALENDAR_IDS: ReadonlySet<string> = new Set(Object.values(SIDE_CALENDAR_ID));

export function isBuiltinCalendar(calendarId: string): boolean {
  return BUILTIN_CALENDAR_IDS.has(calendarId);
}

/** Đường ghi của một lịch: built-in → khu admin; lịch dự án → theo dự án. */
function calendarWritePath(projectKey: string, calendarId: string, suffix: string): string {
  return isBuiltinCalendar(calendarId)
    ? `/admin/calendars/${encodeURIComponent(calendarId)}${suffix}`
    : projectApiPath(projectKey, `/calendars/${encodeURIComponent(calendarId)}${suffix}`);
}

export const calendarKeys = {
  all: (projectKey: string) => [projectKey, 'calendars'] as const,
  list: (projectKey: string) => [projectKey, 'calendars', 'list'] as const,
  holidays: (projectKey: string, calendarId: string, year: number | null) =>
    [projectKey, 'calendars', calendarId, 'holidays', year ?? 'all'] as const,
  makeupWorkdays: (projectKey: string, calendarId: string, year: number | null) =>
    [projectKey, 'calendars', calendarId, 'makeup-workdays', year ?? 'all'] as const,
};

/** Các lịch dự án dùng được — nguồn cho ô chọn lịch và màn "Ngày nghỉ". */
export function useCalendars(
  client: ApiClient = apiClient,
): UseQueryResult<ListCalendarsResponse, Error> {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: calendarKeys.list(projectKey),
    queryFn: ({ signal }) =>
      client.get(projectApiPath(projectKey, '/calendars'), listCalendarsResponseSchema, { signal }),
  });
}

/**
 * Danh sách lịch BUILT-IN (`GET /api/calendars`) — dùng ở khu quản trị, nơi
 * không có ngữ cảnh dự án (ví dụ ô `defaultCalendarId` của form Project).
 */
export function useBuiltinCalendars(
  client: ApiClient = apiClient,
): UseQueryResult<ListCalendarsResponse, Error> {
  return useQuery({
    queryKey: ['admin', 'calendars', 'builtin'] as const,
    queryFn: ({ signal }) => client.get('/calendars', listCalendarsResponseSchema, { signal }),
  });
}

export function useHolidays(
  calendarId: string | null,
  year: number | null,
  client: ApiClient = apiClient,
): UseQueryResult<ListHolidaysResponse, Error> {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: calendarKeys.holidays(projectKey, calendarId ?? '', year),
    enabled: calendarId !== null && calendarId !== '',
    queryFn: ({ signal }) =>
      client.get(
        projectApiPath(projectKey, `/calendars/${calendarId ?? ''}/holidays`),
        listHolidaysResponseSchema,
        { signal, query: { year } },
      ),
  });
}

function useInvalidateCalendarData(projectKey: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: calendarKeys.all(projectKey) });
    void queryClient.invalidateQueries({ queryKey: [projectKey, 'plan-conflicts'] });
    // Đường Kế hoạch vẽ từ lịch — mọi biểu đồ đã tải đều nghi ngờ là cũ.
    void queryClient.invalidateQueries({ queryKey: [projectKey, 'burndown'] });
  };
}

export interface ImportHolidaysVars {
  readonly calendarId: string;
  readonly body: ImportHolidaysRequest;
}

export function useImportHolidays(
  client: ApiClient = apiClient,
): UseMutationResult<ImportHolidaysResponse, Error, ImportHolidaysVars> {
  const projectKey = useProjectKey();
  const invalidate = useInvalidateCalendarData(projectKey);
  return useMutation({
    mutationFn: (vars: ImportHolidaysVars) =>
      client.post(
        calendarWritePath(projectKey, vars.calendarId, '/holidays/import'),
        vars.body,
        importHolidaysResponseSchema,
      ),
    onSuccess: invalidate,
  });
}

export interface DeleteHolidayVars {
  readonly calendarId: string;
  readonly date: string;
}

export function useDeleteHoliday(
  client: ApiClient = apiClient,
): UseMutationResult<DeleteHolidayResponse, Error, DeleteHolidayVars> {
  const projectKey = useProjectKey();
  const invalidate = useInvalidateCalendarData(projectKey);
  return useMutation({
    mutationFn: (vars: DeleteHolidayVars) =>
      client.delete(
        calendarWritePath(projectKey, vars.calendarId, `/holidays/${vars.date}`),
        deleteHolidayResponseSchema,
      ),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Ngày làm bù — cùng khuôn hook với ngày lễ, cùng làm mới biểu đồ/plan-conflicts.
// ---------------------------------------------------------------------------

export function useMakeupWorkdays(
  calendarId: string | null,
  year: number | null,
  client: ApiClient = apiClient,
): UseQueryResult<ListMakeupWorkdaysResponse, Error> {
  const projectKey = useProjectKey();
  return useQuery({
    queryKey: calendarKeys.makeupWorkdays(projectKey, calendarId ?? '', year),
    enabled: calendarId !== null && calendarId !== '',
    queryFn: ({ signal }) =>
      client.get(
        projectApiPath(projectKey, `/calendars/${calendarId ?? ''}/makeup-workdays`),
        listMakeupWorkdaysResponseSchema,
        { signal, query: { year } },
      ),
  });
}

export interface ImportMakeupWorkdaysVars {
  readonly calendarId: string;
  readonly body: ImportMakeupWorkdaysRequest;
}

export function useImportMakeupWorkdays(
  client: ApiClient = apiClient,
): UseMutationResult<ImportMakeupWorkdaysResponse, Error, ImportMakeupWorkdaysVars> {
  const projectKey = useProjectKey();
  const invalidate = useInvalidateCalendarData(projectKey);
  return useMutation({
    mutationFn: (vars: ImportMakeupWorkdaysVars) =>
      client.post(
        calendarWritePath(projectKey, vars.calendarId, '/makeup-workdays/import'),
        vars.body,
        importMakeupWorkdaysResponseSchema,
      ),
    onSuccess: invalidate,
  });
}

export interface DeleteMakeupWorkdayVars {
  readonly calendarId: string;
  readonly date: string;
}

export function useDeleteMakeupWorkday(
  client: ApiClient = apiClient,
): UseMutationResult<DeleteMakeupWorkdayResponse, Error, DeleteMakeupWorkdayVars> {
  const projectKey = useProjectKey();
  const invalidate = useInvalidateCalendarData(projectKey);
  return useMutation({
    mutationFn: (vars: DeleteMakeupWorkdayVars) =>
      client.delete(
        calendarWritePath(projectKey, vars.calendarId, `/makeup-workdays/${vars.date}`),
        deleteMakeupWorkdayResponseSchema,
      ),
    onSuccess: invalidate,
  });
}
