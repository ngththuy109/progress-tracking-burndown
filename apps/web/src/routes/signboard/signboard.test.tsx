import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PlanConflictsResponse,
  SignboardCell,
  SignboardPhasesResponse,
  SignboardResponse,
  UnparsedResponse,
} from '@app/shared';
import { ProjectScopeProvider } from '../../project/project-context.js';
import { SignboardScreen } from './index.js';

/**
 * Nút "Reload" của Signboard — khi đang lọc trạng thái (ví dụ "task trễ") thì
 * bấm Reload phải quay lại khung nhìn ĐẦY ĐỦ, không kẹt lại trong bộ lọc cũ.
 */

const lateCell: SignboardCell = {
  present: true,
  planStart: '2026-08-01',
  planEnd: '2026-08-05',
  actualStart: '2026-08-02',
  actualEnd: null,
  status: 'DELAY_END',
  ticketCount: 1,
  tickets: [
    {
      issueKey: 'PAY-11',
      planStart: '2026-08-01',
      planEnd: '2026-08-05',
      actualStart: '2026-08-02',
      actualEnd: null,
      status: 'DELAY_END',
    },
  ],
};

const doneCell: SignboardCell = {
  present: true,
  planStart: '2026-08-01',
  planEnd: '2026-08-05',
  actualStart: '2026-08-01',
  actualEnd: '2026-08-04',
  status: 'COMPLETED',
  ticketCount: 1,
  tickets: [
    {
      issueKey: 'PAY-12',
      planStart: '2026-08-01',
      planEnd: '2026-08-05',
      actualStart: '2026-08-01',
      actualEnd: '2026-08-04',
      status: 'COMPLETED',
    },
  ],
};

const PHASES: SignboardPhasesResponse = {
  epicKey: 'PAY-1',
  phases: [{ phaseCode: 'DESIGN', label: 'Thiết kế', subtaskCount: 2 }],
};

const BOARD: SignboardResponse = {
  epicKey: 'PAY-1',
  phaseCode: 'DESIGN',
  asOfDate: '2026-08-11',
  columnGroups: [
    { subPhaseKey: '', subPhaseLabel: 'Design', taskColumns: [{ taskCode: 'CREATE', label: 'Create' }] },
  ],
  columns: [{ taskCode: 'CREATE', label: 'Create', subPhaseKey: '' }],
  rows: [
    { functionKey: 'login', functionName: 'Login', cells: [lateCell], subtotals: [lateCell], total: lateCell },
    { functionKey: 'logout', functionName: 'Logout', cells: [doneCell], subtotals: [doneCell], total: doneCell },
  ],
  summary: { byStatus: { DELAY_END: 1, COMPLETED: 1 }, emptyCells: 0, totalCells: 2 },
  parseHealthWarning: false,
};

const UNPARSED: UnparsedResponse = {
  epicKey: 'PAY-1',
  phaseCode: 'DESIGN',
  items: [],
  suggestedColumns: [],
  totalSubtasks: 2,
  parseHealthWarning: false,
};

const CONFLICTS: PlanConflictsResponse = {
  epicKey: 'PAY-1',
  summary: { total: 0, bySide: { VN: 0, JP: 0 }, sideUnknownCount: 0 },
  conflicts: [],
};

/** Trả về đúng body theo đuôi URL — màn hình gọi 4 endpoint khác nhau. */
function stubFetchRouted(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = url.endsWith('/phases')
        ? PHASES
        : url.endsWith('/unparsed')
          ? UNPARSED
          : url.endsWith('/plan-conflicts')
            ? CONFLICTS
            : url.endsWith('/phase/DESIGN')
              ? BOARD
              : null;
      if (body === null) return Promise.reject(new Error(`no mock for ${url}`));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/p/PAY/signboard?epic=PAY-1&phase=DESIGN']}>
        {/* Scope dự án cố định — thay cho route /p/:projectKey của app thật. */}
        <ProjectScopeProvider value={{ projectKey: 'PAY', role: 'PM', isAdmin: false }}>
          <SignboardScreen />
        </ProjectScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SignboardScreen — Reload xoá bộ lọc', () => {
  it('bấm Reload sau khi lọc "task trễ" thì trở lại xem toàn bộ task', async () => {
    stubFetchRouted();
    renderScreen();

    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());
    expect(screen.getByText('Logout')).toBeTruthy();

    // Lọc theo "Late finish" (DELAY_END) — chip trong thanh tóm tắt.
    const lateChip = screen.getByRole('button', { name: /Late finish/ });
    expect(lateChip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(lateChip);

    // Đang lọc: có banner "Filtering by…" và chip được nhấn.
    expect(screen.getByText(/Filtering by/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Late finish/ }).getAttribute('aria-pressed')).toBe('true');

    // Bấm Reload → bộ lọc bị xoá, quay lại khung nhìn đầy đủ.
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(screen.queryByText(/Filtering by/)).toBeNull());
    expect(screen.getByRole('button', { name: /Late finish/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('Reload cũng xoá ô tìm kiếm để hiện lại mọi Function', async () => {
    stubFetchRouted();
    renderScreen();

    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());

    // Tìm "login" → chỉ còn hàng Login, ẩn Logout.
    const searchBox = screen.getByLabelText('Search Functions') as HTMLInputElement;
    fireEvent.change(searchBox, { target: { value: 'login' } });
    expect(screen.queryByText('Logout')).toBeNull();

    // Reload → ô tìm kiếm trống trở lại và Logout hiện lại.
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(screen.getByText('Logout')).toBeTruthy());
    expect((screen.getByLabelText('Search Functions') as HTMLInputElement).value).toBe('');
  });
});

/**
 * Một Sub-phase thì cột Σ (gộp Sub-phase đó) TRÙNG cột "Overall" — hiện cả hai là
 * in "total" hai lần. BOARD ở trên đúng một Sub-phase, nên bảng chỉ được có
 * "Overall", KHÔNG có Σ.
 */
describe('SignboardScreen — một Sub-phase không lặp total', () => {
  it('chỉ hiện cột Overall, KHÔNG hiện thêm cột Σ trùng nó', async () => {
    stubFetchRouted();
    renderScreen();

    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());

    expect(screen.getByRole('columnheader', { name: 'Overall' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Σ' })).toBeNull();
  });
});
