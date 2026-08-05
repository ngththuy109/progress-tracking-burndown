import type { ApiErrorIssue } from '../../api/client.js';

/**
 * Nút đổi thứ tự.
 *
 * CỐ Ý dùng nút lên/xuống chứ không dùng kéo–thả. Ba lý do:
 *   • Kéo–thả không dùng được bằng bàn phím nếu không viết thêm khá nhiều mã.
 *   • Card này tự cảnh báo "kéo thả trên bảng dài dễ mất trạng thái cuộn";
 *     nút bấm không có vấn đề đó.
 *   • Thêm một thư viện kéo–thả cho đúng một thao tác là không đáng.
 *
 * Ký hiệu `≡` trong bản vẽ ở PRD §2.2.4 vẫn giữ, làm chỗ bám mắt cho cả cụm.
 */
export interface MoveButtonsProps {
  readonly label: string;
  readonly index: number;
  readonly total: number;
  readonly onMove: (delta: -1 | 1) => void;
}

export function MoveButtons({ label, index, total, onMove }: MoveButtonsProps) {
  return (
    <span className="move">
      <span className="move__grip" aria-hidden="true">
        ≡
      </span>
      <button
        type="button"
        className="button button--icon"
        disabled={index === 0}
        onClick={() => onMove(-1)}
        aria-label={`Move ${label} up`}
      >
        ↑
      </button>
      <button
        type="button"
        className="button button--icon"
        disabled={index === total - 1}
        onClick={() => onMove(1)}
        aria-label={`Move ${label} down`}
      >
        ↓
      </button>
    </span>
  );
}

/** Danh sách lỗi neo vào một dòng cụ thể. Không có lỗi thì không vẽ gì. */
export function IssueList({ issues }: { readonly issues: readonly ApiErrorIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="issues" role="alert">
      {issues.map((issue, i) => (
        <li key={`${issue.code}-${i}`} className={`issues__item issues__item--${issue.level.toLowerCase()}`}>
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

export function DeleteButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button type="button" className="button button--icon" onClick={onClick} aria-label={`Delete ${label}`}>
      🗑
    </button>
  );
}
