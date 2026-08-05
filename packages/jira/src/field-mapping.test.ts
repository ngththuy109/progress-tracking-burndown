import { describe, it, expect } from 'vitest';
import {
  resolveFieldMapping,
  detectFieldIds,
  readWbsDates,
  toDateOnly,
  FieldMappingError,
  fieldMappingConfigSchema,
  type FieldMappingConfig,
} from './field-mapping.js';
import type { JiraField, JiraIssue } from './endpoints.js';

const FIELDS: JiraField[] = [
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
  { id: 'customfield_10100', name: 'wbs_start_date', custom: true, schema: { type: 'date' } },
  { id: 'customfield_10101', name: 'wbs_end_date', custom: true, schema: { type: 'date' } },
  { id: 'customfield_10200', name: '開始日', custom: true, schema: { type: 'datetime' } },
  { id: 'customfield_10300', name: 'Ghi chú', custom: true, schema: { type: 'string' } },
];

const baseConfig = (over: Partial<FieldMappingConfig['fieldMapping']> = {}): FieldMappingConfig =>
  fieldMappingConfigSchema.parse({
    fieldMapping: {
      wbsStartDate: 'customfield_10100',
      wbsEndDate: 'customfield_10101',
      ...over,
    },
    autoDetect: { enabled: false, startDateNames: [], endDateNames: [] },
  });

describe('đọc cấu hình và dò field', () => {
  it('đọc được mã field từ file cấu hình khi tắt tự dò', () => {
    const r = resolveFieldMapping(baseConfig(), FIELDS);
    expect(r.wbsStartDate).toBe('customfield_10100');
    expect(r.wbsEndDate).toBe('customfield_10101');
    expect(r.warnings).toHaveLength(0);
  });

  it('tự dò tìm đúng field theo tên wbs_start_date', () => {
    expect(detectFieldIds(FIELDS, ['wbs_start_date'])).toBe('customfield_10100');
  });

  it('tự dò khớp được tên tiếng Nhật 開始日 dạng toàn giác', () => {
    // Chuỗi tìm dùng ký tự toàn giác khác với chuỗi trong FIELDS sau NFKC
    expect(detectFieldIds(FIELDS, ['開始日'])).toBe('customfield_10200');
  });

  it('tự dò không phân biệt hoa thường và khoảng trắng thừa', () => {
    expect(detectFieldIds(FIELDS, ['  WBS_START_DATE  '])).toBe('customfield_10100');
  });

  it('file và kết quả dò lệch nhau thì ưu tiên file và ghi cảnh báo', () => {
    const cfg = fieldMappingConfigSchema.parse({
      fieldMapping: { wbsStartDate: 'customfield_10100', wbsEndDate: 'customfield_10101' },
      autoDetect: { enabled: true, startDateNames: ['開始日'], endDateNames: [] },
    });

    const r = resolveFieldMapping(cfg, FIELDS);

    expect(r.wbsStartDate).toBe('customfield_10100'); // giá trị trong file thắng
    expect(r.warnings.join(' ')).toMatch(/customfield_10200/);
  });
});

describe('chặn khởi động khi cấu hình sai', () => {
  it('field có kiểu string thay vì date thì CHẶN KHỞI ĐỘNG', () => {
    expect(() => resolveFieldMapping(baseConfig({ wbsStartDate: 'customfield_10300' }), FIELDS))
      .toThrow(FieldMappingError);
  });

  it('thông báo lỗi sai kiểu nói rõ hậu quả để người vận hành hiểu', () => {
    expect(() =>
      resolveFieldMapping(baseConfig({ wbsStartDate: 'customfield_10300' }), FIELDS),
    ).toThrow(/mất đường Kế hoạch/);
  });

  it('không tìm thấy field nào khớp thì chặn khởi động và gợi ý field gần đúng', () => {
    expect(() =>
      resolveFieldMapping(baseConfig({ wbsStartDate: 'customfield_99999' }), FIELDS),
    ).toThrow(/customfield_10100 \(wbs_start_date\)/);
  });

  it('field kiểu datetime được chấp nhận', () => {
    const r = resolveFieldMapping(baseConfig({ wbsStartDate: 'customfield_10200' }), FIELDS);
    expect(r.wbsStartDate).toBe('customfield_10200');
  });
});

describe('đọc giá trị ngày từ issue', () => {
  const mapping = { wbsStartDate: 'customfield_10100', wbsEndDate: 'customfield_10101' };

  const issue = (fields: Record<string, unknown>): JiraIssue => ({
    id: '1',
    key: 'PAY-121',
    fields,
  });

  it('đọc wbs_start_date trả về chuỗi YYYY-MM-DD', () => {
    const r = readWbsDates(
      issue({ customfield_10100: '2026-03-09', customfield_10101: '2026-03-13' }),
      mapping,
    );
    expect(r).toEqual({ start: '2026-03-09', end: '2026-03-13' });
  });

  it('field kiểu datetime thì cắt lấy phần ngày theo múi giờ trong chuỗi', () => {
    // +09:00 — nếu đổi sang UTC trước rồi mới cắt sẽ ra 2026-03-08, lệch một ngày
    expect(toDateOnly('2026-03-09T00:00:00.000+0900')).toBe('2026-03-09');
  });

  it('issue để trống wbs_start_date thì trả null, KHÔNG trả chuỗi rỗng hay ngày hôm nay', () => {
    const r = readWbsDates(issue({ customfield_10100: null, customfield_10101: '' }), mapping);
    expect(r).toEqual({ start: null, end: null });
  });

  it('field không tồn tại trong phản hồi thì trả null', () => {
    expect(readWbsDates(issue({}), mapping)).toEqual({ start: null, end: null });
  });

  it('giá trị rác không phải ngày thì trả null, không ném lỗi', () => {
    expect(toDateOnly('chưa xác định')).toBeNull();
    expect(toDateOnly(12345)).toBeNull();
  });
});
