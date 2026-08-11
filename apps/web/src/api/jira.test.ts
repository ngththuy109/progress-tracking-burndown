import { describe, expect, it } from 'vitest';
import { jiraBaseUrl, jiraIssueUrl } from './jira.js';

/**
 * `jiraIssueUrl` dựng link `/browse/<KEY>` — nút "mở ticket chi tiết" của ô
 * Signboard dựa cả vào nó, nên phải chắc: chưa cấu hình site thì trả `null` (để
 * UI lùi về chỉ copy MÃ), và không nhân đôi dấu `/`.
 */
describe('jiraIssueUrl', () => {
  it('dựng URL /browse/<KEY> từ base hợp lệ', () => {
    expect(jiraIssueUrl('https://acme.atlassian.net', 'PAY-11')).toBe(
      'https://acme.atlassian.net/browse/PAY-11',
    );
  });

  it('cắt dấu "/" thừa ở cuối base, không tạo "//browse"', () => {
    expect(jiraIssueUrl('https://acme.atlassian.net/', 'PAY-11')).toBe(
      'https://acme.atlassian.net/browse/PAY-11',
    );
  });

  it('base rỗng → null (chưa cấu hình site thì không bịa URL)', () => {
    expect(jiraIssueUrl('', 'PAY-11')).toBeNull();
    expect(jiraIssueUrl('   ', 'PAY-11')).toBeNull();
  });

  it('issueKey rỗng → null', () => {
    expect(jiraIssueUrl('https://acme.atlassian.net', '')).toBeNull();
    expect(jiraIssueUrl('https://acme.atlassian.net', '  ')).toBeNull();
  });

  it('mã hoá ký tự lạ trong key', () => {
    expect(jiraIssueUrl('https://acme.atlassian.net', 'A B/1')).toBe(
      'https://acme.atlassian.net/browse/A%20B%2F1',
    );
  });
});

describe('jiraBaseUrl', () => {
  it('chưa đặt VITE_JIRA_BASE_URL → "" (tắt liên kết)', () => {
    // Test chạy không có biến này → mặc định rỗng, tức chế độ chỉ-copy-mã.
    expect(jiraBaseUrl()).toBe('');
  });
});
