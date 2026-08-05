import type { SignboardCell, SignboardStatus } from '@app/shared';
import { Badge, type BadgeTone } from '../../components/ui/index.js';

/**
 * Một ô của bảng Signboard — PRD §6.3.
 *
 * MÀU KHÔNG ĐƯỢC LÀ THỨ DUY NHẤT MANG NGHĨA. Khoảng 8% nam giới không phân biệt
 * được đỏ với xanh lá, và bản in đen trắng thì mất sạch màu. Mỗi ô đều có **chữ**
 * nói lên trạng thái, màu chỉ để nhìn cho nhanh.
 */

export const STATUS_TONE: Readonly<Record<SignboardStatus, BadgeTone>> = {
  COMPLETED: 'success',
  ON_SCHEDULE: 'info',
  NYS: 'neutral',
  DELAY_START: 'warning',
  DELAY_END: 'danger',
  NO_PLAN: 'muted',
};

export const STATUS_LABEL: Readonly<Record<SignboardStatus, string>> = {
  COMPLETED: 'Done',
  ON_SCHEDULE: 'On schedule',
  NYS: 'Not started yet',
  DELAY_START: 'Late start',
  DELAY_END: 'Late finish',
  NO_PLAN: 'No planned dates',
};

export interface SignboardCellViewProps {
  readonly cell: SignboardCell;
  /** Đang lọc theo trạng thái nào. `null` = không lọc. */
  readonly filter: SignboardStatus | null;
}

export function SignboardCellView({ cell, filter }: SignboardCellViewProps) {
  if (!cell.present) {
    // Ô TRỐNG: Function này vốn không có khâu đó. KHÁC HẲN `NO_PLAN` (có ticket
    // nhưng thiếu ngày). Trộn hai thứ làm thanh tóm tắt đếm sai (§6.5).
    return (
      <span className="cell cell--empty" title="This Function has no such step">
        —
      </span>
    );
  }

  if (filter !== null && cell.status !== filter) {
    return <span className="cell cell--dimmed">·</span>;
  }

  const tooltip = [
    `Planned: ${cell.planStart ?? 'none'} → ${cell.planEnd ?? 'none'}`,
    `Actual: ${cell.actualStart ?? 'not started'} → ${cell.actualEnd ?? 'not finished'}`,
    ...cell.tickets.map((t) => `${t.issueKey}: ${STATUS_LABEL[t.status]}`),
  ].join('\n');

  return (
    <span
      className={`cell${cell.status === 'NO_PLAN' ? ' cell--no-plan' : ''}`}
      title={tooltip}
      data-status={cell.status}
    >
      {/* Ô chỉ hiện ngày KẾ HOẠCH; ngày thực tế nằm trong tooltip (§6.1). */}
      <span className="cell__dates">
        {cell.planStart ?? '?'} → {cell.planEnd ?? '?'}
      </span>
      <Badge tone={STATUS_TONE[cell.status]}>
        {cell.status === 'NO_PLAN' ? `⚠ ${STATUS_LABEL[cell.status]}` : STATUS_LABEL[cell.status]}
      </Badge>
      {/* Huy hiệu số lượng khi ô gộp nhiều ticket. */}
      {cell.ticketCount > 1 && <span className="cell__count">≡{cell.ticketCount}</span>}
    </span>
  );
}
