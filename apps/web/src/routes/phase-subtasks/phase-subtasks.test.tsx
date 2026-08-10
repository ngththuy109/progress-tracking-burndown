import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhaseSubtaskResponse } from '@app/shared';
import { PhaseSubtasksScreen } from './index.js';

const RESPONSE: PhaseSubtaskResponse = {
  epicKey: 'PAY-1',
  totalSubtasks: 3,
  groups: [
    {
      phaseCode: 'DESIGN',
      label: 'Thiết kế',
      colorHex: '#123456',
      isDefined: true,
      subtaskCount: 2,
      tickets: [
        {
          issueKey: 'PAY-11',
          summary: 'Login form',
          parentKey: 'PAY-100',
          statusCategory: 'new',
          planStart: '2026-03-02',
          planEnd: '2026-03-06',
          actualStart: '2026-03-03',
          actualEnd: '2026-03-05',
          originalEstimateHours: 8,
          timeSpentHours: 6.5,
          functionName: 'Login',
          taskType: 'Create',
        },
        {
          issueKey: 'PAY-12',
          summary: 'Logout',
          parentKey: 'PAY-100',
          statusCategory: 'done',
          planStart: null,
          planEnd: null,
          actualStart: null,
          actualEnd: null,
          originalEstimateHours: 1.5,
          timeSpentHours: 0,
          functionName: null,
          taskType: null,
        },
      ],
    },
    {
      phaseCode: 'DEV',
      label: 'Phát triển',
      colorHex: null,
      isDefined: true,
      subtaskCount: 0,
      tickets: [],
    },
    {
      phaseCode: 'UNCLASSIFIED',
      label: null,
      colorHex: null,
      isDefined: false,
      subtaskCount: 1,
      tickets: [
        {
          issueKey: 'PAY-99',
          summary: 'Stray task',
          parentKey: null,
          statusCategory: 'indeterminate',
          planStart: null,
          planEnd: null,
          actualStart: null,
          actualEnd: null,
          originalEstimateHours: 0,
          timeSpentHours: 0,
          functionName: null,
          taskType: null,
        },
      ],
    },
  ],
};

function stubFetch(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
}

function renderScreen(initialEntry: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <PhaseSubtasksScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PhaseSubtasksScreen', () => {
  it('chưa chọn Epic thì nhắc mở từ màn hình Epics', () => {
    renderScreen('/phase-subtasks');
    expect(screen.getByText('No Epic selected')).toBeTruthy();
  });

  it('vẽ từng Phase kèm ticket bên trong', async () => {
    stubFetch(RESPONSE);
    renderScreen('/phase-subtasks?epic=PAY-1');

    // Ticket của Phase DESIGN hiện ra (tên Function/summary nằm ở ô bảng).
    await waitFor(() => expect(screen.getByText('Login form')).toBeTruthy());
    expect(screen.getByText('Logout')).toBeTruthy();
    expect(screen.getByText('Thiết kế')).toBeTruthy();
    // Câu tóm tắt nói rõ số Phase đã định nghĩa (khớp phần đuôi duy nhất, tránh
    // trùng với huy hiệu "not a defined Phase").
    expect(screen.getByText(/across 2 defined Phase/)).toBeTruthy();
  });

  it('hiện ngày thực tế và tổng giờ đã log của từng ticket', async () => {
    stubFetch(RESPONSE);
    renderScreen('/phase-subtasks?epic=PAY-1');

    await waitFor(() => expect(screen.getByText('Login form')).toBeTruthy());
    // Cột Actual: PAY-11 có ngày thực tế; cột Logged (h): 6.5 giờ đã log.
    expect(screen.getByText(/2026-03-03/)).toBeTruthy();
    expect(screen.getByText(/2026-03-05/)).toBeTruthy();
    expect(screen.getByText('6.5')).toBeTruthy();
    expect(screen.getAllByText('Logged (h)').length).toBeGreaterThan(0);
  });

  it('Phase định nghĩa mà chưa có ticket vẫn hiện, kèm dòng giải thích trống', async () => {
    stubFetch(RESPONSE);
    renderScreen('/phase-subtasks?epic=PAY-1');

    await waitFor(() => expect(screen.getByText('Phát triển')).toBeTruthy());
    expect(screen.getByText('No sub-task falls into this Phase yet.')).toBeTruthy();
  });

  it('nhóm ngoài luồng có huy hiệu cảnh báo "not a defined Phase"', async () => {
    stubFetch(RESPONSE);
    renderScreen('/phase-subtasks?epic=PAY-1');

    await waitFor(() => expect(screen.getByText('Stray task')).toBeTruthy());
    expect(screen.getByText('not a defined Phase')).toBeTruthy();
  });
});
