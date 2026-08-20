import type { PlanConflictsResponse } from '@app/shared';
import { computePlanConflicts } from './plan-conflicts.service.js';
import type { PlanConflictReadPort } from '../routes/plan-conflicts.routes.js';

/**
 * Điều phối kiểm tra plan rơi vào ngày nghỉ trên MỘT hoặc NHIỀU Epic — T-37.
 *
 * Ghép cổng đọc (I/O) với hàm thuần `computePlanConflicts`, gồm cả quy tắc chọn
 * lịch theo phía (VN dùng lịch thực thi của Epic, JP dùng lịch chuẩn khách hàng).
 * Tách khỏi tầng route để cả route lẫn dashboard giám sát (T-33, `ops.adapters`)
 * cùng tái dùng ĐÚNG một cách tính thay vì chép lại logic hai phía.
 */

/** Lịch chuẩn phía khách hàng — phía JP review theo lịch này. */
export const JP_REVIEW_CALENDAR_ID = 'JP_STANDARD';

interface EpicForCheck {
  readonly epicKey: string;
  readonly projectKey: string;
  readonly calendarId: string;
}

/** Tính xung đột plan-ngày nghỉ cho MỘT Epic. */
export async function conflictsOf(
  reads: PlanConflictReadPort,
  epic: EpicForCheck,
): Promise<PlanConflictsResponse> {
  const [subtasks, columnSides, vn, jp] = await Promise.all([
    reads.subtasksForCheck(epic.epicKey),
    reads.columnSides(epic.projectKey),
    // Phía VN làm theo lịch THỰC THI của chính Epic; phía JP review theo lịch
    // chuẩn khách hàng. Hai phía nghỉ khác ngày — đó chính là lý do tồn tại của
    // cả chức năng này.
    reads.sideCalendar(epic.calendarId),
    reads.sideCalendar(JP_REVIEW_CALENDAR_ID),
  ]);
  return computePlanConflicts({
    epicKey: epic.epicKey,
    subtasks,
    columnSides,
    calendars: { VN: vn, JP: jp },
  });
}

/**
 * Cùng phép tính cho cả DANH SÁCH Epic — chạy đồng thời.
 *
 * Tuần tự sẽ chậm khi có nhiều Epic; mỗi Epic chỉ là vài query đọc nhẹ nên chạy
 * song song cả danh sách.
 */
export async function computeConflictsForEpics(
  reads: PlanConflictReadPort,
  epics: readonly EpicForCheck[],
): Promise<PlanConflictsResponse[]> {
  return Promise.all(epics.map((e) => conflictsOf(reads, e)));
}
