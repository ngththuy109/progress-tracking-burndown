import { z } from 'zod';
import { DATE_ONLY_PATTERN } from './calendar.js';

/**
 * Nội dung job `sync-epic` — hợp đồng giữa API (bên đẩy job) và worker (bên chạy job).
 *
 * VÌ SAO SCHEMA NÀY NẰM Ở `shared` CHỨ KHÔNG PHẢI MỖI BÊN MỘT BẢN:
 *
 * API đẩy đủ `from` / `to` / `full` vào job, còn worker lại khai kiểu job chỉ có
 * mỗi `epicKey`. Ba trường kia bị bỏ qua trong im lặng — người vận hành gõ đúng
 * lệnh trong runbook, API trả về `queued: true`, job chạy xong và báo thành công,
 * mà lịch sử KHÔNG hề được dựng lại. Không có một dòng lỗi nào ở bất kỳ đâu.
 *
 * Một schema dùng chung thì hai bên không thể lệch nhau nữa: bên đẩy sai kiểu bị
 * trình biên dịch chặn, bên chạy nhận sai kiểu thì ném lỗi ngay.
 */

// Dùng lại `DATE_ONLY_PATTERN` của `calendar.ts` chứ không viết lại biểu thức
// thứ hai: hai bản sao sẽ có ngày nhận khác nhau, và nơi lệch sẽ là nơi ít ai để ý.
const dateOnly = z
  .string()
  .regex(DATE_ONLY_PATTERN, 'must look like YYYY-MM-DD, for example 2026-03-11');

export const syncJobPayloadSchema = z.object({
  epicKey: z.string().trim().min(1, 'the Epic key is missing'),

  /**
   * Ngày đầu dải cần dựng lại. `null` = để hệ thống tự quyết.
   *
   * Chỉ dùng khi người vận hành biết chính xác mình cần dựng lại từ ngày nào.
   * Bình thường cứ để `null` và dùng `full`.
   */
  from: dateOnly.nullable().default(null),

  /** Ngày cuối dải. `null` = tới hôm nay. */
  to: dateOnly.nullable().default(null),

  /**
   * `true` = đọc lại toàn bộ dữ liệu từ Jira rồi dựng lại TOÀN BỘ lịch sử.
   *
   * Cố ý dùng `z.boolean()` chứ KHÔNG dùng `z.coerce.boolean()`: chuỗi `"true"`
   * gõ nhầm từ dòng lệnh phải bị từ chối kèm lời giải thích. `z.coerce` sẽ biến
   * cả `"false"` thành `true` — im lặng và ngược hẳn ý người gõ.
   */
  full: z.boolean().default(false),
});

export type SyncJobPayload = z.infer<typeof syncJobPayloadSchema>;

export class InvalidJobPayloadError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `Invalid job payload — ${issues.join('; ')}. ` +
        'Usually an old job stuck in the queue after a format change, or a hand-typed curl with the ' +
        'wrong type (for example `"full": "true"` in quotes instead of `"full": true`). ' +
        'Remove that job from the queue and re-queue it from the Epics screen.',
    );
    this.name = 'InvalidJobPayloadError';
  }
}

/**
 * Kiểm nội dung job trước khi dùng.
 *
 * NÉM LỖI chứ không trả về giá trị mặc định: job sai định dạng mà vẫn chạy tiếp
 * sẽ dựng lại nhầm dải ngày và báo thành công.
 */
export function parseSyncJobPayload(raw: unknown): SyncJobPayload {
  const parsed = syncJobPayloadSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  throw new InvalidJobPayloadError(
    parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  );
}
