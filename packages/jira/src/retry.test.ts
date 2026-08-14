import { describe, it, expect } from 'vitest';
import { isIssueDoesNotExistError, JiraHttpError } from './retry.js';

/**
 * `isIssueDoesNotExistError` là bản lề của việc xử lý "Epic đã bị xoá": nhầm thì
 * hoặc để job đổ (không nhận ra key đã mất), hoặc xoá mềm nhầm cả Epic (nhận nhầm
 * một lỗi 400 khác thành "key không tồn tại").
 */
describe('isIssueDoesNotExistError', () => {
  const err = (status: number, body: string): JiraHttpError =>
    new JiraHttpError(status, 'https://x.atlassian.net/rest/api/3/search/jql', body);

  it('nhận đúng 400 "An issue with key ... does not exist"', () => {
    const body = JSON.stringify({
      errorMessages: ["An issue with key 'PAY-100' does not exist for the field 'key'."],
      errors: {},
    });
    expect(isIssueDoesNotExistError(err(400, body))).toBe(true);
  });

  it('nhận cả khi Jira để câu lỗi trong `errors` thay vì `errorMessages`', () => {
    const body = JSON.stringify({
      errorMessages: [],
      errors: { parent: "An issue with key 'PAY-100' does not exist for the field 'parent'." },
    });
    expect(isIssueDoesNotExistError(err(400, body))).toBe(true);
  });

  it('KHÔNG nhận lỗi field cấu hình sai (cũng chứa "does not exist")', () => {
    // Nhầm câu này thành "Epic đã xoá" sẽ xoá mềm nhầm toàn bộ Epic khi thực ra
    // chỉ là jira-fields.yaml trỏ sai field.
    const body = JSON.stringify({
      errorMessages: ["Field 'customfield_9999' does not exist or you do not have permission to view it."],
      errors: {},
    });
    expect(isIssueDoesNotExistError(err(400, body))).toBe(false);
  });

  it('KHÔNG nhận các mã lỗi khác 400 (404/401/500/429)', () => {
    const body = JSON.stringify({ errorMessages: ["An issue with key 'X' does not exist."] });
    for (const status of [401, 404, 429, 500]) {
      expect(isIssueDoesNotExistError(err(status, body))).toBe(false);
    }
  });

  it('KHÔNG nhận thứ không phải JiraHttpError', () => {
    expect(isIssueDoesNotExistError(new Error('boom'))).toBe(false);
    expect(isIssueDoesNotExistError('An issue with key does not exist')).toBe(false);
    expect(isIssueDoesNotExistError(null)).toBe(false);
  });
});
