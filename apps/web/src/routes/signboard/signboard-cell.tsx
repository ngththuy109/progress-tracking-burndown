import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CellTicket, PlanConflict, SignboardCell, SignboardStatus } from '@app/shared';
import { Badge, type BadgeTone } from '../../components/ui/index.js';
import { jiraIssueUrl } from '../../api/jira.js';
import { conflictText } from '../phase-subtasks/conflict-text.js';

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

/** Ô ĐANG CÓ mặt — nhánh `present: true` của union, đủ trường để dựng hovercard. */
type PresentCell = Extract<SignboardCell, { present: true }>;

/**
 * Vi phạm plan-ngày nghỉ (T-37) của các ticket TRONG một ô.
 *
 * Ô Signboard là nơi PM nhìn ngày kế hoạch nhiều nhất, nên cảnh báo "mốc plan
 * rơi vào ngày nghỉ" phải hiện ngay tại ô — không bắt họ mở màn Phase
 * sub-tasks mới biết. Hàm thuần, tách riêng để test thẳng.
 */
export function cellConflicts(
  cell: SignboardCell,
  conflicts: ReadonlyMap<string, PlanConflict>,
): PlanConflict[] {
  if (!cell.present || conflicts.size === 0) return [];
  const out: PlanConflict[] = [];
  for (const t of cell.tickets) {
    const found = conflicts.get(t.issueKey);
    if (found !== undefined) out.push(found);
  }
  return out;
}

const NO_CONFLICTS: ReadonlyMap<string, PlanConflict> = new Map();

export interface SignboardCellViewProps {
  readonly cell: SignboardCell;
  /** Đang lọc theo trạng thái nào. `null` = không lọc. */
  readonly filter: SignboardStatus | null;
  /** Vi phạm plan-ngày nghỉ theo `issueKey` (T-37). Bỏ trống = không đánh dấu. */
  readonly conflicts?: ReadonlyMap<string, PlanConflict> | undefined;
  /**
   * Bật hovercard "mở / copy ticket" khi rê vào ô (chỉ dùng cho Ô LÁ — ô task
   * thật). Ô Σ và Overall gộp nhiều loại task nên KHÔNG bật: chúng là con số tóm
   * tắt, không phải một việc cụ thể để nhảy sang Jira.
   */
  readonly interactive?: boolean | undefined;
  /** Base URL Jira (VITE_JIRA_BASE_URL). `''` = chưa cấu hình → chỉ copy được mã. */
  readonly jiraBaseUrl?: string | undefined;
}

export function SignboardCellView({
  cell,
  filter,
  conflicts = NO_CONFLICTS,
  interactive = false,
  jiraBaseUrl = '',
}: SignboardCellViewProps) {
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

  const onDaysOff = cellConflicts(cell, conflicts);

  const tooltip = [
    `Planned: ${cell.planStart ?? 'none'} → ${cell.planEnd ?? 'none'}`,
    `Actual: ${cell.actualStart ?? 'not started'} → ${cell.actualEnd ?? 'not finished'}`,
    ...cell.tickets.map((t) => `${t.issueKey}: ${STATUS_LABEL[t.status]}`),
    // Vi phạm plan-ngày nghỉ đi CÙNG tooltip chính: rê chuột một lần đọc được
    // cả trạng thái lẫn lý do ⚠, không phải săn hai chỗ.
    ...onDaysOff.map((c) => `⚠ ${c.issueKey}: ${conflictText(c)}`),
  ].join('\n');

  const className = `cell${cell.status === 'NO_PLAN' ? ' cell--no-plan' : ''}`;

  const inner = (
    <>
      {/* Ô chỉ hiện ngày KẾ HOẠCH; ngày thực tế nằm trong tooltip (§6.1). */}
      <span className="cell__dates">
        {cell.planStart ?? '?'} → {cell.planEnd ?? '?'}
      </span>
      <Badge tone={STATUS_TONE[cell.status]}>
        {cell.status === 'NO_PLAN' ? `⚠ ${STATUS_LABEL[cell.status]}` : STATUS_LABEL[cell.status]}
      </Badge>
      {onDaysOff.length > 0 && (
        <Badge tone="danger">⚠ day off ({onDaysOff.map((c) => c.side).join(', ')})</Badge>
      )}
      {/* Huy hiệu số lượng khi ô gộp nhiều ticket. */}
      {cell.ticketCount > 1 && <span className="cell__count">≡{cell.ticketCount}</span>}
    </>
  );

  // Ô LÁ: bọc thêm hovercard để rê vào là mở/copy được ticket. Hovercard đã mang
  // đủ ngày kế hoạch/thực tế + trạng thái từng ticket + lý do ⚠, nên ô này KHÔNG
  // đặt `title` gốc nữa (tránh hai tooltip chồng nhau).
  if (interactive) {
    return (
      <CellHovercard cell={cell} status={cell.status} className={className} onDaysOff={onDaysOff} jiraBaseUrl={jiraBaseUrl}>
        {inner}
      </CellHovercard>
    );
  }

  return (
    <span className={className} title={tooltip} data-status={cell.status}>
      {inner}
    </span>
  );
}

// --- Hovercard "mở / copy ticket" ------------------------------------------

/** Rê vào phải NGHỈ một nhịp mới mở — quét chuột ngang bảng không bung hàng loạt. */
const HOVER_OPEN_MS = 140;
/** Rời ô có một khoảng ân hạn để kịp đưa chuột sang thẻ mà không bị đóng. */
const HOVER_CLOSE_MS = 140;
/** Khoảng hở giữa ô và thẻ. */
const CARD_GAP = 6;
/** Chừa mép màn hình khi ghim thẻ vào trong khung nhìn. */
const VIEWPORT_MARGIN = 8;

interface CardPosition {
  readonly top: number;
  readonly left: number;
  readonly placement: 'below' | 'above';
}

interface CellHovercardProps {
  readonly cell: PresentCell;
  readonly status: SignboardStatus;
  readonly className: string;
  readonly onDaysOff: readonly PlanConflict[];
  readonly jiraBaseUrl: string;
  readonly children: ReactNode;
}

/**
 * Ô task có thẻ nổi: rê chuột (hoặc bấm nút 🔗) là hiện danh sách ticket kèm nút
 * MỞ (link sang Jira, tab mới) và COPY.
 *
 * Thẻ dựng bằng `position: fixed` + portal ra `document.body` để KHÔNG bị
 * `.table-wrap` (overflow) cắt mất — bảng rất rộng và cuộn được, thẻ absolute
 * thường sẽ bị xén ở hàng cuối. Đổi lại phải tự bám theo cuộn/đổi cỡ.
 */
function CellHovercard({ cell, status, className, onDaysOff, jiraBaseUrl, children }: CellHovercardProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pos, setPos] = useState<CardPosition | null>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cardId = useId();
  const open = hovered || focused;

  const clearTimers = (): void => {
    if (openTimer.current !== undefined) clearTimeout(openTimer.current);
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
  };

  // Chuột: mở sau HOVER_OPEN_MS, đóng sau HOVER_CLOSE_MS. Gắn cho CẢ ô lẫn thẻ để
  // di chuột từ ô sang thẻ không rơi vào "khoảng không" làm đóng mất.
  const onPointerEnter = (): void => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => setHovered(true), HOVER_OPEN_MS);
  };
  const onPointerLeave = (): void => {
    if (openTimer.current !== undefined) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setHovered(false), HOVER_CLOSE_MS);
  };

  // Bàn phím: focus vào là mở ngay, focus rời KHỎI cả ô lẫn thẻ mới đóng.
  const onFocus = (): void => {
    clearTimers();
    setFocused(true);
  };
  const onBlur = (e: { relatedTarget: EventTarget | null }): void => {
    const rt = e.relatedTarget as Node | null;
    if (hostRef.current?.contains(rt) || cardRef.current?.contains(rt)) return;
    setFocused(false);
  };

  const close = (): void => {
    clearTimers();
    setHovered(false);
    setFocused(false);
  };

  useEffect(() => () => clearTimers(), []);

  // Định vị thẻ: mở XUỐNG DƯỚI ô, LẬT LÊN khi chạm mép dưới màn hình, và ghim vào
  // trong khung nhìn theo chiều ngang. Đo lại mỗi khi mở, và bám theo khi cuộn
  // (dùng capture để bắt cả cuộn BÊN TRONG .table-wrap) hoặc đổi cỡ cửa sổ.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = (): void => {
      const host = hostRef.current;
      if (host === null) return;
      const r = host.getBoundingClientRect();
      const card = cardRef.current;
      const cardH = card?.offsetHeight ?? 0;
      const cardW = card?.offsetWidth ?? 0;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = r.bottom + CARD_GAP;
      const flipUp = below + cardH > vh - VIEWPORT_MARGIN && r.top - CARD_GAP - cardH > VIEWPORT_MARGIN;
      const top = flipUp ? r.top - CARD_GAP - cardH : below;
      let left = r.left;
      if (left + cardW > vw - VIEWPORT_MARGIN) left = Math.max(VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - cardW);
      if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
      setPos({ top, left, placement: flipUp ? 'above' : 'below' });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  const keys = cell.tickets.map((t) => t.issueKey);
  const triggerLabel =
    keys.length === 1 ? `Ticket links for ${keys[0]}` : `Ticket links (${keys.length} tickets)`;

  const card =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={cardRef}
            id={cardId}
            role="dialog"
            aria-label={triggerLabel}
            className={`cell-card cell-card--${pos?.placement ?? 'below'}`}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos === null ? 'hidden' : 'visible' }}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                close();
                triggerRef.current?.focus();
              }
            }}
          >
            <div className="cell-card__meta">
              <span>
                Planned: {cell.planStart ?? 'none'} → {cell.planEnd ?? 'none'}
              </span>
              <span>
                Actual: {cell.actualStart ?? 'not started'} → {cell.actualEnd ?? 'not finished'}
              </span>
            </div>
            <ul className="cell-card__tickets">
              {cell.tickets.map((t) => (
                <TicketRow key={t.issueKey} ticket={t} jiraBaseUrl={jiraBaseUrl} />
              ))}
            </ul>
            {onDaysOff.length > 0 && (
              <ul className="cell-card__warnings">
                {onDaysOff.map((c) => (
                  <li key={c.issueKey}>
                    ⚠ {c.issueKey}: {conflictText(c)}
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <span
      ref={hostRef}
      className={`${className} cell--interactive`}
      data-status={status}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          close();
          triggerRef.current?.focus();
        }
      }}
    >
      {children}
      <button
        ref={triggerRef}
        type="button"
        className="cell__more"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={triggerLabel}
        onClick={() => (open ? close() : setFocused(true))}
      >
        <span aria-hidden="true">🔗</span>
      </button>
      {card}
    </span>
  );
}

/**
 * Một dòng ticket trong hovercard: MÃ (là link mở tab mới sang Jira nếu có base
 * URL, không thì hiện thô) + trạng thái + nút COPY.
 *
 * `copied` tự tắt sau ~1,5s để nút phản hồi "đã copy" rồi trở lại — người dùng
 * copy nhiều ticket liên tiếp vẫn thấy rõ lần nào vừa bấm.
 */
function TicketRow({ ticket, jiraBaseUrl }: { readonly ticket: CellTicket; readonly jiraBaseUrl: string }) {
  const url = jiraIssueUrl(jiraBaseUrl, ticket.issueKey);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
    },
    [],
  );

  const onCopy = (): void => {
    // Có site → copy URL đầy đủ (dán vào chat là bấm mở được). Chưa có → copy MÃ.
    const text = url ?? ticket.issueKey;
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard bị chặn (ngữ cảnh không bảo mật…) — im lặng, không làm hỏng thao tác khác */
      },
    );
  };

  return (
    <li className="cell-card__ticket">
      {url === null ? (
        <code className="cell-card__key">{ticket.issueKey}</code>
      ) : (
        <a className="cell-card__key" href={url} target="_blank" rel="noopener noreferrer">
          {ticket.issueKey} <span aria-hidden="true">↗</span>
        </a>
      )}
      <span className="cell-card__status">{STATUS_LABEL[ticket.status]}</span>
      <button
        type="button"
        className="button button--icon cell-card__copy"
        onClick={onCopy}
        aria-label={url === null ? `Copy key ${ticket.issueKey}` : `Copy link to ${ticket.issueKey}`}
      >
        {copied ? 'Copied' : url === null ? 'Copy key' : 'Copy link'}
      </button>
    </li>
  );
}
