import { z } from 'zod';
import type { JiraField, JiraIssue } from './endpoints.js';

/**
 * Ánh xạ custom field `wbs_start_date` / `wbs_end_date` — PRD §2.8.
 *
 * Không có card này thì không tổng hợp được ngày Phase (T-15) và không vẽ được
 * đường Kế hoạch (T-16).
 */

export const fieldMappingConfigSchema = z.object({
  fieldMapping: z.object({
    wbsStartDate: z.string().min(1),
    wbsEndDate: z.string().min(1),
  }),
  autoDetect: z
    .object({
      enabled: z.boolean().default(true),
      startDateNames: z.array(z.string()).default([]),
      endDateNames: z.array(z.string()).default([]),
    })
    .default({ enabled: true, startDateNames: [], endDateNames: [] }),
});

export type FieldMappingConfig = z.infer<typeof fieldMappingConfigSchema>;

export interface ResolvedFieldMapping {
  readonly wbsStartDate: string;
  readonly wbsEndDate: string;
  readonly warnings: readonly string[];
}

/** Kiểu field Jira được chấp nhận. Sai kiểu là chặn khởi động. */
const ACCEPTED_TYPES = new Set(['date', 'datetime']);

export class FieldMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldMappingError';
  }
}

/** Chuẩn hoá tên field trước khi so — tên tiếng Nhật hay lẫn toàn giác/bán giác. */
function normalizeName(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Tự dò mã field theo tên (PRD §2.8 bước 2). */
export function detectFieldIds(
  fields: readonly JiraField[],
  names: readonly string[],
): string | undefined {
  const wanted = new Set(names.map(normalizeName));
  return fields.find((f) => wanted.has(normalizeName(f.name)))?.id;
}

/**
 * Quy trình 5 bước của PRD §2.8.
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
  const warnings: string[] = [];

  const resolveOne = (
    declared: string,
    autoNames: readonly string[],
    label: string,
  ): string => {
    const id = declared;

    if (config.autoDetect.enabled && autoNames.length > 0) {
      const detected = detectFieldIds(fields, autoNames);
      if (detected && detected !== declared) {
        warnings.push(
          `${label}: file cấu hình khai "${declared}" nhưng dò được "${detected}". ` +
            `Ưu tiên giá trị trong file. Kiểm tra lại config/jira-fields.yaml.`,
        );
      }
      if (!detected) {
        warnings.push(`${label}: không dò được field nào khớp tên đã khai trong autoDetect.`);
      }
    }

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

  const wbsStartDate = resolveOne(
    config.fieldMapping.wbsStartDate,
    config.autoDetect.startDateNames,
    'wbs_start_date',
  );
  const wbsEndDate = resolveOne(
    config.fieldMapping.wbsEndDate,
    config.autoDetect.endDateNames,
    'wbs_end_date',
  );

  return { wbsStartDate, wbsEndDate, warnings };
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
