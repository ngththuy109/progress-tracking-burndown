import type { ReactNode } from 'react';

/**
 * Trạng thái "không có gì để hiện".
 *
 * Luôn nói được VÌ SAO trống và LÀM GÌ TIẾP. Một màn hình trắng trơn khiến
 * người dùng tưởng hệ thống hỏng, rồi họ tải lại trang năm lần.
 */
export interface EmptyStateProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly icon?: ReactNode;
  /** Nút hoặc liên kết đưa người dùng tới bước tiếp theo. */
  readonly action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="state state--empty">
      {icon !== undefined && (
        <div className="state__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h2 className="state__title">{title}</h2>
      {description !== undefined && <p className="state__description">{description}</p>}
      {action !== undefined && <div className="state__action">{action}</div>}
    </div>
  );
}
