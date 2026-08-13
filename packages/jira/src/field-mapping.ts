import { z } from 'zod';
import type { JiraField, JiraIssue } from './endpoints.js';

/**
 * Ánh xạ custom field `wbs_start_date` / `wbs_end_date` — PRD §2.8.
 *
 * Không có card này thì không tổng hợp được ngày Phase (T-15) và không vẽ được
 * đường Kế hoạch (T-16).
 *
 * Mã field khai TRỰC TIẾP trong `config/jira-fields.yaml`. Không tự dò field
 * theo tên: mã field là dữ liệu vận hành, người vận hành khai rõ ràng và chịu
 * trách nhiệm — dò tự động chỉ thêm một nguồn "đoán sai trong im lặng".
 */

export const fieldMappingConfigSchema = z.object({
  fieldMapping: z.object({
    wbsStartDate: z.string().min(1),
    wbsEndDate: z.string().min(1),
    /**
     * (Tuỳ chọn) Field "Request participants" — nguồn cho cột PIC của Signboard.
     *
     * KHÔNG bắt buộc: bỏ trống thì cột PIC luôn rỗng và không tốn lời gọi Jira
     * nào. Khai vào thì mã field phải tồn tại thật, nếu không sẽ chặn khởi động
     * y như hai field ngày (để bắt lỗi gõ sai mã ngay, không im lặng).
     */
    requestParticipants: z.string().min(1).optional(),
  }),
});

export type FieldMappingConfig = z.infer<typeof fieldMappingConfigSchema>;

export interface ResolvedFieldMapping {
  readonly wbsStartDate: string;
  readonly wbsEndDate: string;
  /** `undefined` khi chưa khai — cột PIC tắt. */
  readonly requestParticipants?: string;
}

/** Một người trong "Request participants" của một issue. */
export interface JiraParticipantRef {
  readonly accountId: string;
  /** Tên hiển thị nếu field trả kèm; `null` khi field CHỈ có accountId. */
  readonly displayName: string | null;
}

/** Kiểu field Jira được chấp nhận. Sai kiểu là chặn khởi động. */
const ACCEPTED_TYPES = new Set(['date', 'datetime']);

export class FieldMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldMappingError';
  }
}

/**
 * Ánh xạ mã field khai trong file cấu hình sang field thật trên Jira, kiểm tra
 * field tồn tại và đúng kiểu ngày.
 *
 * CHẶN KHỞI ĐỘNG khi field không tồn tại hoặc sai kiểu. Cám dỗ lớn ở đây là
 * thấy field không có thì trả `null` rồi chạy tiếp — đừng. Toàn bộ Phase sẽ mất
 * đường Kế hoạch mà không ai biết nguyên nhân (PRD E-23). Thà không chạy còn hơn
 * chạy rồi cho ra số sai (CONVENTIONS.md C-9).
 */
export function resolveFieldMapping(
  config: FieldMappingConfig,
  fields: readonly JiraField[],
): ResolvedFieldMapping {
  const resolveOne = (id: string, label: string): string => {
    const field = fields.find((f) => f.id === id);
    if (!field) {
      const gợiÝ = fields
        .filter((f) => f.custom)
        .slice(0, 8)
        .map((f) => `${f.id} (${f.name})`)
        .join(', ');
      throw new FieldMappingError(
        `${label}: không tìm thấy field "${id}" trên Jira. ` +
          `Sửa config/jira-fields.yaml. Một vài custom field đang có: ${gợiÝ}`,
      );
    }

    const type = field.schema?.type;
    if (!type || !ACCEPTED_TYPES.has(type)) {
      throw new FieldMappingError(
        `${label}: field "${id}" (${field.name}) có kiểu "${type ?? 'không rõ'}", ` +
          `phải là date hoặc datetime. Ánh xạ nhầm sang field kiểu khác sẽ khiến ` +
          `mọi Sub-task đọc ra ngày null và toàn bộ Phase mất đường Kế hoạch.`,
      );
    }

    return id;
  };

  /**
   * "Request participants" KHÔNG kiểm kiểu như hai field ngày: nó là field kiểu
   * mảng-user (mỗi Jira một `schema.type` khác nhau: `array`, `user`, hoặc kiểu
   * tuỳ biến của JSM). Chỉ kiểm field CÓ TỒN TẠI để bắt lỗi gõ sai mã; kiểu để
   * `readRequestParticipants` xử lý mềm dẻo lúc đọc.
   */
  const resolveParticipants = (id: string): string => {
    const field = fields.find((f) => f.id === id);
    if (!field) {
      const gợiÝ = fields
        .filter((f) => f.custom)
        .slice(0, 8)
        .map((f) => `${f.id} (${f.name})`)
        .join(', ');
      throw new FieldMappingError(
        `requestParticipants: không tìm thấy field "${id}" trên Jira. ` +
          `Sửa config/jira-fields.yaml (hoặc để trống để tắt cột PIC). ` +
          `Một vài custom field đang có: ${gợiÝ}`,
      );
    }
    return id;
  };

  return {
    wbsStartDate: resolveOne(config.fieldMapping.wbsStartDate, 'wbs_start_date'),
    wbsEndDate: resolveOne(config.fieldMapping.wbsEndDate, 'wbs_end_date'),
    ...(config.fieldMapping.requestParticipants !== undefined
      ? { requestParticipants: resolveParticipants(config.fieldMapping.requestParticipants) }
      : {}),
  };
}

/**
 * Đọc "Request participants" của một issue thành danh sách user, BỎ TRÙNG theo
 * `accountId`.
 *
 * Trường này lỏng lẻo về hình dạng nên đọc mềm dẻo (CONVENTIONS.md C-10 — không
 * đoán bừa, nhưng cũng không nổ vì dữ liệu lạ):
 *   - mảng object user đầy đủ: `[{ accountId, displayName, … }]`
 *   - mảng CHỈ accountId (chuỗi): `["5b10…", "6c20…"]` — một số Jira/automation
 *     lưu vậy; khi đó `displayName` là `null`, tra thêm bằng `getUsersByAccountIds`.
 * Thiếu field, không phải mảng, hay phần tử rác đều bỏ qua chứ không ném lỗi.
 */
export function readRequestParticipants(
  issue: JiraIssue,
  mapping: Pick<ResolvedFieldMapping, 'requestParticipants'>,
): JiraParticipantRef[] {
  if (mapping.requestParticipants === undefined) return [];
  const raw = issue.fields[mapping.requestParticipants];
  if (!Array.isArray(raw)) return [];

  const out: JiraParticipantRef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const ref = toParticipantRef(entry);
    if (ref === null || seen.has(ref.accountId)) continue;
    seen.add(ref.accountId);
    out.push(ref);
  }
  return out;
}

function toParticipantRef(entry: unknown): JiraParticipantRef | null {
  if (typeof entry === 'string') {
    const id = entry.trim();
    return id === '' ? null : { accountId: id, displayName: null };
  }
  if (entry !== null && typeof entry === 'object') {
    const o = entry as { accountId?: unknown; displayName?: unknown };
    const id = typeof o.accountId === 'string' ? o.accountId.trim() : '';
    if (id === '') return null;
    const name =
      typeof o.displayName === 'string' && o.displayName.trim() !== '' ? o.displayName : null;
    return { accountId: id, displayName: name };
  }
  return null;
}

/**
 * Đọc ngày kế hoạch của một issue.
 *
 * Trả `'YYYY-MM-DD'` hoặc `null`. KHÔNG đoán bừa khi thiếu (CONVENTIONS.md C-10).
 *
 * Field kiểu `date` trả `'2026-03-09'`; kiểu `datetime` trả
 * `'2026-03-09T00:00:00.000+0900'`. Cắt phần ngày theo MÚI GIỜ TRONG CHUỖI —
 * đổi sang UTC trước rồi mới cắt sẽ lệch một ngày với issue tạo lúc nửa đêm.
 */
export function readWbsDates(
  issue: JiraIssue,
  mapping: Pick<ResolvedFieldMapping, 'wbsStartDate' | 'wbsEndDate'>,
): { start: string | null; end: string | null } {
  return {
    start: toDateOnly(issue.fields[mapping.wbsStartDate]),
    end: toDateOnly(issue.fields[mapping.wbsEndDate]),
  };
}

export function toDateOnly(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return m ? m[1]! : null;
}

/** Danh sách mã field để truyền vào tham số `fields=` của `POST /search`. */
export function fieldIdsForSearch(mapping: ResolvedFieldMapping): string[] {
  const ids = [mapping.wbsStartDate, mapping.wbsEndDate];
  // Chỉ kéo thêm "Request participants" khi đã khai — không khai thì khỏi tốn
  // dung lượng phản hồi cho field không dùng tới.
  if (mapping.requestParticipants !== undefined) ids.push(mapping.requestParticipants);
  return ids;
}
