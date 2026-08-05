import type { SubtaskRecord } from '@app/shared';

/**
 * Original Estimate TẠI MỘT MỐC QUÁ KHỨ — PRD E-04.
 *
 * Không được dùng giá trị hiện tại: ai đó sửa Original Estimate từ 40 lên 60
 * vào ngày 15/03 thì snapshot ngày 10/03 phải vẫn tính theo 40. Dùng giá trị
 * hiện tại sẽ làm **toàn bộ lịch sử tự viết lại** mỗi lần có người sửa ước
 * lượng — và biểu đồ hôm qua khác biểu đồ hôm nay mà không ai giải thích được.
 */

export interface OriginalEstimateAt {
  readonly seconds: number;
  /**
   * `true` khi không có changelog nào của trường này nên phải dùng giá trị
   * hiện tại. Đi kèm cảnh báo `ESTIMATE_HISTORY_MISSING`.
   */
  readonly fromCurrentValue: boolean;
}

export const ORIGINAL_ESTIMATE_FIELD = 'timeoriginalestimate';

export function resolveOriginalEstimateAt(
  sub: SubtaskRecord,
  tMs: number,
  onWarning?: (code: string, detail: string) => void,
): OriginalEstimateAt {
  let sawAnyEvent = false;
  /** Giá trị TRƯỚC lần sửa đầu tiên xảy ra SAU mốc T. */
  let valueAtT: number | null = null;

  for (const ev of sub.changelog) {
    if (ev.field !== ORIGINAL_ESTIMATE_FIELD) continue;
    sawAnyEvent = true;

    if (ev.createdAtMs > tMs) {
      // Sự kiện đầu tiên sau mốc T: `fromValue` của nó CHÍNH LÀ giá trị đang có
      // tại thời điểm T. Chỉ lấy khi chưa có giá trị nào từ các sự kiện trước.
      if (valueAtT === null) valueAtT = parseSeconds(ev.fromValue);
      break;
    }

    valueAtT = parseSeconds(ev.toValue);
  }

  if (!sawAnyEvent) {
    // Issue tạo trước khi Jira bật ghi lịch sử trường này. Không có cách nào
    // biết giá trị quá khứ — dùng giá trị hiện tại và NÓI RA (C-10).
    onWarning?.(
      'ESTIMATE_HISTORY_MISSING',
      `${sub.key}: không có lịch sử ${ORIGINAL_ESTIMATE_FIELD}, dùng giá trị hiện tại ` +
        `${sub.originalEstimateSeconds}s cho mọi mốc quá khứ.`,
    );
    return { seconds: sub.originalEstimateSeconds, fromCurrentValue: true };
  }

  // Có sự kiện nhưng đều nằm sau mốc T và `fromValue` rỗng → coi như chưa khai.
  return { seconds: Math.max(0, valueAtT ?? 0), fromCurrentValue: false };
}

/**
 * Đọc số giây từ giá trị changelog.
 *
 * PHẢI phân biệt `null` với chuỗi rỗng: `Number('')` cho ra `0`, không phải
 * `NaN`. Gộp hai thứ này lại sẽ biến "chưa khai ước lượng" thành "ước lượng
 * bằng 0" — hai chuyện khác hẳn nhau.
 */
function parseSeconds(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export { parseSeconds as parseChangelogSeconds };
