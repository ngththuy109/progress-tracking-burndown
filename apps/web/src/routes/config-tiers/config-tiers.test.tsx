import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TiersPreviewResponse } from '@app/shared';
import { TierStructureScreen } from './index.js';

/**
 * Màn "Tier structure" phải đúng BỐ CỤC DEMO ĐÃ CHỐT (docs/dynamic-tiers-demo.html):
 * header "Choose a tier structure type", thanh mở hướng dẫn 7 bước, card
 * "Step 1 · What to track", hàng tầng GỌN có nút Edit ✎, và khung Preview
 * dạng bảng ticket mẫu → group_path. (UI đã chuyển ngữ sang tiếng Anh.)
 */

/** Cấu hình hiệu lực tối thiểu — KHÔNG có tiers ⇒ màn tự suy 1 tầng Phase mirror. */
const EFFECTIVE = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[Phase] {name}', sortOrder: 1 }],
  subtaskPatterns: [],
  phaseDefinitions: [{ phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 1 }],
  matchRules: [],
  signboardColumns: [],
  subPhaseOrders: [],
  projectKey: null,
  globalVersion: 1,
  projectVersion: null,
  inherited: {
    titlePatterns: true,
    subtaskPatterns: true,
    phaseDefinitions: true,
    matchRules: true,
    signboardColumns: true,
    subPhaseOrders: true,
  },
};

const PREVIEW: TiersPreviewResponse = {
  results: [
    {
      taskTitle: '[PAY][offshore_P1]Design',
      parentPhase: 'DESIGN',
      entries: [
        { code: 'GIAI_DOAN', labelVi: 'Giai đoạn', role: 'GROUP', sourceType: 'PARENT_TASK_TITLE', resolved: 'GD1' },
        { code: 'PHASE', labelVi: 'Phase', role: 'PHASE', sourceType: 'PARENT_TASK_TITLE', resolved: 'DESIGN' },
      ],
    },
  ],
};

function stubFetch(seen: { previewBodies: unknown[] }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(raw, 'http://test.local');
      let body: unknown = null;
      if (u.pathname.endsWith('/config/phase')) body = EFFECTIVE;
      if (u.pathname.endsWith('/tiers-preview')) {
        seen.previewBodies.push(JSON.parse(String(init?.body ?? 'null')));
        body = PREVIEW;
      }
      if (body === null) return Promise.reject(new Error(`no mock for ${raw}`));
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }),
  );
}

function renderScreen(): { seen: { previewBodies: unknown[] } } {
  const seen = { previewBodies: [] as unknown[] };
  stubFetch(seen);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/config/tiers']}>
        <TierStructureScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { seen };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TierStructureScreen — bố cục demo đã chốt', () => {
  it('có header "Choose a tier structure type", Bước 1, hàng tầng gọn với Edit ✎', async () => {
    renderScreen();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Choose a tier structure type' })).toBeTruthy(),
    );
    // Bước 1 — card mô tả tracked scope.
    expect(screen.getByRole('heading', { name: 'Tracked scope' })).toBeTruthy();
    expect(screen.getByText('CONTAINER')).toBeTruthy();
    expect(screen.getByText('QUERY')).toBeTruthy();

    // Một tầng Phase mirror: hàng gọn, badge PHASE, và vì nguồn = title Task cha
    // nên "Edit ✎" là LINK sang Phase settings (không mở trình sửa tại chỗ).
    const row = screen.getByRole('listitem', { name: 'Tier 1' });
    expect(within(row).getByText('PHASE')).toBeTruthy();
    const editLink = within(row).getByRole('link', { name: 'Edit ✎' });
    expect(editLink.getAttribute('href')).toBe('/config/phase');
  });

  it('thanh hướng dẫn mở modal 7 bước ngay trong app, đóng được', async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText(/Not sure where to start/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Open the setup guide →' }));
    const dialog = screen.getByRole('dialog', { name: /Setting up the tier configuration/ });
    expect(within(dialog).getByText(/Two different "levels"/)).toBeTruthy();
    expect(within(dialog).getByText(/Golden rule/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close the guide' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Preview: dán nhiều dòng → bảng ticket mẫu → group_path, phần tử Phase có viền', async () => {
    const { seen } = renderScreen();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Sample tickets/ })).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText('Task titles to preview, one ticket per line'), {
      target: { value: '[PAY][offshore_P1]Design\n\n[PAY][offshore_P2]Dev' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() => expect(screen.getByText('GD1')).toBeTruthy());
    // Dòng trống bị bỏ — gửi đúng 2 tiêu đề.
    expect(seen.previewBodies[0]).toMatchObject({
      taskTitles: ['[PAY][offshore_P1]Design', '[PAY][offshore_P2]Dev'],
    });
    // Phần tử tầng Phase mang viền (gp-node--phase) — đúng ký hiệu của demo.
    expect(screen.getByText('DESIGN').className).toContain('gp-node--phase');
    expect(screen.getByText('GD1').className).not.toContain('gp-node--phase');
  });
});
