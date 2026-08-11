import {
  DEFAULT_HOURS_PER_DAY,
  DEFAULT_WORKDAYS_MASK,
  workdaysMaskWarning,
  type WorkCalendar,
} from '@app/shared';
import type { PrismaClient } from '../client.js';

/**
 * Đọc lịch làm việc — PRD §9.4, E-14.
 *
 * Engine KHÔNG đọc database. Repository này gộp `work_calendar` +
 * `calendar_holiday` thành một object rồi truyền vào engine qua tham số.
 */

/** Múi giờ mặc định khi không tìm thấy lịch. */
export const FALLBACK_TIMEZONE = 'Asia/Ho_Chi_Minh';

/**
 * Bộ nhớ đệm lịch trong RAM.
 *
 * Lịch gần như không đổi nên đệm là hợp lý. Nhưng PHẢI có cách làm mới: thêm
 * ngày lễ mà worker chạy suốt vài tuần không khởi động lại thì nó vẫn dùng lịch
 * cũ — và đường Kế hoạch sẽ giảm đều trong cả tuần nghỉ Tết.
 */
export class CalendarCache {
  private readonly entries = new Map<string, WorkCalendar>();

  get(calendarId: string): WorkCalendar | undefined {
    return this.entries.get(calendarId);
  }

  set(calendarId: string, calendar: WorkCalendar): void {
    this.entries.set(calendarId, calendar);
  }

  /** Làm mới sau khi sửa ngày lễ. Không truyền id thì xoá sạch. */
  invalidate(calendarId?: string): void {
    if (calendarId === undefined) this.entries.clear();
    else this.entries.delete(calendarId);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Lấy một lịch, gộp sẵn ngày lễ.
 *
 * Không tìm thấy lịch → dùng mặc định T2–T6 và **ghi cảnh báo vào chính dữ liệu
 * trả về** (C-10). Trả về mặc định trong im lặng sẽ khiến một Epic cấu hình sai
 * vẫn vẽ ra biểu đồ trông bình thường.
 */
export async function getCalendar(
  prisma: PrismaClient,
  calendarId: string,
  cache?: CalendarCache,
): Promise<WorkCalendar> {
  const cached = cache?.get(calendarId);
  if (cached) return cached;

  const row = await prisma.workCalendar.findUnique({
    where: { calendarId },
    include: {
      holidays: { select: { holidayDate: true } },
      makeupWorkdays: { select: { workDate: true } },
    },
  });

  const calendar: WorkCalendar =
    row === null
      ? {
          calendarId,
          timezone: FALLBACK_TIMEZONE,
          workdaysMask: DEFAULT_WORKDAYS_MASK,
          hoursPerDay: DEFAULT_HOURS_PER_DAY,
          holidays: new Set<string>(),
          makeupWorkdays: new Set<string>(),
          warnings: [
            `Không tìm thấy lịch làm việc "${calendarId}". Đang dùng mặc định ` +
              `Thứ Hai–Thứ Sáu, múi giờ ${FALLBACK_TIMEZONE}, không có ngày lễ. ` +
              `Ngày nghỉ lễ sẽ bị tính như ngày làm việc.`,
          ],
        }
      : {
          calendarId: row.calendarId,
          timezone: row.timezone,
          workdaysMask: row.workdaysMask,
          hoursPerDay: Number(row.hoursPerDay),
          // Cột là `DATE` nên Prisma trả về mốc nửa đêm UTC — cắt lấy phần ngày
          // là đúng. Đừng đổi múi giờ ở đây: `2026-02-17` là ngày lễ ở mọi múi
          // giờ dùng lịch này, không phải một khoảnh khắc cụ thể.
          holidays: new Set(row.holidays.map((h) => h.holidayDate.toISOString().slice(0, 10))),
          // Ngày làm bù: cùng quy ước ngày dương lịch như holidays — cắt lấy
          // phần ngày, không đổi múi giờ. `?? []` phòng bản ghi cũ chưa có quan
          // hệ này (makeupWorkdays là trường THÊM SAU, optional trên WorkCalendar).
          makeupWorkdays: new Set(
            (row.makeupWorkdays ?? []).map((m) => m.workDate.toISOString().slice(0, 10)),
          ),
          warnings: [
            // Mask sai quy ước bit (thiếu Thứ Hai / ngoài 7 bit) làm cả tuần
            // trượt một ngày — Thứ Hai lặng lẽ biến mất khỏi biểu đồ. Kêu to
            // ngay tại nguồn dữ liệu (C-10) thay vì để người xem tự dò.
            ...(workdaysMaskWarning(row.workdaysMask) === null
              ? []
              : [workdaysMaskWarning(row.workdaysMask)!]),
            ...(row.holidays.length === 0
              ? [
                  `Lịch "${calendarId}" chưa khai ngày lễ nào. Nếu Epic vắt qua Tết ` +
                    `thì đường Kế hoạch sẽ giảm đều trong cả tuần nghỉ (E-14).`,
                ]
              : []),
          ],
        };

  cache?.set(calendarId, calendar);
  return calendar;
}
