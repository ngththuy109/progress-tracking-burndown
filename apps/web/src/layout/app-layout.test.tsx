import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLayout } from './app-layout.js';

/**
 * Thanh bên phải đúng BỐ CỤC HAI NHÓM của demo đã chốt (dynamic-tiers-demo.html):
 * ① Theo dõi tiến độ · ② Cấu hình dự án — đúng thứ tự mục trong từng nhóm.
 *
 * Nhãn viết LẠI ở đây thay vì import từ nav-items.ts — import thì đổi thứ tự
 * trong mã nguồn là test tự đổi theo và vẫn xanh, không còn kiểm được gì.
 */

function renderLayout(): void {
  // KHÔNG stub /api/me → useMe lỗi → coi như không phải ADMIN (mục adminOnly ẩn).
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/epics']}>
        <AppLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AppLayout — thanh bên hai nhóm theo demo đã chốt', () => {
  it('hai tiêu đề nhóm hiện đúng tên, đúng thứ tự', () => {
    renderLayout();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const titles = [...nav.querySelectorAll('.nav__group-title')].map((el) =>
      (el.textContent ?? '').replace(/^\d/, '').trim(),
    );
    expect(titles).toEqual(['Theo dõi tiến độ', 'Cấu hình dự án']);
  });

  it('mục trong từng nhóm đúng thứ tự demo (non-admin: Projects/Users ẩn)', () => {
    renderLayout();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent?.trim());
    expect(labels).toEqual([
      // ① Theo dõi tiến độ
      '📋Epics',
      '📉Burndown chart',
      '🗂️Signboard',
      '🧾Phase sub-tasks',
      '🩺Monitoring',
      // ② Cấu hình dự án
      '🏗️Cấu trúc tầng',
      '⚙️Phase settings',
      '🧩Signboard columns',
      '📅Days off',
    ]);
  });
});
