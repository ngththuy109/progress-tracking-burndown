/**
 * Đường dẫn tới ticket trên Jira — dùng để MỞ / COPY link chi tiết ngay từ giao
 * diện (ví dụ ô của bảng Signboard).
 *
 * Frontend KHÔNG biết Jira nằm ở site nào: biến `JIRA_BASE_URL` chỉ có phía
 * server (api/worker). Nên đọc riêng ở Vite qua `VITE_JIRA_BASE_URL`. CHƯA ĐẶT =
 * TẮT liên kết — màn hình vẫn chạy như cũ, chỉ là không dựng được URL nên chỉ
 * copy được MÃ ticket, không mở thẳng sang Jira. Đặt được thì có luôn nút mở/copy
 * URL đầy đủ. Cùng cách làm với `signInPath()` (VITE_SIGN_IN_PATH).
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
