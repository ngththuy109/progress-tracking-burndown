import { describe, expect, it } from 'vitest';
import { ApiError, type ApiErrorIssue } from '../../api/client.js';
import { indexIssues, issuesOf } from './field-errors.js';

const issue = (path: string | null, code = 'X', level: 'ERROR' | 'WARNING' = 'ERROR'): ApiErrorIssue => ({
  level,
  code,
  message: `lỗi ${code}`,
  path,
});

describe('indexIssues', () => {
  it('neo lỗi vào đúng đường dẫn máy chủ trả về', () => {
    const index = indexIssues([issue('matchRules[0].phaseCode', 'ORPHAN_PHASE_CODE')]);

    expect(index.at('matchRules[0].phaseCode')).toHaveLength(1);
    expect(index.at('matchRules[1].phaseCode')).toHaveLength(0);
  });

  it('atRow gom mọi lỗi của cùng một dòng, dù lỗi ở trường nào', () => {
    // PM cần thấy cả hai lỗi ngay tại dòng đó, không phải đi tìm từng trường.
    const index = indexIssues([
      issue('matchRules[0].phaseCode', 'ORPHAN_PHASE_CODE'),
      issue('matchRules[0].keyword', 'REGEX_INVALID'),
      issue('matchRules[1].keyword', 'REGEX_TOO_LONG'),
    ]);

    expect(index.atRow('matchRules', 0)).toHaveLength(2);
    expect(index.atRow('matchRules', 1)).toHaveLength(1);
  });

  it('KHÔNG lẫn dòng 1 sang dòng 10', () => {
    // Nếu so bằng `startsWith('matchRules[1]')` mà quên dấu chấm thì
    // `matchRules[10].keyword` cũng khớp — lỗi hiện sai dòng, PM sửa nhầm chỗ.
    const index = indexIssues([issue('matchRules[10].keyword')]);

    expect(index.atRow('matchRules', 1)).toHaveLength(0);
    expect(index.atRow('matchRules', 10)).toHaveLength(1);
  });

  it('lỗi neo thẳng vào cả khu (không có chỉ số dòng) vẫn tra được', () => {
    const index = indexIssues([issue('phaseDefinitions', 'NO_PHASE_DEFINED')]);
    expect(index.at('phaseDefinitions')).toHaveLength(1);
  });

  it('lỗi KHÔNG có path được gom riêng để hiện ở đầu trang', () => {
    // Cảnh báo AMBIGUOUS_PHASE_RULE không có `path`. Bỏ sót nhóm này thì nó
    // biến mất khỏi màn hình mà không ai biết.
    const index = indexIssues([issue(null, 'AMBIGUOUS_PHASE_RULE', 'WARNING')]);

    expect(index.unanchored).toHaveLength(1);
    expect(index.hasBlocking).toBe(false);
  });

  it('hasBlocking chỉ tính lỗi mức ERROR', () => {
    expect(indexIssues([issue('x', 'A', 'WARNING')]).hasBlocking).toBe(false);
    expect(indexIssues([issue('x', 'A', 'ERROR')]).hasBlocking).toBe(true);
  });
});

describe('issuesOf', () => {
  it('bóc danh sách từ ApiError', () => {
    const error = new ApiError({
      code: 'CONFIG_INVALID',
      message: 'không hợp lệ',
      status: 400,
      issues: [issue('matchRules[0].phaseCode')],
    });
    expect(issuesOf(error)).toHaveLength(1);
  });

  it('lỗi mạng không có issues thì trả rỗng, để màn hình rơi về ErrorState chung', () => {
    expect(issuesOf(new ApiError({ code: 'NETWORK', message: 'mất mạng', status: null }))).toEqual([]);
    expect(issuesOf(new Error('gì đó'))).toEqual([]);
  });
});
