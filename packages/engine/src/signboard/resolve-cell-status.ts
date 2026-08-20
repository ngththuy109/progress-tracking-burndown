import {
  isDateOnly,
  type CellStatusInput,
  type DateOnly,
  type SignboardStatus,
} from '@app/shared';

/**
 * Cây quyết định trạng thái một ô Signboard — PRD §6.3.
 *
 * Xét lần lượt, gặp điều kiện nào khớp thì DỪNG:
 *
 *   1. statusCategory = done                  → COMPLETED
 *   2. thiếu plan_start hoặc plan_end         → NO_PLAN
 *   3. chưa có actual_start
 *        hôm nay <= plan_start                 → NYS
 *        hôm nay >  plan_start                 → DELAY_START
 *   4. đã có actual_start
 *        hôm nay >  plan_end                   → DELAY_END     ← xét TRƯỚC
 *        actual_start > plan_start             → DELAY_START
 *        còn lại                               → ON_SCHEDULE
 */

export class InvalidSignboardDateError extends Error {
  constructor(field: string, value: string) {
    super(`Field "${field}" must look like YYYY-MM-DD; got "${value}".`);
    this.name = 'InvalidSignboardDateError';
  }
}

/**
 * So sánh ngày bằng chuỗi CHỈ đúng với dạng `YYYY-MM-DD`.
 *
 * `'2026-3-9' < '2026-03-10'` cho ra `false` vì so từng ký tự. Nên phải chặn
 * ngay ở biên thay vì để một chuỗi lệch định dạng lặng lẽ đảo ngược kết quả.
 */
function assertDateOnly(field: string, v: DateOnly | null): void {
  if (v !== null && !isDateOnly(v)) throw new InvalidSignboardDateError(field, v);
}

export function resolveCellStatus(input: CellStatusInput, asOfDate: DateOnly): SignboardStatus {
  assertDateOnly('asOfDate', asOfDate);
  assertDateOnly('planStart', input.planStart);
  assertDateOnly('planEnd', input.planEnd);
  assertDateOnly('actualStart', input.actualStart);

  // --- BƯỚC 1 ---
  // Xong là xong, kể cả khi kết thúc trễ hoặc thiếu ngày kế hoạch.
  if (input.statusCategory === 'done') return 'COMPLETED';

  // --- BƯỚC 2 ---
  // Thiếu mốc kế hoạch thì KHÔNG có gì để so sánh. Không được ép vào `NYS` (sai
  // nghĩa — task có thể đang làm dở) cũng không được ép vào `ON_SCHEDULE` (bịa
  // ra một kết luận không có căn cứ). Đây là lý do trạng thái thứ 6 tồn tại.
  if (input.planStart === null || input.planEnd === null) return 'NO_PLAN';

  // --- BƯỚC 3: chưa bắt đầu ---
  if (input.actualStart === null) {
    return asOfDate <= input.planStart ? 'NYS' : 'DELAY_START';
  }

  // --- BƯỚC 4: đang làm ---
  // Xét DELAY_END TRƯỚC: task vừa bắt đầu trễ vừa quá hạn thì quá hạn nghiêm
  // trọng hơn. Đảo thứ tự sẽ giấu mất việc task đang quá hạn — PM nhìn thấy màu
  // vàng thay vì đỏ và không ưu tiên xử lý. Lỗi này hoàn toàn im lặng.
  if (asOfDate > input.planEnd) return 'DELAY_END';

  // Bắt đầu trễ nhưng còn trong hạn VẪN là DELAY_START, không "tha" thành
  // ON_SCHEDULE — PM cần biết sớm để can thiệp.
  if (input.actualStart > input.planStart) return 'DELAY_START';

  return 'ON_SCHEDULE';
}
