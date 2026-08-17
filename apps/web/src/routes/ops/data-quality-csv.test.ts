import { describe, expect, it } from 'vitest';
import type { DataQualityIssue } from '@app/shared';
import { buildDataQualityCsv, csvFileName } from './data-quality-csv.js';

const ISSUE: DataQualityIssue = {
  issueKey: 'PAY-101',
  epicKey: 'PAY-1',
  epicDisplayName: 'Payment',
  summary: '[PAY][BE][DEV][Login]_Create',
  problems: ['MISSING_ESTIMATE', 'MISSING_WBS_DATE'],
  pics: [{ accountId: 'a1', displayName: 'Nguyễn An' }],
  exempt: false,
  exemptBy: null,
};

describe('buildDataQualityCsv — file gửi cho đội sửa dữ liệu', () => {
  it('mỗi dòng tự đứng được: Epic, ticket, loại lỗi đọc được, trạng thái bỏ qua', () => {
    const csv = buildDataQualityCsv([ISSUE]);
    expect(csv.startsWith('\uFEFF')).toBe(true); // BOM cho Excel
    const lines = csv.replace('\uFEFF', '').trim().split('\r\n');
    expect(lines[0]).toContain('Epic,Epic name,Ticket,Summary,PIC,Problems');
    expect(lines[1]).toContain('PAY-101');
    expect(lines[1]).toContain('Missing estimate; Missing planned dates');
    expect(lines[1]).toContain('no');
  });

  it('cột PIC nói AI phải sửa — nhiều người thì nối bằng "; " để Excel không tách cột', () => {
    const csv = buildDataQualityCsv([
      {
        ...ISSUE,
        pics: [
          { accountId: 'a1', displayName: 'Nguyễn An' },
          { accountId: 'b2', displayName: null },
        ],
      },
    ]);

    expect(csv).toContain(',Nguyễn An; b2,');
  });

  it('ticket chưa gán ai thì ô PIC để TRỐNG, không bịa tên', () => {
    const csv = buildDataQualityCsv([{ ...ISSUE, pics: [] }]);
    const line = csv.replace('\uFEFF', '').trim().split('\r\n')[1] ?? '';

    expect(line).toContain('_Create,,Missing estimate');
  });

  it('summary chứa dấu phẩy/nháy kép được escape đúng RFC 4180', () => {
    const csv = buildDataQualityCsv([
      { ...ISSUE, summary: 'Fix "login", phase 2' },
    ]);
    expect(csv).toContain('"Fix ""login"", phase 2"');
  });

  it('ticket exempt ghi "yes" — file vẫn liệt kê để đối chiếu', () => {
    const csv = buildDataQualityCsv([{ ...ISSUE, exempt: true, exemptBy: 'pm@x.vn' }]);
    expect(csv).toContain('yes');
  });
});

describe('csvFileName', () => {
  it('không chứa dấu hai chấm (Windows từ chối) và mang ngày + Epic đang lọc', () => {
    expect(csvFileName('2026-03-10T02:00:00.000Z', null)).toBe('data-quality-2026-03-10.csv');
    expect(csvFileName('2026-03-10T02:00:00.000Z', 'PAY-1')).toBe('data-quality-PAY-1-2026-03-10.csv');
  });
});
