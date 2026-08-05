import { ApiError, type ApiErrorIssue } from '../../api/client.js';

/**
 * Trạng thái lỗi.
 *
 * Nguyên tắc: người dùng ĐỌC ĐƯỢC dòng đầu tiên. Câu thô của trình duyệt
 * (`Failed to fetch`, `NetworkError when attempting to fetch resource`) không
 * bao giờ được làm dòng chính — nó nằm trong phần "Technical details" đóng sẵn,
 * để dev đọc khi cần.
 */

export interface ErrorDescription {
  readonly code: string;
  /** Câu người dùng đọc được: sai chỗ nào, làm gì tiếp. */
  readonly message: string;
  readonly issues: readonly ApiErrorIssue[];
  /** Nguyên văn lỗi gốc từ trình duyệt. Chỉ hiện trong phần chi tiết. */
  readonly technical: string | null;
}

export function describeError(error: unknown): ErrorDescription {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      issues: error.issues,
      technical: technicalTextOf(error.cause),
    };
  }

  // Lỗi không đi qua lớp API — thường là lỗi lập trình trong component. Người
  // dùng không sửa được, nên đừng bắt họ đọc thông báo thô của trình duyệt.
  return {
    code: 'UNEXPECTED',
    message:
      'Something went wrong on this screen. Reload the page; if it keeps failing, send the technical details below to your dev team.',
    issues: [],
    technical: technicalTextOf(error),
  };
}

function technicalTextOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

export interface ErrorStateProps {
  readonly error: unknown;
  readonly title?: string | undefined;
  /** Có hàm này thì hiện nút "Try again". Không có thì không hiện nút vô nghĩa. */
  readonly onRetry?: (() => void) | undefined;
}

export function ErrorState({ error, title = 'Could not load data', onRetry }: ErrorStateProps) {
  const { code, message, issues, technical } = describeError(error);

  return (
    <div className="state state--error" role="alert">
      <h2 className="state__title">{title}</h2>
      <p className="state__description">{message}</p>

      {issues.length > 0 && (
        <ul className="state__issues">
          {issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`}>
              {issue.path !== null && <code className="state__path">{issue.path}</code>} {issue.message}
            </li>
          ))}
        </ul>
      )}

      <p className="state__code">
        Error code: <code>{code}</code>
      </p>

      {onRetry !== undefined && (
        <div className="state__action">
          <button type="button" className="button button--primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}

      {technical !== null && (
        <details className="state__technical">
          <summary>Technical details</summary>
          <pre>{technical}</pre>
        </details>
      )}
    </div>
  );
}
