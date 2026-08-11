/**
 * Hợp đồng HTTP của nhóm API lịch làm việc & ngày nghỉ — T-36.
 *
 * Để ở `shared` vì màn hình "Ngày nghỉ" (web) dùng lại đúng những schema này
 * để kiểm dữ liệu tại biên, giống mọi nhóm API khác.
 */
import { z } from 'zod';
import { DATE_ONLY_PATTERN } from './calendar.js';

/**
 * Giới hạn số ngày trong một lần import.
 *
 * Một năm có nhiều nhất vài chục ngày lễ; 500 đủ cho cả chục năm dán một lần.
 * Không giới hạn thì một lần dán nhầm cả file log sẽ thành 100 nghìn dòng INSERT.
 */
export const MAX_HOLIDAYS_PER_IMPORT = 500;

/**
 * Hai phía làm việc của dự án — người VN làm, người JP (khách hàng) review.
 *
 * Đây là enum NGHIỆP VỤ chứ không phải danh sách lịch: cột Signboard gắn `side`
 * để biết loại task đó do phía nào làm, từ đó biết phải kiểm tra ngày kế hoạch
 * với lịch nào (T-37).
 */
export const WORK_SIDE = ['VN', 'JP'] as const;
export type WorkSide = (typeof WORK_SIDE)[number];

/** Lịch chuẩn của từng phía. Seed tạo sẵn hai lịch này (T-02). */
export const SIDE_CALENDAR_ID: Readonly<Record<WorkSide, string>> = {
  VN: 'VN_STANDARD',
  JP: 'JP_STANDARD',
};

// ---------------------------------------------------------------------------
// GET /api/calendars
// ---------------------------------------------------------------------------

export const calendarSummarySchema = z.object({
  calendarId: z.string(),
  timezone: z.string(),
  workdaysMask: z.number().int(),
  hoursPerDay: z.number(),
  holidayCount: z.number().int().nonnegative(),
  /** Các năm đã có ít nhất một ngày lễ — để màn hình cảnh báo năm còn trống. */
  years: z.array(z.number().int()),
});
export type CalendarSummary = z.infer<typeof calendarSummarySchema>;

export const listCalendarsResponseSchema = z.object({
  calendars: z.array(calendarSummarySchema),
});
export type ListCalendarsResponse = z.infer<typeof listCalendarsResponseSchema>;

// ---------------------------------------------------------------------------
// GET /api/calendars/:id/holidays?year=
// ---------------------------------------------------------------------------

export const holidaySchema = z.object({
  /** `'YYYY-MM-DD'` — ngày dương lịch thuần, không kèm múi giờ (C-1). */
  date: z.string().regex(DATE_ONLY_PATTERN, 'Ngày phải có dạng YYYY-MM-DD.'),
  label: z.string().max(200).nullable(),
});
export type Holiday = z.infer<typeof holidaySchema>;

export const listHolidaysResponseSchema = z.object({
  calendarId: z.string(),
  /** `null` = trả về toàn bộ, không lọc theo năm. */
  year: z.number().int().nullable(),
  holidays: z.array(holidaySchema),
});
export type ListHolidaysResponse = z.infer<typeof listHolidaysResponseSchema>;

// ---------------------------------------------------------------------------
// POST /api/calendars/:id/holidays/import
// ---------------------------------------------------------------------------

/**
 * `MERGE` — thêm/ghi đè từng ngày, giữ nguyên những ngày không nhắc tới.
 * `REPLACE_YEAR` — xoá sạch ngày lễ của `year` rồi chèn lại danh sách mới,
 * để import lại một năm không bị sót ngày đã bỏ khỏi danh sách.
 */
export const HOLIDAY_IMPORT_MODE = ['MERGE', 'REPLACE_YEAR'] as const;
export type HolidayImportMode = (typeof HOLIDAY_IMPORT_MODE)[number];

export const importHolidaysRequestSchema = z
  .object({
    mode: z.enum(HOLIDAY_IMPORT_MODE),
    /** Bắt buộc với `REPLACE_YEAR`; `MERGE` không dùng tới. */
    year: z.number().int().min(2000).max(2100).nullable().default(null),
    holidays: z
      .array(holidaySchema.extend({ label: z.string().max(200).nullable().default(null) }))
      .max(
        MAX_HOLIDAYS_PER_IMPORT,
        `Mỗi lần import tối đa ${MAX_HOLIDAYS_PER_IMPORT} ngày.`,
      ),
  })
  .superRefine((body, ctx) => {
    if (body.mode === 'REPLACE_YEAR') {
      if (body.year === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['year'],
          message: 'Chế độ thay cả năm cần chỉ rõ năm.',
        });
        return;
      }
      // Mọi ngày phải nằm trong năm bị thay — lẫn một ngày của năm khác vào là
      // xoá nhầm phạm vi mà người dùng không hề định làm.
      body.holidays.forEach((h, i) => {
        if (!h.date.startsWith(`${body.year}-`)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['holidays', i, 'date'],
            message: `Ngày ${h.date} không thuộc năm ${body.year} đang được thay thế.`,
          });
        }
      });
    }
  });
export type ImportHolidaysRequest = z.infer<typeof importHolidaysRequestSchema>;

export const importHolidaysResponseSchema = z.object({
  calendarId: z.string(),
  /** Số ngày MỚI được thêm. */
  inserted: z.number().int().nonnegative(),
  /** Số ngày đã tồn tại và được ghi đè (đổi nhãn). */
  updated: z.number().int().nonnegative(),
  /** Số ngày bị xoá (chỉ khác 0 ở chế độ `REPLACE_YEAR`). */
  deleted: z.number().int().nonnegative(),
  /** Số Epic được đánh dấu tính lại vì lịch đổi. */
  epicsMarkedForRecompute: z.number().int().nonnegative(),
});
export type ImportHolidaysResponse = z.infer<typeof importHolidaysResponseSchema>;

/** DELETE /api/calendars/:id/holidays/:date dùng lại cùng hình dạng phản hồi. */
export const deleteHolidayResponseSchema = z.object({
  calendarId: z.string(),
  deleted: z.number().int().nonnegative(),
  epicsMarkedForRecompute: z.number().int().nonnegative(),
});
export type DeleteHolidayResponse = z.infer<typeof deleteHolidayResponseSchema>;
