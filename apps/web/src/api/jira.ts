/**
 * Đường dẫn tới ticket trên Jira — dùng để MỞ / COPY link chi tiết ngay từ giao
 * diện (ví dụ ô của bảng Signboard).
 *
 * Đọc `VITE_JIRA_BASE_URL` từ env của Vite. BÌNH THƯỜNG KHÔNG PHẢI ĐẶT TAY: lúc
 * dev/build, `vite.config.ts` tự điền biến này từ `JIRA_BASE_URL` (biến server
 * bắt buộc, vốn đã có) — xem `resolveJiraBaseUrl` ở đó. Vẫn có thể đặt
 * `VITE_JIRA_BASE_URL` tường minh để trỏ sang site khác, hoặc đặt `= ""` để TẮT
 * liên kết — khi đó màn hình vẫn chạy, chỉ copy được MÃ ticket chứ không mở thẳng
 * sang Jira. Cùng cách làm với `signInPath()` (VITE_SIGN_IN_PATH).
 */

/** Base URL của Jira, đã bỏ dấu `/` thừa ở cuối. `''` = chưa cấu hình. */
export function jiraBaseUrl(): string {
  const env: unknown = import.meta.env;
  if (env === null || typeof env !== 'object') return '';
  const value = (env as Record<string, unknown>)['VITE_JIRA_BASE_URL'];
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

/**
 * URL tới màn chi tiết ticket: `<base>/browse/<KEY>`.
 *
 * Hàm THUẦN (không đọc env) để test thẳng. `base` rỗng hoặc `issueKey` rỗng →
 * `null`: chưa cấu hình site thì KHÔNG bịa ra một URL sai dẫn đi đâu không rõ.
 * `issueKey` được mã hoá cho an toàn, phòng khi key mang ký tự lạ.
 */
export function jiraIssueUrl(base: string, issueKey: string): string | null {
  const b = base.trim().replace(/\/+$/, '');
  const key = issueKey.trim();
  if (b === '' || key === '') return null;
  return `${b}/browse/${encodeURIComponent(key)}`;
}
