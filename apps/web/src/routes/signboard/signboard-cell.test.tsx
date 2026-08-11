import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanConflict, SignboardCell } from '@app/shared';
import { cellConflicts, SignboardCellView } from './signboard-cell.js';

/**
 * Cảnh báo plan-ngày nghỉ trên Ô Signboard — T-37 (bổ sung theo yêu cầu PM:
 * nhìn ngay trên bảng dễ hơn mở màn Phase sub-tasks).
 */

const conflict = (issueKey: string, side: 'VN' | 'JP' = 'JP'): PlanConflict => ({
  issueKey,
  summary: 'Review màn hình đăng nhập',
  parentKey: 'PAY-10',
  phaseCode: 'DESIGN',
  taskType: 'JMReview',
  side,
  sideResolved: true,
  violations: [
    { field: 'END', date: '2026-08-11', reason: 'HOLIDAY', holidayLabel: '山の日' },
  ],
});

const cell = (issueKeys: string[]): SignboardCell => ({
  present: true,
  planStart: '2026-08-10',
  planEnd: '2026-08-11',
  actualStart: null,
  actualEnd: null,
  status: 'NYS',
  ticketCount: issueKeys.length,
  tickets: issueKeys.map((issueKey) => ({
    issueKey,
    planStart: '2026-08-10',
    planEnd: '2026-08-11',
    actualStart: null,
    actualEnd: null,
    status: 'NYS',
  })),
});

describe('cellConflicts', () => {
  it('chỉ nhặt vi phạm của ticket NẰM TRONG ô', () => {
    const map = new Map([
      ['PAY-101', conflict('PAY-101')],
      ['PAY-999', conflict('PAY-999')],
    ]);
    const found = cellConflicts(cell(['PAY-101', 'PAY-102']), map);
    expect(found.map((c) => c.issueKey)).toEqual(['PAY-101']);
  });

  it('ô trống không bao giờ có vi phạm', () => {
    expect(cellConflicts({ present: false }, new Map([['X-1', conflict('X-1')]]))).toEqual([]);
  });
});

describe('SignboardCellView', () => {
  it('ô chứa ticket vi phạm hiện badge ⚠ kèm phía, tooltip nói rõ lý do', () => {
    const map = new Map([['PAY-101', conflict('PAY-101')]]);
    render(<SignboardCellView cell={cell(['PAY-101'])} filter={null} conflicts={map} />);

    expect(screen.getByText(/⚠ day off \(JP\)/)).toBeTruthy();
    const tooltip = screen.getByTitle(/山の日/);
    expect(tooltip.getAttribute('title')).toContain('End 2026-08-11 is a JP holiday (山の日)');
  });

  it('không truyền conflicts thì ô hiện như cũ, không có badge ⚠ day off', () => {
    render(<SignboardCellView cell={cell(['PAY-101'])} filter={null} />);
    expect(screen.queryByText(/day off/)).toBeNull();
  });

  it('ô bị làm mờ khi lọc thì không hiện cảnh báo — lọc là để tập trung', () => {
    const map = new Map([['PAY-101', conflict('PAY-101')]]);
    render(
      <SignboardCellView cell={cell(['PAY-101'])} filter="COMPLETED" conflicts={map} />,
    );
    expect(screen.queryByText(/day off/)).toBeNull();
  });

  it('mặc định (không interactive) KHÔNG có nút "Ticket links"', () => {
    render(<SignboardCellView cell={cell(['PAY-101'])} filter={null} />);
    expect(screen.queryByRole('button', { name: /Ticket links/ })).toBeNull();
  });
});

/**
 * Hovercard "mở / copy ticket" — yêu cầu PM: rê vào ô task thì hiện link để copy
 * hoặc mở thẳng ticket chi tiết trên Jira.
 */
describe('SignboardCellView — hovercard mở/copy ticket', () => {
  const writeText = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    writeText.mockClear();
  });

  it('ô interactive có nút mở, bấm ra thẻ với LINK sang Jira (tab mới) + nút Copy link', () => {
    render(
      <SignboardCellView
        cell={cell(['PAY-101'])}
        filter={null}
        interactive
        jiraBaseUrl="https://acme.atlassian.net"
      />,
    );

    // Chưa mở: chưa có link.
    expect(screen.queryByRole('link', { name: /PAY-101/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Ticket links/ }));

    const link = screen.getByRole('link', { name: /PAY-101/ });
    expect(link.getAttribute('href')).toBe('https://acme.atlassian.net/browse/PAY-101');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('button', { name: /Copy link to PAY-101/ })).toBeTruthy();
  });

  it('bấm Copy link chép ĐÚNG URL chi tiết vào clipboard', () => {
    render(
      <SignboardCellView
        cell={cell(['PAY-101'])}
        filter={null}
        interactive
        jiraBaseUrl="https://acme.atlassian.net"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ticket links/ }));
    fireEvent.click(screen.getByRole('button', { name: /Copy link to PAY-101/ }));
    expect(writeText).toHaveBeenCalledWith('https://acme.atlassian.net/browse/PAY-101');
  });

  it('chưa cấu hình site (jiraBaseUrl rỗng): không có link, chỉ Copy MÃ ticket', () => {
    render(<SignboardCellView cell={cell(['PAY-101'])} filter={null} interactive jiraBaseUrl="" />);
    fireEvent.click(screen.getByRole('button', { name: /Ticket links/ }));

    expect(screen.queryByRole('link', { name: /PAY-101/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Copy key PAY-101/ }));
    expect(writeText).toHaveBeenCalledWith('PAY-101');
  });

  it('ô gộp nhiều ticket: thẻ liệt kê đủ từng ticket để mở/copy riêng', () => {
    render(
      <SignboardCellView
        cell={cell(['PAY-101', 'PAY-102'])}
        filter={null}
        interactive
        jiraBaseUrl="https://acme.atlassian.net"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ticket links/ }));

    expect(screen.getByRole('link', { name: /PAY-101/ }).getAttribute('href')).toBe(
      'https://acme.atlassian.net/browse/PAY-101',
    );
    expect(screen.getByRole('link', { name: /PAY-102/ }).getAttribute('href')).toBe(
      'https://acme.atlassian.net/browse/PAY-102',
    );
  });
});
