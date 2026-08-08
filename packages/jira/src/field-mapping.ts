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
  }),
});

export type FieldMappingConfig = z.infer<typeof fieldMappingConfigSchema>;

export interface ResolvedFieldMapping {
  readonly wbsStartDate: string;
  readonly wbsEndDate: string;
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

  return {
    wbsStartDate: resolveOne(config.fieldMapping.wbsStartDate, 'wbs_start_date'),
    wbsEndDate: resolveOne(config.fieldMapping.wbsEndDate, 'wbs_end_date'),
  };
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
  return [mapping.wbsStartDate, mapping.wbsEndDate];
}
