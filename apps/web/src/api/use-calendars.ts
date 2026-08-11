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
import { apiClient, type ApiClient } from './client.js';

/**
 * Hook của màn hình "Ngày nghỉ" (T-36) và ô chọn lịch ở màn Epics.
 *
 * Sau khi sửa ngày lễ phải làm mới CẢ hai nhóm dữ liệu suy ra từ lịch:
 * biểu đồ Burndown (server đã xoá cache phía nó, client cũng phải quên bản đã
 * tải) và báo cáo plan-conflicts. Thiếu bước này thì import xong màn hình vẫn
 * hiện số cũ tới lần F5 kế tiếp — trông y hệt "chức năng hỏng".
 */

export const calendarKeys = {
  all: ['calendars'] as const,
  list: () => ['calendars', 'list'] as const,
  holidays: (calendarId: string, year: number | null) =>
    ['calendars', calendarId, 'holidays', year ?? 'all'] as const,
  makeupWorkdays: (calendarId: string, year: number | null) =>
    ['calendars', calendarId, 'makeup-workdays', year ?? 'all'] as const,
};

export function useCalendars(
  client: ApiClient = apiClient,
): UseQueryResult<ListCalendarsResponse, Error> {
  return useQuery({
    queryKey: calendarKeys.list(),
    queryFn: ({ signal }) => client.get('/calendars', listCalendarsResponseSchema, { signal }),
  });
}

export function useHolidays(
  calendarId: string | null,
  year: number | null,
  client: ApiClient = apiClient,
): UseQueryResult<ListHolidaysResponse, Error> {
  return useQuery({
    queryKey: calendarKeys.holidays(calendarId ?? '', year),
    enabled: calendarId !== null && calendarId !== '',
    queryFn: ({ signal }) =>
      client.get(`/calendars/${calendarId ?? ''}/holidays`, listHolidaysResponseSchema, {
        signal,
        query: { year },
      }),
  });
}

function useInvalidateCalendarData() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
    void queryClient.invalidateQueries({ queryKey: ['plan-conflicts'] });
    // Đường Kế hoạch vẽ từ lịch — mọi biểu đồ đã tải đều nghi ngờ là cũ.
    void queryClient.invalidateQueries({ queryKey: ['burndown'] });
  };
}

export interface ImportHolidaysVars {
  readonly calendarId: string;
  readonly body: ImportHolidaysRequest;
}

export function useImportHolidays(
  client: ApiClient = apiClient,
): UseMutationResult<ImportHolidaysResponse, Error, ImportHolidaysVars> {
  const invalidate = useInvalidateCalendarData();
  return useMutation({
    mutationFn: (vars: ImportHolidaysVars) =>
      client.post(`/calendars/${vars.calendarId}/holidays/import`, vars.body, importHolidaysResponseSchema),
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
  const invalidate = useInvalidateCalendarData();
  return useMutation({
    mutationFn: (vars: DeleteHolidayVars) =>
      client.delete(`/calendars/${vars.calendarId}/holidays/${vars.date}`, deleteHolidayResponseSchema),
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
  return useQuery({
    queryKey: calendarKeys.makeupWorkdays(calendarId ?? '', year),
    enabled: calendarId !== null && calendarId !== '',
    queryFn: ({ signal }) =>
      client.get(`/calendars/${calendarId ?? ''}/makeup-workdays`, listMakeupWorkdaysResponseSchema, {
        signal,
        query: { year },
      }),
  });
}

export interface ImportMakeupWorkdaysVars {
  readonly calendarId: string;
  readonly body: ImportMakeupWorkdaysRequest;
}

export function useImportMakeupWorkdays(
  client: ApiClient = apiClient,
): UseMutationResult<ImportMakeupWorkdaysResponse, Error, ImportMakeupWorkdaysVars> {
  const invalidate = useInvalidateCalendarData();
  return useMutation({
    mutationFn: (vars: ImportMakeupWorkdaysVars) =>
      client.post(
        `/calendars/${vars.calendarId}/makeup-workdays/import`,
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
  const invalidate = useInvalidateCalendarData();
  return useMutation({
    mutationFn: (vars: DeleteMakeupWorkdayVars) =>
      client.delete(
        `/calendars/${vars.calendarId}/makeup-workdays/${vars.date}`,
        deleteMakeupWorkdayResponseSchema,
      ),
    onSuccess: invalidate,
  });
}
