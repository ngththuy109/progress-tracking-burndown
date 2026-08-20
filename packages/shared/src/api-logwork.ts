import { z } from 'zod';
import { STATUS_CATEGORY } from './enums.js';

/**
 * Hợp đồng HTTP: theo dõi việc LOG WORK của member — TOÀN ĐỘI, mọi Epic đang
 * theo dõi mà người xem được phép thấy.
 *
 * Trả lời câu hỏi: "Trong kỳ này, ai chưa log work? Trên những ticket đang mở
 * nào mà họ đang 'in charge' (field Request participants của Jira)? Bấm vào đâu
 * để sang Jira log?".
 *
 * Nguồn dữ liệu (chỉ đọc Postgres, KHÔNG gọi Jira):
 *   - Giờ đã log: `worklog_entry` (lọc theo `started_at`, bỏ bản `is_deleted`).
 *   - "In charge": `jira_issue.sb_request_participants` (chỉ có ở Sub-task).
 *   - Ticket "chưa đóng": `status_category <> 'done'` (C-4: KHÔNG so `status.name`).
 *
 * "Chưa log" nghĩa là CHÍNH member đó chưa log giờ nào lên ticket trong kỳ — dù
 * người khác có thể đã log (khi đó `totalLoggedHours > 0` còn `memberLoggedHours`
 * = 0, UI đọc thành "0 / X"). Ticket đã được PM "verify — thôi theo dõi" thì
 * `exempted = true` và KHÔNG còn tính vào `notLogged`/`notLoggedCount`.
 */

export const logworkTicketSchema = z.object({
  issueKey: z.string(),
  epicKey: z.string(),
  /** Project của Epic — để web quyết định user hiện tại có được "verify" dòng này không. */
  projectKey: z.string(),
  summary: z.string(),
  parentKey: z.string().nullable(),
  phaseCode: z.string(),
  /** Luôn khác `'done'` (chỉ liệt kê ticket đang mở), nhưng giữ đủ union cho gọn kiểu. */
  statusCategory: z.enum(STATUS_CATEGORY),
  originalEstimateHours: z.number(),
  /** Giờ CHÍNH member này log lên ticket này, trong kỳ. */
  memberLoggedHours: z.number(),
  /** Tổng giờ MỌI người log lên ticket này, trong kỳ (0 / X → người khác đã cover). */
  totalLoggedHours: z.number(),
  /** `memberLoggedHours === 0 && !exempted`. */
  notLogged: z.boolean(),
  /** PM đã "verify — thôi theo dõi" cặp (member, ticket) này. */
  exempted: z.boolean(),
  /** `userId` (email) của người đã đánh dấu; `null` khi chưa exempt. */
  exemptedBy: z.string().nullable(),
  /** ISO timestamp lúc đánh dấu; `null` khi chưa exempt. */
  exemptedAt: z.string().nullable(),
});

export const logworkMemberSchema = z.object({
  accountId: z.string(),
  /** Tên hiển thị lấy từ participant JSON; `null` → web hiện accountId thay thế. */
  displayName: z.string().nullable(),
  /** Tổng giờ member log trong kỳ, trên MỌI Epic thấy được (kể cả ticket không in-charge). */
  totalLoggedHours: z.number(),
  /** `false` = có log giờ nhưng không in-charge ticket mở nào ("logged, not assigned"). */
  hasOpenAssignments: z.boolean(),
  tickets: z.array(logworkTicketSchema),
  /** Số ticket đang mở mà member này chưa log (đã trừ ticket exempt). */
  notLoggedCount: z.number().int(),
  /** Số ticket đã được PM "verify — thôi theo dõi". */
  exemptedCount: z.number().int(),
  /** Epic "chính" dùng để tính capacity; `null` khi member không in-charge Epic nào. */
  primaryEpicKey: z.string().nullable(),
  /** Giờ kỳ vọng = số ngày công (đã prorate) × giờ/ngày của project/lịch. */
  expectedHours: z.number(),
  /** `max(0, expectedHours - totalLoggedHours)`. */
  deficitHours: z.number(),
  /** `expectedHours > 0 && totalLoggedHours < expectedHours`. */
  behind: z.boolean(),
});

export const logworkResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  members: z.array(logworkMemberSchema),
  totalMembers: z.number().int(),
  /** Tổng số cặp (member, ticket) đang bị gắn cờ chưa-log trên toàn đội. */
  totalNotLogged: z.number().int(),
  /** Số Epic đang theo dõi mà người xem được phép thấy (đã lọc theo quyền). */
  visibleEpicCount: z.number().int(),
  /**
   * `false` = không Sub-task mở nào có participant. Hai khả năng: field Request
   * participants chưa bật trong `config/jira-fields.yaml`, HOẶC thật sự chưa ai
   * được gán. Web phải nêu cả hai trong empty-state.
   */
  hasParticipantData: z.boolean(),
  /** Kỳ bao gồm hôm nay/tương lai → `expectedHours` đã được prorate theo ngày công đã qua. */
  partialPeriod: z.boolean(),
  /** Cảnh báo lịch (thiếu lịch/ngày lễ/mask sai) — gộp trùng qua các Epic thấy được. */
  warnings: z.array(z.string()),
});

/**
 * Kiểu TypeScript khai TAY để giữ `readonly` xuyên suốt (zod sinh mảng sửa
 * được). Schema ở trên vẫn dùng để `apps/web` kiểm dữ liệu tại biên (T-20).
 */
export interface LogworkTicket {
  readonly issueKey: string;
  readonly epicKey: string;
  readonly projectKey: string;
  readonly summary: string;
  readonly parentKey: string | null;
  readonly phaseCode: string;
  readonly statusCategory: (typeof STATUS_CATEGORY)[number];
  readonly originalEstimateHours: number;
  readonly memberLoggedHours: number;
  readonly totalLoggedHours: number;
  readonly notLogged: boolean;
  readonly exempted: boolean;
  readonly exemptedBy: string | null;
  readonly exemptedAt: string | null;
}

export interface LogworkMember {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly totalLoggedHours: number;
  readonly hasOpenAssignments: boolean;
  readonly tickets: readonly LogworkTicket[];
  readonly notLoggedCount: number;
  readonly exemptedCount: number;
  readonly primaryEpicKey: string | null;
  readonly expectedHours: number;
  readonly deficitHours: number;
  readonly behind: boolean;
}

export interface LogworkResponse {
  readonly from: string;
  readonly to: string;
  readonly members: readonly LogworkMember[];
  readonly totalMembers: number;
  readonly totalNotLogged: number;
  readonly visibleEpicCount: number;
  readonly hasParticipantData: boolean;
  readonly partialPeriod: boolean;
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Báo cáo LƯỚI: PIC × NGÀY — số giờ mỗi người log MỖI NGÀY trong kỳ đã chọn.
//
// Khác báo cáo theo member ở trên (gộp cả kỳ, kèm ticket + capacity): đây là bảng
// pivot để nhìn PHÂN BỐ giờ theo ngày. Hàng là PIC (người CÓ log giờ trong kỳ —
// đúng như màn member cũng gộp cả tác giả không in-charge), cột là từng ngày lịch
// trong khoảng, ô là tổng giờ người đó log ngày đó.
//
// PHẠM VI khác hẳn màn member: gộp worklog của TOÀN BỘ Epic đã sync (mọi trạng
// thái, kể cả worklog mồ côi) và KHÔNG lọc theo quyền người xem — mọi người dùng
// đăng nhập đều thấy cùng một bức tranh toàn đội, mọi project.
//
// "Cảnh báo" một ô: log <= 4h (thiếu) hoặc > 8h (quá). Ngày KHÔNG log (0h) để
// TRỐNG — không phải cảnh báo (không có "một lần log 0 giờ"; ai chưa log gì thì
// màn theo-member đã lo). Xem `logworkDayWarning` — NGUỒN CHÂN LÝ DUY NHẤT cho cả
// tô màu ô ở web lẫn đếm `warnCount` ở API, để hai bên không lệch ngưỡng.
// ---------------------------------------------------------------------------

/** Log <= ngần này giờ trong một ngày → cảnh báo "thiếu". */
export const LOGWORK_UNDER_LIMIT_HOURS = 4;
/** Log > ngần này giờ trong một ngày → cảnh báo "quá". */
export const LOGWORK_OVER_LIMIT_HOURS = 8;

export type LogworkDayWarning = 'under' | 'over' | null;

/**
 * Một ô (PIC, ngày) có đáng cảnh báo không, và thuộc loại nào.
 *
 * Ngưỡng theo yêu cầu PM: `<= 4h` là "thiếu", `> 8h` là "quá". `4h` chẵn tính là
 * thiếu (`<=`), `8h` chẵn là BÌNH THƯỜNG (chỉ `>` mới quá). `0h` (chưa log) trả
 * `null`: ngày trống không phải một lần log nên không tô — nếu không, mọi cuối
 * tuần/ngày nghỉ sẽ đỏ rực dù không ai đi làm.
 */
export function logworkDayWarning(hours: number): LogworkDayWarning {
  if (hours <= 0) return null;
  if (hours <= LOGWORK_UNDER_LIMIT_HOURS) return 'under';
  if (hours > LOGWORK_OVER_LIMIT_HOURS) return 'over';
  return null;
}

/**
 * Bốn dấu của một ô (PIC, ngày), gộp cả cảnh báo số giờ (`under`/`over`) lẫn hai
 * dấu MỚI cần biết ngày đó là ngày làm việc hay ngày nghỉ:
 *   - `'under'` / `'over'`: ngày LÀM VIỆC nhưng log lệch ngưỡng (`logworkDayWarning`).
 *   - `'missing'`: ngày LÀM VIỆC đã QUA mà không có worklog nào.
 *   - `'offday'`: ngày NGHỈ (cuối tuần/lễ) mà LẠI có worklog.
 *   - `null`: bình thường (log đủ trong ngày làm, HOẶC ngày nghỉ không log, HOẶC
 *     ngày làm việc hôm nay/tương lai chưa tới lúc log).
 */
export type LogworkCellFlag = 'under' | 'over' | 'missing' | 'offday' | null;

/**
 * Phân loại một ô để tô màu — NGUỒN CHÂN LÝ DUY NHẤT cho web (tô ô) và API (đếm
 * số ô cần soát), khỏi lệch. Mở rộng `logworkDayWarning` bằng lịch:
 *
 *  - Có log (`hours > 0`) vào ngày NGHỈ → `'offday'` (bất kể ít/nhiều giờ: bất
 *    thường nằm ở việc log vào ngày nghỉ). Ngày làm thì theo ngưỡng cũ `<=4h`/`>8h`.
 *  - Không log (`hours <= 0`) vào ngày LÀM VIỆC đã QUA → `'missing'`. Chỉ tính
 *    ngày đã qua (`isPastDay`): ngày làm việc hôm nay/tương lai để trống là bình
 *    thường, chưa tới hạn log nên KHÔNG đánh dấu (tránh cả tuần đỏ giữa kỳ).
 */
export function logworkCellFlag(
  hours: number,
  isWorkingDay: boolean,
  isPastDay: boolean,
): LogworkCellFlag {
  if (hours > 0) {
    if (!isWorkingDay) return 'offday';
    return logworkDayWarning(hours);
  }
  return isWorkingDay && isPastDay ? 'missing' : null;
}

/** Một ticket đã log trong MỘT ô (PIC, ngày) — để rê chuột mở link sang Jira. */
export const logworkCellTicketSchema = z.object({
  issueKey: z.string(),
  /** Tiêu đề ticket (LEFT JOIN `jira_issue`); `null` với worklog mồ côi (issue không còn trong sổ). */
  summary: z.string().nullable(),
  /** Giờ người này log lên ticket này TRONG ngày của ô. */
  hours: z.number(),
});

export interface LogworkCellTicket {
  readonly issueKey: string;
  readonly summary: string | null;
  readonly hours: number;
}

export const logworkByPicRowSchema = z.object({
  accountId: z.string(),
  /** Tên hiển thị lấy từ participant JSON; `null` → web hiện accountId thay thế. */
  displayName: z.string().nullable(),
  /** Giờ log MỖI NGÀY, song song với `dates`; `0` = ngày đó không log. */
  hoursByDate: z.array(z.number()),
  /**
   * Ticket đã log MỖI NGÀY, song song với `dates` — ô không log thì mảng rỗng.
   * Web rê chuột vào ô để mở danh sách ticket (link sang Jira) đã log ngày đó.
   */
  ticketsByDate: z.array(z.array(logworkCellTicketSchema)),
  /** Tổng giờ người này log trong cả kỳ (tổng của `hoursByDate`). */
  totalHours: z.number(),
  /** Số ô log lệch ngưỡng (`<=4h`/`>8h`) TRONG ngày làm việc — để tóm tắt "cần soát". */
  warnCount: z.number().int(),
  /** Số ngày LÀM VIỆC đã qua mà người này KHÔNG log gì. */
  missingCount: z.number().int(),
  /** Số ngày NGHỈ (cuối tuần/lễ) mà người này LẠI có log. */
  offdayCount: z.number().int(),
});

export const logworkByPicResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Mọi ngày lịch trong `[from, to]` (theo múi giờ tham chiếu), tăng dần — là các CỘT. */
  dates: z.array(z.string()),
  /**
   * Mỗi ngày có phải NGÀY LÀM VIỆC không (theo lịch tham chiếu — trừ cuối tuần và
   * ngày lễ, tính cả ngày làm bù), song song với `dates`. Web tô mờ cột ngày nghỉ
   * và quyết định dấu `missing`/`offday` từ đây.
   */
  workingDays: z.array(z.boolean()),
  /** Ngày HÔM NAY ở múi giờ tham chiếu ('YYYY-MM-DD') — ranh giới "đã qua" để đánh dấu `missing`. */
  today: z.string(),
  rows: z.array(logworkByPicRowSchema),
  /** Tổng giờ MỌI PIC theo từng ngày, song song với `dates` (hàng chân bảng). */
  dailyTotals: z.array(z.number()),
  /** Tổng giờ toàn kỳ, mọi PIC. */
  grandTotal: z.number(),
  /** `<= ` ngưỡng này giờ/ngày → cảnh báo thiếu (web đọc để tô + chú thích). */
  underLimitHours: z.number(),
  /** `> ` ngưỡng này giờ/ngày → cảnh báo quá. */
  overLimitHours: z.number(),
  /** Cảnh báo lịch (thiếu lịch/ngày lễ…) của lịch tham chiếu — gộp trùng. */
  warnings: z.array(z.string()),
});

export interface LogworkByPicRow {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly hoursByDate: readonly number[];
  readonly ticketsByDate: readonly (readonly LogworkCellTicket[])[];
  readonly totalHours: number;
  readonly warnCount: number;
  readonly missingCount: number;
  readonly offdayCount: number;
}

export interface LogworkByPicResponse {
  readonly from: string;
  readonly to: string;
  readonly dates: readonly string[];
  readonly workingDays: readonly boolean[];
  readonly today: string;
  readonly rows: readonly LogworkByPicRow[];
  readonly dailyTotals: readonly number[];
  readonly grandTotal: number;
  readonly underLimitHours: number;
  readonly overLimitHours: number;
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Cấu hình giờ/ngày kỳ vọng theo project (quyết định "behind") — GET/PUT settings.
// ---------------------------------------------------------------------------

export const logworkProjectSettingSchema = z.object({
  projectKey: z.string(),
  /** `null` = chưa cấu hình riêng → dùng giờ/ngày của lịch, cuối cùng tới mặc định. */
  expectedHoursPerDay: z.number().nullable(),
  /** User hiện tại có được sửa project này không (PM của project, hoặc ADMIN). */
  canEdit: z.boolean(),
});

export const logworkSettingsResponseSchema = z.object({
  defaultHoursPerDay: z.number(),
  projects: z.array(logworkProjectSettingSchema),
});

export const logworkSetHoursRequestSchema = z.object({
  /** `> 0` và `<= 24`; `null` = xoá cấu hình riêng, quay về mặc định của lịch. */
  expectedHoursPerDay: z.number().positive().max(24).nullable(),
});

// ---------------------------------------------------------------------------
// PM "verify — thôi theo dõi" một cặp (member, ticket).
// ---------------------------------------------------------------------------

export const logworkExemptionRequestSchema = z.object({
  accountId: z.string().min(1),
  issueKey: z.string().min(1),
  note: z.string().max(500).nullish(),
});

export interface LogworkProjectSetting {
  readonly projectKey: string;
  readonly expectedHoursPerDay: number | null;
  readonly canEdit: boolean;
}

export interface LogworkSettingsResponse {
  readonly defaultHoursPerDay: number;
  readonly projects: readonly LogworkProjectSetting[];
}
