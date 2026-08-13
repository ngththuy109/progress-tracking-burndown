import { describe, it, expect } from 'vitest';
import {
  resolveFieldMapping,
  readWbsDates,
  readRequestParticipants,
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
  { id: 'customfield_10400', name: 'Request participants', custom: true, schema: { type: 'array' } },
];

const baseConfig = (over: Partial<FieldMappingConfig['fieldMapping']> = {}): FieldMappingConfig =>
  fieldMappingConfigSchema.parse({
    fieldMapping: {
      wbsStartDate: 'customfield_10100',
      wbsEndDate: 'customfield_10101',
      ...over,
    },
  });

describe('đọc cấu hình field mapping', () => {
  it('đọc được mã field khai trong file cấu hình', () => {
    const r = resolveFieldMapping(baseConfig(), FIELDS);
    expect(r.wbsStartDate).toBe('customfield_10100');
    expect(r.wbsEndDate).toBe('customfield_10101');
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

describe('field Request participants (tuỳ chọn)', () => {
  it('không khai thì requestParticipants là undefined — cột PIC tắt', () => {
    const r = resolveFieldMapping(baseConfig(), FIELDS);
    expect(r.requestParticipants).toBeUndefined();
  });

  it('khai đúng mã thì resolve ra mã field, KHÔNG kiểm kiểu (mảng-user)', () => {
    const r = resolveFieldMapping(baseConfig({ requestParticipants: 'customfield_10400' }), FIELDS);
    expect(r.requestParticipants).toBe('customfield_10400');
  });

  it('khai mã không tồn tại thì CHẶN khởi động và gợi ý field gần đúng', () => {
    expect(() =>
      resolveFieldMapping(baseConfig({ requestParticipants: 'customfield_99999' }), FIELDS),
    ).toThrow(FieldMappingError);
  });
});

describe('đọc Request participants từ issue', () => {
  const mapping = { requestParticipants: 'customfield_10400' };
  const issue = (fields: Record<string, unknown>): JiraIssue => ({ id: '1', key: 'PAY-1', fields });

  it('mảng object user đầy đủ → giữ accountId + displayName', () => {
    const r = readRequestParticipants(
      issue({
        customfield_10400: [
          { accountId: 'u1', displayName: 'Nguyễn An' },
          { accountId: 'u2', displayName: 'Trần Bình' },
        ],
      }),
      mapping,
    );
    expect(r).toEqual([
      { accountId: 'u1', displayName: 'Nguyễn An' },
      { accountId: 'u2', displayName: 'Trần Bình' },
    ]);
  });

  it('mảng CHỈ accountId (chuỗi) → displayName null để tra thêm sau', () => {
    const r = readRequestParticipants(issue({ customfield_10400: ['u1', 'u2'] }), mapping);
    expect(r).toEqual([
      { accountId: 'u1', displayName: null },
      { accountId: 'u2', displayName: null },
    ]);
  });

  it('bỏ trùng theo accountId ngay trong một issue', () => {
    const r = readRequestParticipants(
      issue({
        customfield_10400: [
          { accountId: 'u1', displayName: 'An' },
          { accountId: 'u1', displayName: 'An' },
        ],
      }),
      mapping,
    );
    expect(r).toEqual([{ accountId: 'u1', displayName: 'An' }]);
  });

  it('displayName rỗng/thiếu coi như null', () => {
    const r = readRequestParticipants(
      issue({ customfield_10400: [{ accountId: 'u1', displayName: '   ' }, { accountId: 'u2' }] }),
      mapping,
    );
    expect(r).toEqual([
      { accountId: 'u1', displayName: null },
      { accountId: 'u2', displayName: null },
    ]);
  });

  it('field vắng, không phải mảng, hay phần tử rác đều trả rỗng/bỏ qua, không ném lỗi', () => {
    expect(readRequestParticipants(issue({}), mapping)).toEqual([]);
    expect(readRequestParticipants(issue({ customfield_10400: 'không phải mảng' }), mapping)).toEqual([]);
    expect(
      readRequestParticipants(issue({ customfield_10400: [null, 42, { noId: true }, ''] }), mapping),
    ).toEqual([]);
  });

  it('field chưa cấu hình (undefined) thì luôn trả rỗng', () => {
    expect(readRequestParticipants(issue({ customfield_10400: ['u1'] }), {})).toEqual([]);
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
