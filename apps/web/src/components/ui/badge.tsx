import type { ReactNode } from 'react';

/**
 * Nhãn trạng thái có màu.
 *
 * Sáu sắc thái này phủ đúng sáu trạng thái Signboard ở PRD §6.3 — bảng Signboard
 * ở GĐ 4 chỉ việc ánh xạ trạng thái sang sắc thái, không phải thêm màu mới.
 */
export const BADGE_TONES = ['neutral', 'info', 'success', 'warning', 'danger', 'muted'] as const;
export type BadgeTone = (typeof BADGE_TONES)[number];

export interface BadgeProps {
  readonly children: ReactNode;
  readonly tone?: BadgeTone | undefined;
  /** Chữ hiện khi rê chuột — chỗ để giải thích vì sao ra trạng thái này. */
  readonly title?: string | undefined;
}

export function Badge({ children, tone = 'neutral', title }: BadgeProps) {
  return (
    // KHÔNG dùng riêng màu để truyền thông tin: người mù màu và bản in đen
    // trắng đều mất sạch nghĩa. Chữ bên trong nhãn mới là thứ mang nghĩa, màu
    // chỉ để nhìn cho nhanh.
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  );
}
