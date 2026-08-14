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
  // Epic 1 tầng: không có nhóm tầng-1 nào → bộ lọc Giai đoạn phải ẨN.
  stageTierLabel: null,
  stages: [],
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
    {
      functionKey: 'login',
      functionName: 'Login',
      pics: [{ accountId: 'u1', displayName: 'Nguyễn An' }],
      cells: [lateCell],
      subtotals: [lateCell],
      total: lateCell,
    },
    {
      functionKey: 'logout',
      functionName: 'Logout',
      pics: [],
      cells: [doneCell],
      subtotals: [doneCell],
      total: doneCell,
    },
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
      <MemoryRouter initialEntries={['/signboard?epic=PAY-1&phase=DESIGN']}>
        <SignboardScreen />
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

describe('SignboardScreen — cột PIC', () => {
  it('hiện cột PIC kèm tên người phụ trách của Function', async () => {
    stubFetchRouted();
    renderScreen();

    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());

    // Có tiêu đề cột PIC…
    expect(screen.getByRole('columnheader', { name: 'PIC' })).toBeTruthy();
    // …và tên PIC của hàng Login hiện ra (gom từ Request participants).
    expect(screen.getByText('Nguyễn An')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Chọn nhiều Phase + “Whole epic”
// ---------------------------------------------------------------------------

const PHASES_MULTI: SignboardPhasesResponse = {
  epicKey: 'PAY-1',
  phases: [
    { phaseCode: 'DESIGN', label: 'Thiết kế', subtaskCount: 2 },
    { phaseCode: 'CODING', label: 'Lập trình', subtaskCount: 1 },
  ],
  stageTierLabel: null,
  stages: [],
};

const BOARD_CODING: SignboardResponse = {
  ...BOARD,
  phaseCode: 'CODING',
  columnGroups: [
    { subPhaseKey: '', subPhaseLabel: 'Coding', taskColumns: [{ taskCode: 'CREATE', label: 'Create' }] },
  ],
  rows: [
    {
      functionKey: 'report',
      functionName: 'Report',
      pics: [],
      cells: [doneCell],
      subtotals: [doneCell],
      total: doneCell,
    },
  ],
  summary: { byStatus: { COMPLETED: 1 }, emptyCells: 0, totalCells: 1 },
};

/** Định tuyến cho hai Phase DESIGN + CODING trong cùng một Epic. */
function stubMultiRouted(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = url.endsWith('/phases')
        ? PHASES_MULTI
        : url.endsWith('/unparsed')
          ? UNPARSED
          : url.endsWith('/plan-conflicts')
            ? CONFLICTS
            : url.endsWith('/phase/DESIGN')
              ? BOARD
              : url.endsWith('/phase/CODING')
                ? BOARD_CODING
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

function renderAt(initial: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <SignboardScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SignboardScreen — chọn nhiều Phase', () => {
  it('chọn hai Phase thì hiện hai bảng, mỗi bảng có tiêu đề Phase riêng', async () => {
    stubMultiRouted();
    renderAt('/signboard?epic=PAY-1&phases=DESIGN,CODING');

    // Bảng DESIGN có Function Login; bảng CODING có Function Report — hai bảng
    // tách biệt, không trộn số liệu.
    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());
    expect(screen.getByText('Report')).toBeTruthy();

    // Mỗi bảng có tiêu đề Phase (nhãn cấu hình + mã) để biết đang xem bảng nào.
    expect(screen.getByRole('heading', { name: /Thiết kế/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Lập trình/ })).toBeTruthy();
  });

  it('bấm “Whole epic” mở MỌI Phase của Epic', async () => {
    stubMultiRouted();
    renderAt('/signboard?epic=PAY-1');

    // Chưa chọn gì: có lời nhắc chọn Phase và nút “Whole epic”.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Whole epic' })).toBeTruthy());
    expect(screen.getByText(/Pick one or more Phases/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Whole epic' }));

    // Cả hai Phase hiện bảng.
    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());
    expect(screen.getByText('Report')).toBeTruthy();
  });

  it('chọn đúng MỘT Phase (qua nhiều-Phase) KHÔNG thêm tiêu đề — giữ khung nhìn cũ', async () => {
    stubMultiRouted();
    renderAt('/signboard?epic=PAY-1&phases=DESIGN');

    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());
    // Một Phase: không dựng tiêu đề Phase riêng (chỉ bảng trần như trước đây).
    expect(screen.queryByRole('heading', { name: /Thiết kế/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bộ lọc nhóm tầng-1 (Giai đoạn)
// ---------------------------------------------------------------------------

const PHASES_STAGED: SignboardPhasesResponse = {
  epicKey: 'PAY-1',
  phases: [{ phaseCode: 'DESIGN', label: 'Thiết kế', subtaskCount: 2 }],
  stageTierLabel: 'Giai đoạn',
  stages: [
    { code: 'GD1', label: 'Giai đoạn 1', subtaskCount: 9 },
    { code: 'GD2', label: 'Giai đoạn 2', subtaskCount: 4 },
  ],
};

/** Stub nhận biết cả query string — ghi lại `stage` của từng lời gọi. */
function stubStagedRouted(seen: { phasesStages: (string | null)[]; boardStages: (string | null)[] }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(raw, 'http://test.local');
      const stage = u.searchParams.get('stage');
      const body = u.pathname.endsWith('/phases')
        ? (seen.phasesStages.push(stage), PHASES_STAGED)
        : u.pathname.endsWith('/unparsed')
          ? UNPARSED
          : u.pathname.endsWith('/plan-conflicts')
            ? CONFLICTS
            : u.pathname.endsWith('/phase/DESIGN')
              ? (seen.boardStages.push(stage), BOARD)
              : null;
      if (body === null) return Promise.reject(new Error(`no mock for ${raw}`));
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }),
  );
}

describe('SignboardScreen — bộ lọc Giai đoạn', () => {
  it('Epic không có nhóm tầng-1 thì KHÔNG hiện bộ lọc (giữ nguyên UI cũ)', async () => {
    stubFetchRouted(); // PHASES: stages rỗng
    renderScreen();
    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());
    expect(screen.queryByRole('group', { name: /Filter by/ })).toBeNull();
  });

  it('≥2 nhóm: hiện bộ lọc mang tên tầng; bấm một nhóm là mọi request kèm ?stage=', async () => {
    const seen = { phasesStages: [] as (string | null)[], boardStages: [] as (string | null)[] };
    stubStagedRouted(seen);
    renderAt('/signboard?epic=PAY-1&phases=DESIGN');

    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());

    // Bộ lọc hiện, nhãn lấy từ tên tầng PM đặt; nút "All" đang sáng.
    const bar = screen.getByRole('group', { name: 'Filter by Giai đoạn' });
    expect(bar).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    // Lời gọi đầu chưa lọc.
    expect(seen.phasesStages).toContain(null);
    expect(seen.boardStages).toContain(null);

    // Bấm "Giai đoạn 2" → phases + bảng đều gọi lại với ?stage=GD2. Thanh chọn
    // GIỮ NGUYÊN trong lúc tải (keepPreviousData) nên nút vẫn đó và sáng lên.
    fireEvent.click(screen.getByRole('button', { name: /Giai đoạn 2/ }));
    await waitFor(() => expect(seen.boardStages).toContain('GD2'));
    expect(seen.phasesStages).toContain('GD2');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Giai đoạn 2/ }).getAttribute('aria-pressed')).toBe('true'),
    );
  });
});
