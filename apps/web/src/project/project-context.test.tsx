import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@app/shared';
import {
  LAST_PROJECT_STORAGE_KEY,
  ProjectProvider,
  projectPath,
  readLastProject,
  useProject,
} from './project-context.js';

/**
 * `ProjectProvider` là hàng rào của mọi trang `/p/:projectKey/...`: đúng quyền
 * thì render và ghi nhớ dự án; sai key/mất quyền thì đá về `/` và DỌN localStorage
 * để không kẹt trong vòng chuyển hướng.
 */

const ME: MeResponse = {
  userId: 'pm@example.com',
  isAdmin: false,
  projects: [
    { projectKey: 'PAY', displayName: 'Payments', role: 'PM' },
    { projectKey: 'CRM', displayName: null, role: 'VIEWER' },
  ],
};

function stubMe(body: MeResponse): void {
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

/** Trang con in ra scope thật — kiểm cả key lẫn role được cung cấp đúng. */
function ScopeProbe() {
  const scope = useProject();
  return (
    <div>
      INSIDE {scope.projectKey} as {scope.role}
    </div>
  );
}

function renderAt(url: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/" element={<div>HOME</div>} />
          <Route path="p/:projectKey" element={<ProjectProvider />}>
            <Route path="epics" element={<ScopeProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  globalThis.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('projectPath', () => {
  it('ghép /p/<key>/<trang con> và encode ký tự lạ trong key', () => {
    expect(projectPath('PAY', 'epics')).toBe('/p/PAY/epics');
    expect(projectPath('PAY')).toBe('/p/PAY');
    expect(projectPath('A/B', 'epics')).toBe('/p/A%2FB/epics');
  });
});

describe('ProjectProvider', () => {
  it('có quyền thì render trang con với đúng scope và ghi nhớ dự án', async () => {
    stubMe(ME);
    renderAt('/p/PAY/epics');

    await waitFor(() => expect(screen.getByText('INSIDE PAY as PM')).toBeTruthy());
    expect(readLastProject()).toBe('PAY');
  });

  it('role VIEWER của dự án khác được truyền đúng, không lây role PM', async () => {
    stubMe(ME);
    renderAt('/p/CRM/epics');

    await waitFor(() => expect(screen.getByText('INSIDE CRM as VIEWER')).toBeTruthy());
  });

  it('key lạ / không có quyền thì về trang chọn dự án và dọn lastProject', async () => {
    globalThis.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, 'GONE');
    stubMe(ME);
    renderAt('/p/GONE/epics');

    await waitFor(() => expect(screen.getByText('HOME')).toBeTruthy());
    // Không dọn thì trang `/` lại tự chuyển vào /p/GONE — vòng lặp vô hạn.
    expect(readLastProject()).toBeNull();
  });
});
