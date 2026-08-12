import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackedEpicSummary } from '@app/shared';
import { ProjectScopeProvider } from '../../project/project-context.js';
import { EpicPicker } from './index.js';

/**
 * Bộ chọn Epic dùng chung cho Burndown / Signboard / Phase sub-tasks.
 *
 * Điểm mấu chốt: CHỈ liệt kê Epic đang active, mỗi lựa chọn kèm MÃ ticket +
 * TIÊU ĐỀ, và bấm vào thì báo đúng mã cho màn hình gọi tới.
 */

const epic = (over: Partial<TrackedEpicSummary> = {}): TrackedEpicSummary => ({
  epicKey: 'PAY-1',
  displayName: 'Thanh toán',
  projectKey: 'PAY',
  status: 'ACTIVE',
  timezone: 'Asia/Tokyo',
  calendarId: 'default',
  lastSyncedAt: null,
  lastError: null,
  note: null,
  dataHealth: {
    phaseCount: 3,
    subtaskCount: 12,
    totalEstimateHours: 96,
    missingWbsDateCount: 0,
    unclassifiedTaskCount: 0,
  },
  ...over,
});

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
}

function renderPicker(onSelect: (key: string) => void = () => {}): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {/* Scope dự án cố định — thay cho route /p/:projectKey của app thật. */}
        <ProjectScopeProvider value={{ projectKey: 'PAY', role: 'PM', isAdmin: false }}>
          <EpicPicker
            icon="📉"
            title="Pick an Epic to chart"
            description="Choose an active Epic below."
            onSelect={onSelect}
          />
        </ProjectScopeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EpicPicker', () => {
  it('liệt kê Epic active kèm mã ticket và tiêu đề, và loại Epic không active', async () => {
    stubFetch({
      epics: [
        epic(),
        epic({ epicKey: 'PAY-2', displayName: 'Báo cáo', status: 'ACTIVE' }),
        epic({ epicKey: 'PAY-9', displayName: 'Đang dựng', status: 'BACKFILLING' }),
        epic({ epicKey: 'PAY-8', displayName: 'Đã dừng', status: 'PAUSED' }),
      ],
    });
    renderPicker();

    const first = await screen.findByRole('button', { name: /PAY-1/ });
    expect(first.textContent).toContain('PAY-1');
    expect(first.textContent).toContain('Thanh toán');
    expect(screen.getByRole('button', { name: /PAY-2/ }).textContent).toContain('Báo cáo');

    // Chỉ hai Epic ACTIVE — hai cái BACKFILLING / PAUSED bị loại.
    expect(screen.queryByText('Đang dựng')).toBeNull();
    expect(screen.queryByText('Đã dừng')).toBeNull();
  });

  it('bấm một Epic thì báo đúng mã cho màn hình gọi tới', async () => {
    stubFetch({ epics: [epic()] });
    const onSelect = vi.fn();
    renderPicker(onSelect);

    fireEvent.click(await screen.findByRole('button', { name: /PAY-1/ }));
    expect(onSelect).toHaveBeenCalledWith('PAY-1');
  });

  it('chưa theo dõi Epic nào thì chỉ đường sang màn Epics', async () => {
    stubFetch({ epics: [] });
    renderPicker();

    await waitFor(() => expect(screen.getByText('No Epics tracked yet')).toBeTruthy());
    // Link phải Ở LẠI dự án đang mở — tiền tố /p/<key>.
    expect(screen.getByRole('link', { name: 'Go to Epics' }).getAttribute('href')).toBe('/p/PAY/epics');
  });

  it('có Epic nhưng không cái nào active thì nói rõ và không tự chọn', async () => {
    stubFetch({ epics: [epic({ status: 'PAUSED' }), epic({ epicKey: 'PAY-2', status: 'ERROR' })] });
    renderPicker();

    await waitFor(() => expect(screen.getByText('No active Epics right now')).toBeTruthy());
    // Không dựng nút chọn cho Epic không active.
    expect(screen.queryByRole('button', { name: /PAY-1/ })).toBeNull();
  });

  it('gọi API lỗi thì hiện trạng thái lỗi có nút thử lại', async () => {
    stubFetch({ error: 'BOOM', message: 'server down' }, 500);
    renderPicker();

    await waitFor(() => expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy());
  });
});
