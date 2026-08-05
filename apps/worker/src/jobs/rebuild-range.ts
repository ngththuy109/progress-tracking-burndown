import { DateTime } from 'luxon';
import type { DateOnly } from '@app/shared';

/**
 * Quyết định dải ngày cần dựng lại — RUNBOOK mục "Dựng lại lịch sử một Epic".
 *
 * HÀM THUẦN: "hôm nay" nhận qua tham số chứ không đọc đồng hồ, nhờ vậy test kiểm
 * được cả ca chuyển tháng lẫn ca ngày cuối nằm ở tương lai mà không chập chờn.
 */

/**
 * Số ngày lịch mà một lượt đồng bộ thường ngày dựng lại.
 *
 * VÌ SAO 7 CHỨ KHÔNG PHẢI 1: job đêm chỉ cần chốt sổ hôm qua, nhưng nó còn phải
 * bù những ngày mà lượt trước bỏ lỡ (E-12). Một ngày là vừa đủ cho ngày đẹp trời
 * và không đủ cho bất cứ ngày nào khác — nghỉ lễ dài, worker chết cuối tuần, ba
 * đêm liền Jira lỗi. Bảy ngày phủ hết những ca đó mà vẫn rẻ, vì dựng lại một
 * ngày chỉ là tính toán trong bộ nhớ, không tốn thêm lần gọi Jira nào.
 *
 * Ngày thiếu snapshot cũ hơn bảy ngày vẫn được bù: xem `earliestMissingSnapshotDate`.
 */
export const INCREMENTAL_REBUILD_DAYS = 7;

/**
 * Vì sao dải ngày lại là dải đó — dùng cho log và cho `/ops`.
 *
 * `EXPLICIT` đứng trên cả `FULL`: người vận hành gõ tay ngày cụ thể thì họ biết
 * mình cần gì hơn là hệ thống đoán hộ.
 */
export type RebuildScope = 'FULL' | 'INCREMENTAL' | 'EXPLICIT';

export interface RebuildRangeInput {
  /** `true` = dựng lại toàn bộ lịch sử. */
  readonly full: boolean;
  /** Ngày đầu do người gọi chỉ định, hoặc `null`. */
  readonly from: string | null;
  /** Ngày cuối do người gọi chỉ định, hoặc `null`. */
  readonly to: string | null;
  /** Ngày sớm nhất Epic này có dữ liệu. `null` = chưa có gì để dựng lại. */
  readonly earliestDataDate: DateOnly | null;
  /** Ngày thiếu snapshot sớm nhất (E-12). `null` = không thiếu ngày nào. */
  readonly earliestMissingSnapshotDate: DateOnly | null;
  /** Hôm nay theo múi giờ của Epic. */
  readonly today: DateOnly;
  readonly timezone: string;
}

export interface RebuildRange {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly scope: RebuildScope;
  /**
   * Những điều chỉnh mà hàm đã tự làm.
   *
   * Có thì phải NÓI RA. Lặng lẽ kẹp ngày rồi báo thành công là kiểu lỗi khiến
   * người vận hành ngồi tự hỏi vì sao dải ngày mình gõ lại không được tôn trọng.
   */
  readonly notes: readonly string[];
}

export class RebuildRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RebuildRangeError';
  }
}

/** Lùi `days` ngày lịch (không phải ngày làm việc). */
function minusDays(date: DateOnly, days: number, timezone: string): DateOnly {
  const dt = DateTime.fromISO(date, { zone: timezone });
  if (!dt.isValid) {
    throw new RebuildRangeError(
      `Không đọc được ngày "${date}" ở múi giờ "${timezone}". ` +
        'Ngày phải có dạng YYYY-MM-DD và múi giờ phải là tên IANA, ví dụ Asia/Ho_Chi_Minh.',
    );
  }
  return dt.minus({ days }).toFormat('yyyy-MM-dd');
}

/**
 * Chốt dải ngày sẽ dựng lại.
 *
 * Chuỗi `YYYY-MM-DD` so sánh trực tiếp bằng `<` `>` được vì thứ tự từ điển trùng
 * với thứ tự thời gian — không cần chuyển sang `Date` rồi lại dính múi giờ.
 */
export function resolveRebuildRange(input: RebuildRangeInput): RebuildRange {
  const notes: string[] = [];

  // --- đầu trên của dải ---
  let to = input.to ?? input.today;
  if (to > input.today) {
    // Snapshot ghi số liệu THỰC TẾ của một ngày. Dựng cho ngày chưa tới chỉ tạo
    // ra bản sao của hôm nay đội lốt tương lai, và biểu đồ sẽ có một đoạn phẳng
    // trông như "đã đứng yên nhiều ngày".
    notes.push(
      `Kẹp ngày cuối từ ${to} về ${input.today}: không dựng snapshot cho ngày chưa tới.`,
    );
    to = input.today;
  }

  // --- đầu dưới của dải ---
  let from: DateOnly;

  if (input.from !== null) {
    from = input.from;
  } else if (input.full) {
    if (input.earliestDataDate === null) {
      throw new RebuildRangeError(
        'Không dựng lại được toàn bộ lịch sử vì Epic này chưa có dữ liệu nào — ' +
          'không có mốc nào để bắt đầu, và hệ thống KHÔNG đoán bừa ngày. ' +
          'Chạy đồng bộ lần đầu cho Epic (thêm nó ở màn hình danh sách Epic) rồi thử lại, ' +
          'hoặc gọi lại kèm ngày đầu cụ thể: {"from":"2026-01-01","full":true}.',
      );
    }
    from = input.earliestDataDate;
  } else {
    from = minusDays(input.today, INCREMENTAL_REBUILD_DAYS, input.timezone);

    // E-12: ngày thiếu snapshot nằm ngoài cửa sổ vẫn phải được bù. Không nới thì
    // runbook mục `SNAPSHOT_MISSING` nói dối — nó bảo người trực bấm "Đồng bộ
    // lại" để vá lỗ thủng, mà lỗ thủng cũ hơn bảy ngày sẽ không bao giờ được vá.
    const missing = input.earliestMissingSnapshotDate;
    if (missing !== null && missing < from) {
      notes.push(`Nới ngày đầu từ ${from} về ${missing} để bù ngày thiếu snapshot (E-12).`);
      from = missing;
    }
  }

  if (from > to) {
    throw new RebuildRangeError(
      `Dải ngày ngược: ngày đầu ${from} nằm sau ngày cuối ${to}. ` +
        'Kiểm tra lại hai tham số `from` và `to`; bỏ trống cả hai thì hệ thống tự chọn.',
    );
  }

  const scope: RebuildScope =
    input.from !== null || input.to !== null ? 'EXPLICIT' : input.full ? 'FULL' : 'INCREMENTAL';

  return { from, to, scope, notes };
}
