import { describe, it, expect } from 'vitest';
import { isIssueDoesNotExistError, JiraHttpError, JiraRequestTimeoutError, withRetry } from './retry.js';

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

/**
 * Request Jira treo (server bắt tay TCP nhưng không trả byte) từng để cả job chờ
 * MÃI. `client.ts` gắn hạn rồi ném `JiraRequestTimeoutError`; ở đây kiểm chứng
 * `withRetry` coi lỗi đó ĐÁNG thử lại (như 5xx) nhưng vẫn có trần lần thử.
 */
describe('withRetry với request treo (JiraRequestTimeoutError)', () => {
  it('thử lại rồi ném hẳn nếu vẫn treo — dùng công thức lùi vì không có Retry-After', async () => {
    let calls = 0;
    const waits: number[] = [];
    const fn = async (): Promise<never> => {
      calls++;
      throw new JiraRequestTimeoutError('https://x.atlassian.net/rest/api/3/status', 5);
    };

    await expect(
      withRetry(fn, {
        sleep: async (ms) => {
          waits.push(ms);
        },
        random: () => 0,
      }),
    ).rejects.toBeInstanceOf(JiraRequestTimeoutError);

    expect(calls).toBe(6); // 1 lần đầu + 5 lần thử lại
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it('treo TẠM THỜI rồi hồi phục thì KHÔNG ném — trả kết quả thật, không đổ cả job', async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls++;
      if (calls <= 2) throw new JiraRequestTimeoutError('https://x/rest', 5);
      return 'ok';
    };

    const result = await withRetry(fn, { sleep: async () => {}, random: () => 0 });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });
});
