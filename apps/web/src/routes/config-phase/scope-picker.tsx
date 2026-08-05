import { useState } from 'react';

/**
 * Chọn phạm vi: bộ Mặc định hay một project cụ thể.
 *
 * Ô project là ô GÕ TAY chứ không phải danh sách thả xuống, vì hiện chưa có
 * endpoint nào trả về danh sách project. Gõ sai mã thì API trả về bộ Mặc định
 * đã gộp kế thừa — không hỏng gì, nhưng cũng không rõ ràng. Có danh sách project
 * rồi thì thay ô này bằng `<select>` là xong.
 */
export interface ScopePickerProps {
  readonly projectKey: string | null;
  readonly onChange: (projectKey: string | null) => void;
  /** Chặn đổi phạm vi khi còn thay đổi chưa lưu. */
  readonly dirty: boolean;
}

export function ScopePicker({ projectKey, onChange, dirty }: ScopePickerProps) {
  const [text, setText] = useState(projectKey ?? '');

  const apply = (next: string | null): void => {
    if (dirty && !confirmDiscard()) return;
    onChange(next);
  };

  return (
    <div className="scope">
      <span className="scope__label">Scope:</span>

      <button
        type="button"
        className={`button${projectKey === null ? ' button--primary' : ''}`}
        onClick={() => apply(null)}
      >
        Default
      </button>

      <input
        className="input input--code"
        value={text}
        placeholder="Project key, e.g. PAY"
        aria-label="Project key"
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="button"
        className={`button${projectKey !== null ? ' button--primary' : ''}`}
        disabled={text.trim() === ''}
        onClick={() => apply(text.trim())}
      >
        Open project
      </button>
    </div>
  );
}

/**
 * Hỏi trước khi bỏ thay đổi chưa lưu.
 *
 * Tách thành hàm riêng để test thay được — `window.confirm` trong test sẽ treo
 * và không có gì nói cho ta biết vì sao.
 */
export function confirmDiscard(): boolean {
  return globalThis.confirm('You have unsaved changes. Switching scope will discard them. Continue?');
}
