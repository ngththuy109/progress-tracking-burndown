import { Fragment } from 'react';
import { jiraBaseUrl, jiraIssueUrl } from '../../api/jira.js';

/**
 * Mã ticket bấm được — MỞ thẳng sang Jira.
 *
 * Trước đây chỉ ô Signboard mới cho nhảy sang ticket; mọi màn hình khác in mã
 * bằng `<code>` thô, PM phải tự copy rồi dán vào thanh địa chỉ. Component này gom
 * đúng affordance đó lại MỘT chỗ để mọi vị trí đang hiện mã ticket (Epic,
 * Sub-task, Parent, thủ phạm dời plan…) đều mở được ticket chi tiết chỉ bằng một
 * cú bấm — giống hệt link trong ô Signboard.
 *
 * Base URL đọc `VITE_JIRA_BASE_URL` (xem `api/jira.ts`). CHƯA cấu hình site thì
 * hạ về `<code>` thô: KHÔNG bịa ra URL dẫn đi đâu không rõ.
 */

/**
 * Base URL Jira, đọc MỘT lần (biến Vite tĩnh) — giống `JIRA_BASE` ở màn Signboard.
 * `''` = chưa cấu hình → chỉ in mã, không dựng link.
 */
const JIRA_BASE = jiraBaseUrl();

export interface IssueLinkProps {
  /** Mã ticket, ví dụ `PAY-123`. */
  readonly issueKey: string;
  /**
   * Ghi đè base URL — chủ yếu để test. Bỏ trống thì đọc `VITE_JIRA_BASE_URL`
   * (giống mọi chỗ khác trong app).
   */
  readonly baseUrl?: string | undefined;
}

/**
 * Một mã ticket in dạng `<code>`, kèm link mở sang Jira (tab mới) khi đã cấu
 * hình site. Giữ nguyên thẻ `<code>` ở cả hai nhánh để dáng "chip mã" quen thuộc
 * không đổi — chỉ khác là bấm được và có mũi tên ↗ báo "mở ở tab mới".
 */
export function IssueLink({ issueKey, baseUrl = JIRA_BASE }: IssueLinkProps) {
  const url = jiraIssueUrl(baseUrl, issueKey);
  if (url === null) {
    return <code>{issueKey}</code>;
  }
  return (
    <a
      className="issue-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${issueKey} in Jira`}
    >
      <code>{issueKey}</code> <span aria-hidden="true">↗</span>
    </a>
  );
}

export interface IssueKeyListProps {
  /** Danh sách mã ticket. */
  readonly issueKeys: readonly string[];
  /** Ghi đè base URL — chủ yếu để test. */
  readonly baseUrl?: string | undefined;
}

/**
 * Danh sách mã ticket phân tách bằng dấu phẩy, MỖI mã là một link — thay cho
 * `keys.join(', ')` thô ở những chỗ liệt kê nhiều thủ phạm (ví dụ "nguyên nhân
 * dời plan" trên Biểu đồ). Danh sách rỗng → không render gì.
 */
export function IssueKeyList({ issueKeys, baseUrl }: IssueKeyListProps) {
  return (
    <>
      {issueKeys.map((key, i) => (
        <Fragment key={key}>
          {i > 0 ? ', ' : null}
          <IssueLink issueKey={key} baseUrl={baseUrl} />
        </Fragment>
      ))}
    </>
  );
}
