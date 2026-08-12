import { useProject } from '../../project/project-context.js';

/**
 * Chọn phạm vi cấu hình: DỰ ÁN ĐANG MỞ hay bộ Mặc định (GLOBAL).
 *
 * Bản multi-tenant: không còn ô gõ tay mã project — dự án lấy thẳng từ URL
 * (`/p/:projectKey`). Nút "Mặc định" chỉ hiện với ADMIN vì bộ Mặc định nay đi
 * qua endpoint quản trị `/api/admin/config/phase...` (API chặn người thường).
 */
export interface ScopePickerProps {
  /** `null` = đang sửa bộ Mặc định (GLOBAL); chuỗi = đang sửa dự án đó. */
  readonly projectKey: string | null;
  readonly onChange: (projectKey: string | null) => void;
  /** Chặn đổi phạm vi khi còn thay đổi chưa lưu. */
  readonly dirty: boolean;
}

export function ScopePicker({ projectKey, onChange, dirty }: ScopePickerProps) {
  const scope = useProject();

  const apply = (next: string | null): void => {
    if (next === projectKey) return;
    if (dirty && !confirmDiscard()) return;
    onChange(next);
  };

  return (
    <div className="scope">
      <span className="scope__label">Scope:</span>

      <button
        type="button"
        className={`button${projectKey !== null ? ' button--primary' : ''}`}
        onClick={() => apply(scope.projectKey)}
      >
        Dự án <code>{scope.projectKey}</code>
      </button>

      {scope.isAdmin && (
        <button
          type="button"
          className={`button${projectKey === null ? ' button--primary' : ''}`}
          title="Bộ quy tắc dùng chung cho mọi dự án chưa ghi đè — chỉ ADMIN sửa được."
          onClick={() => apply(null)}
        >
          Mặc định (mọi dự án)
        </button>
      )}
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
