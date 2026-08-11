import type { PrismaClient } from '@app/db';
import {
  latestSnapshotDate,
  listPlanShifts,
  loadDataQualityRatios,
  loadPhaseRollups,
  loadSnapshotsForChart,
} from '@app/db';
import { DEFAULT_HOURS_PER_DAY, DEFAULT_WORKDAYS_MASK, workdaysMaskWarning, type PhaseRollup, type PlanShiftRecord, type WorkCalendar } from '@app/shared';
import type { BurndownReadPort } from '../routes/burndown.routes.js';

/**
 * Nối cổng đọc biểu đồ vào Prisma.
 *
 * Đây là file DUY NHẤT của nhóm Burndown biết tới Prisma. Tầng service chỉ nhìn
 * thấy `BurndownReadPort`, nhờ vậy test được mà không cần PostgreSQL.
 */

interface EpicMetaRow {
  project_key: string;
  timezone: string | null;
  workdays_mask: number | null;
  hours_per_day: number | null;
}

export function createBurndownReadPort(prisma: PrismaClient): BurndownReadPort {
  return {
    async epicMeta(epicKey) {
      const [row] = await prisma.$queryRawUnsafe<EpicMetaRow[]>(
        `SELECT e.project_key, c.timezone, c.workdays_mask, c.hours_per_day
           FROM tracked_epic e
           LEFT JOIN work_calendar c ON c.calendar_id = e.calendar_id
          WHERE e.epic_key = $1`,
        epicKey,
      );
      if (row === undefined) return null;

      const holidays = await prisma.$queryRawUnsafe<{ holiday_date: Date }[]>(
        `SELECT h.holiday_date
           FROM calendar_holiday h
           JOIN tracked_epic e ON e.calendar_id = h.calendar_id
          WHERE e.epic_key = $1`,
        epicKey,
      );

      const warnings: string[] = [];
      // Thiếu lịch thì dùng mặc định và NÓI RA, không im lặng — sai múi giờ
      // làm lệch mọi mốc chốt sổ mà nhìn số vẫn thấy hợp lý.
      if (row.timezone === null) {
        warnings.push(
          'This Epic points at a work calendar that does not exist; falling back to Mon–Fri, Asia/Tokyo, no holidays. ' +
            'Pick a real calendar for this Epic on the Epics screen.',
        );
      } else if (holidays.length === 0) {
        // E-14: không có ngày lễ nào thì đường Kế hoạch cháy đều qua tuần nghỉ
        // Tết — PM nhìn biểu đồ sẽ tưởng team đang chậm nghiêm trọng.
        warnings.push(
          'No holiday is registered on this Epic’s work calendar, so the Planned line treats holiday weeks ' +
            'as working days. An Admin can import them on the Days off screen.',
        );
      }

      // Mask sai quy ước bit (thiếu Thứ Hai / ngoài 7 bit) làm cả tuần trượt
      // một ngày: Chủ nhật thành ngày làm việc còn mọi Thứ Hai biến mất khỏi
      // trục biểu đồ. Đây từng là lỗi thật với bản ghi lịch tạo tay mask 126 —
      // phải hiện ngay trên màn hình Burndown thay vì bắt người xem tự dò.
      const maskWarning = workdaysMaskWarning(row.workdays_mask ?? DEFAULT_WORKDAYS_MASK);
      if (maskWarning !== null) warnings.push(maskWarning);

      const calendar: WorkCalendar = {
        calendarId: 'epic',
        timezone: row.timezone ?? 'Asia/Tokyo',
        workdaysMask: row.workdays_mask ?? DEFAULT_WORKDAYS_MASK,
        hoursPerDay: row.hours_per_day ?? DEFAULT_HOURS_PER_DAY,
        holidays: new Set(holidays.map((h) => h.holiday_date.toISOString().slice(0, 10))),
        warnings,
      };

      return { projectKey: row.project_key, calendar };
    },

    loadSnapshots: (epicKey, from, to) => loadSnapshotsForChart(prisma, epicKey, from, to),

    latestSnapshotDate: (epicKey) => latestSnapshotDate(prisma, epicKey),

    // `loadPhaseRollups` trả về Map (T-18 cần tra theo mã Phase); biểu đồ cần mảng.
    loadRollups: async (epicKey): Promise<readonly PhaseRollup[]> => [
      ...(await loadPhaseRollups(prisma, epicKey)).values(),
    ],

    loadPlanShifts: (epicKey): Promise<readonly PlanShiftRecord[]> => listPlanShifts(prisma, epicKey),

    loadRatios: (epicKey) => loadDataQualityRatios(prisma, epicKey),

    async phaseLabels(projectKey) {
      const rows = await prisma.$queryRawUnsafe<
        { phase_code: string; label_vi: string; color_hex: string | null }[]
      >(
        `SELECT d.phase_code, d.label_vi, d.color_hex
           FROM phase_definition d
           JOIN phase_config_set s ON s.id = d.config_set_id
          WHERE s.is_active = true
            AND (s.project_key = $1 OR s.scope = 'GLOBAL')
          ORDER BY CASE WHEN s.project_key = $1 THEN 0 ELSE 1 END, d.display_order`,
        projectKey,
      );

      const out: Record<string, { label: string; colorHex: string | null }> = {};
      // Bản của project đứng trước nên ghi đè bản Mặc định một cách tự nhiên.
      for (const r of rows) {
        out[r.phase_code] ??= { label: r.label_vi, colorHex: r.color_hex };
      }
      return out;
    },
  };
}
