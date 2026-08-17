import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// Cột không có task thì API không dựng — bảng phải chịu được nhóm LỆCH số cột
// ---------------------------------------------------------------------------

const emptyCell: SignboardCell = { present: false };

/**
 * Hai Sub-phase với số cột KHÁC nhau: `Design` còn Create + Review, `Coding` chỉ
 * còn Create (cột Review của Coding không có task nào nên API không dựng).
 */
const BOARD_RAGGED: SignboardResponse = {
  ...BOARD,
  columnGroups: [
    {
      subPhaseKey: 'design',
      subPhaseLabel: 'Design',
      taskColumns: [
        { taskCode: 'CREATE', label: 'Create' },
        { taskCode: 'REVIEW', label: 'Review' },
      ],
    },
    { subPhaseKey: 'coding', subPhaseLabel: 'Coding', taskColumns: [{ taskCode: 'CREATE', label: 'Create' }] },
  ],
  columns: [
    { taskCode: 'CREATE', label: 'Create', subPhaseKey: 'design' },
    { taskCode: 'REVIEW', label: 'Review', subPhaseKey: 'design' },
    { taskCode: 'CREATE', label: 'Create', subPhaseKey: 'coding' },
  ],
  rows: [
    {
      functionKey: 'login',
      functionName: 'Login',
      pics: [],
      cells: [lateCell, emptyCell, doneCell],
      subtotals: [lateCell, doneCell],
      total: lateCell,
    },
  ],
  summary: { byStatus: { DELAY_END: 1, COMPLETED: 1 }, emptyCells: 1, totalCells: 3 },
};

/** Không cột nào còn task — API trả về bảng KHÔNG có nhóm cột nào. */
const BOARD_NO_COLUMNS: SignboardResponse = {
  ...BOARD,
  columnGroups: [],
  columns: [],
  rows: [
    { functionKey: 'login', functionName: 'Login', pics: [], cells: [], subtotals: [], total: emptyCell },
  ],
  summary: { byStatus: {}, emptyCells: 0, totalCells: 0 },
};

function stubBoard(board: SignboardResponse): void {
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
              ? board
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

describe('SignboardScreen — nhóm Sub-phase lệch số cột', () => {
  it('vẽ đúng cột của TỪNG nhóm, ô vẫn khớp cột dù nhóm sau ít cột hơn', async () => {
    stubBoard(BOARD_RAGGED);
    renderAt('/signboard?epic=PAY-1&phase=DESIGN');

    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());

    // Tầng 2 của header: Create + Review + Σ (nhóm Design), rồi Create + Σ (nhóm Coding).
    const headerRows = screen.getAllByRole('row').slice(0, 2);
    const level2 = [...headerRows[1]!.querySelectorAll('th')].map((th) => th.textContent);
    expect(level2).toEqual(['Create', 'Review', 'Σ', 'Create', 'Σ']);

    // Hàng Login: ô lá thứ hai (Design/Review) là ô TRỐNG, ô lá thứ ba
    // (Coding/Create) đã Done — offset không được trượt sang nhóm sau.
    const cells = [...screen.getAllByRole('row')[2]!.querySelectorAll('td')];
    expect(cells[1]?.textContent).toContain('Late finish'); // Design/Create
    expect(cells[2]?.className).toContain('signboard__empty'); // Design/Review
    expect(cells[4]?.textContent).toContain('Done'); // Coding/Create
  });

  it('không cột nào còn task thì nói rõ, không vẽ bảng rỗng', async () => {
    stubBoard(BOARD_NO_COLUMNS);
    renderAt('/signboard?epic=PAY-1&phase=DESIGN');

    await waitFor(() => expect(screen.getByText(/No task-type column has any sub-task/)).toBeTruthy());
    expect(screen.queryByRole('table')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Chọn NHIỀU Phase: mỗi bảng rút cột theo dữ liệu của CHÍNH nó
// ---------------------------------------------------------------------------

/** DESIGN còn hai cột: Create + Review. */
const BOARD_DESIGN_WIDE: SignboardResponse = {
  ...BOARD,
  columnGroups: [
    {
      subPhaseKey: '',
      subPhaseLabel: 'Design',
      taskColumns: [
        { taskCode: 'CREATE', label: 'Create' },
        { taskCode: 'REVIEW', label: 'Review' },
      ],
    },
  ],
  columns: [
    { taskCode: 'CREATE', label: 'Create', subPhaseKey: '' },
    { taskCode: 'REVIEW', label: 'Review', subPhaseKey: '' },
  ],
  rows: [
    {
      functionKey: 'login',
      functionName: 'Login',
      pics: [],
      cells: [lateCell, doneCell],
      subtotals: [lateCell],
      total: lateCell,
    },
  ],
  summary: { byStatus: { DELAY_END: 1, COMPLETED: 1 }, emptyCells: 0, totalCells: 2 },
};

/** CODING chỉ có việc ở khâu Review → cột Create của nó bị rút. */
const BOARD_CODING_NARROW: SignboardResponse = {
  ...BOARD,
  phaseCode: 'CODING',
  columnGroups: [
    { subPhaseKey: '', subPhaseLabel: 'Coding', taskColumns: [{ taskCode: 'REVIEW', label: 'Review' }] },
  ],
  columns: [{ taskCode: 'REVIEW', label: 'Review', subPhaseKey: '' }],
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

function stubTwoBoards(): void {
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
              ? BOARD_DESIGN_WIDE
              : url.endsWith('/phase/CODING')
                ? BOARD_CODING_NARROW
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

describe('SignboardScreen — nhiều Phase, mỗi bảng rút cột riêng', () => {
  it('bảng của Phase này KHÔNG mượn cột của Phase kia', async () => {
    // Mỗi Phase là MỘT lần gọi API riêng nên việc rút cột rỗng diễn ra độc lập:
    // DESIGN có việc ở cả Create lẫn Review, CODING chỉ có Review → bảng CODING
    // không được hiện cột Create chỉ vì bảng bên cạnh có.
    stubTwoBoards();
    renderAt('/signboard?epic=PAY-1&phases=DESIGN,CODING');

    await waitFor(() => expect(screen.getByText('Login')).toBeTruthy());
    expect(screen.getByText('Report')).toBeTruthy();

    const design = within(screen.getByLabelText('Phase Thiết kế'));
    const coding = within(screen.getByLabelText('Phase Lập trình'));

    expect(design.getByRole('columnheader', { name: 'Create' })).toBeTruthy();
    expect(design.getByRole('columnheader', { name: 'Review' })).toBeTruthy();

    expect(coding.getByRole('columnheader', { name: 'Review' })).toBeTruthy();
    expect(coding.queryByRole('columnheader', { name: 'Create' })).toBeNull();
  });
});
