import { describe, expect, it } from 'vitest';
import type { MissingDateRow } from '@app/shared';
import {
  buildMissingDatesCsv,
  buildMissingDatesJql,
  csvCell,
  missingDatesCsvFilename,
} from './missing-dates-export.js';

const row = (over: Partial<MissingDateRow> = {}): MissingDateRow => ({
  issueKey: 'PAY-131',
  summary: '[PAY][A][Design][決済履歴]_Create',
  parentKey: 'PAY-101',
  missingStart: true,
  missingEnd: false,
  ...over,
});

describe('buildMissingDatesJql', () => {
  it('không có dòng nào thì trả null — không sinh câu JQL rỗng vô nghĩa', () => {
    expect(buildMissingDatesJql([])).toBeNull();
  });

  it('liệt kê đủ mọi issue key và giữ mệnh đề IS EMPTY cho cả hai field', () => {
    const jql = buildMissingDatesJql([
      row(),
      row({ issueKey: 'PAY-132' }),
      row({ issueKey: 'PAY-133' }),
    ]);
    expect(jql).toBe(
      'issuekey IN (PAY-131, PAY-132, PAY-133) ' +
        'AND ("wbs_start_date" IS EMPTY OR "wbs_end_date" IS EMPTY) ' +
        'ORDER BY key ASC',
    );
  });
});

describe('csvCell', () => {
  it('ô thường giữ nguyên, không bọc nháy thừa', () => {
    expect(csvCell('PAY-131')).toBe('PAY-131');
  });

  it('ô chứa dấu phẩy, nháy kép hoặc xuống dòng được bọc và nhân đôi nháy', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('nói "thật"')).toBe('"nói ""thật"""');
    expect(csvCell('dòng 1\ndòng 2')).toBe('"dòng 1\ndòng 2"');
  });
});

describe('buildMissingDatesCsv', () => {
  it('mở đầu bằng BOM UTF-8 để Excel không vỡ tiếng Việt/tiếng Nhật', () => {
    expect(buildMissingDatesCsv([row()]).startsWith('﻿')).toBe(true);
  });

  it('đủ header, đủ dòng, cờ thiếu ngày ghi yes/no', () => {
    const csv = buildMissingDatesCsv([
      row(),
      row({ issueKey: 'PAY-132', missingStart: false, missingEnd: true }),
    ]);
    const lines = csv.replace('﻿', '').trimEnd().split('\r\n');
    expect(lines).toEqual([
      'issue_key,summary,parent_key,missing_start_date,missing_end_date',
      'PAY-131,[PAY][A][Design][決済履歴]_Create,PAY-101,yes,no',
      'PAY-132,[PAY][A][Design][決済履歴]_Create,PAY-101,no,yes',
    ]);
  });

  it('parentKey null thành ô rỗng, không thành chữ "null"', () => {
    const csv = buildMissingDatesCsv([row({ parentKey: null })]);
    expect(csv).toContain('PAY-131,[PAY][A][Design][決済履歴]_Create,,yes,no');
  });

  it('summary chứa dấu phẩy không làm lệch cột', () => {
    const csv = buildMissingDatesCsv([row({ summary: 'Login, phần backend' })]);
    expect(csv).toContain('PAY-131,"Login, phần backend",PAY-101,yes,no');
  });
});

describe('missingDatesCsvFilename', () => {
  it('tên file mang mã Epic để tải nhiều Epic không đè nhau', () => {
    expect(missingDatesCsvFilename('PAY-100')).toBe('missing-dates-PAY-100.csv');
  });
});
