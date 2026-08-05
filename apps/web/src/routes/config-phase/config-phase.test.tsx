import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveConfigResponse } from '@app/shared';
import { ConfigPhaseScreen } from './index.js';
import { draftReducer, loadDraft, type DraftState } from './draft-state.js';
import { indexIssues, NO_ISSUES } from './field-errors.js';
import { MatchRulesSection, RULE_PRIORITY_HINT } from './match-rules-section.js';
import { PHASE_ORDER_HINT, PhaseDefinitionsSection } from './phase-definitions-section.js';

const CONFIG: EffectiveConfigResponse = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[{name}]', sortOrder: 1 }],
  subtaskPatterns: [{ patternText: '[{function}]_{task}', sortOrder: 1 }],
  phaseDefinitions: [
    { phaseCode: 'DESIGN', labelVi: 'Thiết kế', labelJa: '設計', displayOrder: 1 },
    { phaseCode: 'DEV', labelVi: 'Phát triển', labelJa: null, displayOrder: 2 },
  ],
  matchRules: [{ keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 }],
  signboardColumns: [],
  projectKey: null,
  globalVersion: 4,
  projectVersion: null,
  inherited: {
    titlePatterns: false,
    subtaskPatterns: false,
    phaseDefinitions: false,
    matchRules: false,
    signboardColumns: false,
  },
};

const PROJECT_CONFIG: EffectiveConfigResponse = {
  ...CONFIG,
  projectKey: 'SHOP',
  inherited: {
    titlePatterns: true,
    subtaskPatterns: true,
    phaseDefinitions: true,
    matchRules: true,
    signboardColumns: true,
  },
};

/** Khung có state thật, để bấm nút là thấy màn hình đổi. */
function PhaseHarness({ config = CONFIG }: { readonly config?: EffectiveConfigResponse }) {
  const [state, dispatch] = useReducer(draftReducer, config, loadDraft);
  return <PhaseDefinitionsSection state={state} errors={NO_ISSUES} dispatch={dispatch} />;
}

function rulesOf(state: DraftState) {
  return state.draft.matchRules;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nhãn phân biệt display_order và match_priority', () => {
  it('nhãn của hai khu nói rõ đâu là thứ tự hiển thị, đâu là ưu tiên khớp', () => {
    // PRD §2.2.3 dành hẳn một mục cho việc này. Nhãn mập mờ dẫn thẳng tới hiểu
    // nhầm nghiệp vụ: PM kéo đổi thứ tự Phase rồi tưởng mình vừa đổi cách phân
    // loại Task.
    expect(PHASE_ORDER_HINT).toContain('DISPLAY ORDER');
    expect(PHASE_ORDER_HINT).toContain('display_order');
    expect(PHASE_ORDER_HINT).toContain('does not affect');

    expect(RULE_PRIORITY_HINT).toContain('WHEN MATCHING');
    expect(RULE_PRIORITY_HINT).toContain('match_priority');
    expect(RULE_PRIORITY_HINT).toContain('NOT the display order');
  });

  it('hai nhãn hiện thật trên màn hình, không chỉ nằm trong hằng số', () => {
    const state = loadDraft(CONFIG);
    render(
      <>
        <PhaseDefinitionsSection state={state} errors={NO_ISSUES} dispatch={() => {}} />
        <MatchRulesSection state={state} errors={NO_ISSUES} dispatch={() => {}} />
      </>,
    );

    expect(screen.getByText(PHASE_ORDER_HINT)).toBeTruthy();
    expect(screen.getByText(RULE_PRIORITY_HINT)).toBeTruthy();
  });
});

describe('đổi thứ tự trên màn hình', () => {
  it('bấm nút xuống thì hai dòng đổi chỗ', async () => {
    render(<PhaseHarness />);

    await userEvent.click(screen.getByRole('button', { name: 'Move DESIGN down' }));

    const codes = screen.getAllByRole('textbox', { name: /^Phase code/ }) as HTMLInputElement[];
    expect(codes.map((el) => el.value)).toEqual(['DEV', 'DESIGN']);
  });

  it('dòng đầu không lên được, dòng cuối không xuống được', () => {
    render(<PhaseHarness />);

    expect(screen.getByRole('button', { name: 'Move DESIGN up' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Move DEV down' })).toHaveProperty('disabled', true);
  });
});

describe('kế thừa từ bộ Mặc định', () => {
  it('phần đang kế thừa hiện nhãn và nút Ghi đè, các ô bị khoá', () => {
    render(<PhaseHarness config={PROJECT_CONFIG} />);

    expect(screen.getByText(/inherited from the Default set/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Override for project SHOP' })).toBeTruthy();

    const codes = screen.getAllByRole('textbox', { name: /^Phase code/ }) as HTMLInputElement[];
    expect(codes.every((el) => el.disabled)).toBe(true);
  });

  it('bấm Ghi đè thì mở khoá các ô và nhãn biến mất', async () => {
    render(<PhaseHarness config={PROJECT_CONFIG} />);

    await userEvent.click(screen.getByRole('button', { name: 'Override for project SHOP' }));

    expect(screen.queryByText(/inherited from the Default set/)).toBeNull();
    const codes = screen.getAllByRole('textbox', { name: /^Phase code/ }) as HTMLInputElement[];
    expect(codes.every((el) => el.disabled)).toBe(false);
  });

  it('bộ Mặc định không hiện nhãn kế thừa', () => {
    render(<PhaseHarness />);
    expect(screen.queryByText(/inherited from the Default set/)).toBeNull();
  });
});

describe('lỗi neo vào đúng dòng', () => {
  it('lỗi của luật thứ nhất hiện ngay dưới luật đó, không phải banner ở đầu trang', () => {
    const errors = indexIssues([
      {
        level: 'ERROR',
        code: 'ORPHAN_PHASE_CODE',
        message: 'Luật khớp "Design" trỏ tới Phase "GONE" chưa được định nghĩa.',
        path: 'matchRules[0].phaseCode',
      },
    ]);

    render(<MatchRulesSection state={loadDraft(CONFIG)} errors={errors} dispatch={() => {}} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('chưa được định nghĩa');
    // Nằm trong đúng dòng của luật đó, không phải ở đâu đó trên đầu trang.
    expect(alert.closest('li')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Toàn màn hình
// ---------------------------------------------------------------------------

function renderScreen(): void {
  // `retry: false` để test không phải chờ lần thử lại. Bản thật retry một lần
  // (xem `query-client.test.ts`), đó là hành vi được kiểm ở chỗ khác.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<ConfigPhaseScreen />, { wrapper: Wrapper });
}

describe('ConfigPhaseScreen', () => {
  it('API trả lỗi mạng thì hiện ErrorState với nút Thử lại', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Could not load Phase settings');
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('Failed to fetch')).toBeNull();
  });

  it('đọc được cấu hình thì vẽ đủ ba khu và chưa có gì chưa lưu', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(JSON.stringify(url.includes('unmatched') ? { labels: [] } : CONFIG), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );

    renderScreen();

    await waitFor(() => expect(screen.getByText('① Task title patterns')).toBeTruthy());
    expect(screen.getByText('② Phase list')).toBeTruthy();
    expect(screen.getByText('③ Keyword matching rules')).toBeTruthy();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('sửa một ô thì hiện chỉ báo chưa lưu', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(JSON.stringify(url.includes('unmatched') ? { labels: [] } : CONFIG), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );

    renderScreen();
    await waitFor(() => expect(screen.getByText('② Phase list')).toBeTruthy());

    await userEvent.type(screen.getByRole('textbox', { name: 'Vietnamese label, row 1' }), 'X');

    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('KHÔNG gọi API mỗi lần gõ phím — chỉ Xem thử và Lưu mới gọi', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        new Response(JSON.stringify(url.includes('unmatched') ? { labels: [] } : CONFIG), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderScreen();
    await waitFor(() => expect(screen.getByText('② Phase list')).toBeTruthy());

    const callsAfterLoad = fetchMock.mock.calls.length;
    await userEvent.type(screen.getByRole('textbox', { name: 'Vietnamese label, row 1' }), 'Thiết kế lại');

    // 12 ký tự vừa gõ không được sinh thêm request nào.
    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
  });
});

describe('reducer nhìn từ khu luật khớp', () => {
  it('thêm luật từ khu Chưa nhận diện điền sẵn từ khoá', () => {
    const state = draftReducer(loadDraft(CONFIG), { type: 'ADD_RULE', keyword: '結合テスト' });
    expect(rulesOf(state).at(-1)?.keyword).toBe('結合テスト');
  });
});
