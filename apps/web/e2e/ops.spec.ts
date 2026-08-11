import { expect, test, type Page } from '@playwright/test';

/** E2E dashboard giám sát vận hành — US-12. */

const metric = (name: string, label: string, value: number | null, threshold: number, unit: string, level: string) => ({
  name,
  label,
  value,
  threshold,
  unit,
  level,
});

function healthBody(over: Record<string, unknown> = {}) {
  return {
    collectedAt: '2026-03-10T02:15:00Z',
    jobs: {
      metrics: [
        metric('nightlyDuration', 'Thời lượng job đêm', 18, 240, 'phút', 'OK'),
        metric('missingSnapshotDays', 'Ngày thiếu snapshot', 0, 0, 'ngày', 'OK'),
      ],
      recentRuns: [
        {
          runId: '1',
          epicKey: 'PAY-1',
          runType: 'NIGHTLY',
          status: 'SUCCESS',
          startedAt: '2026-03-10T00:01:00Z',
          durationSeconds: 1080,
          errorMessage: null,
        },
      ],
      erroredEpics: [],
    },
    jira: { metrics: [metric('rateLimitHits', 'Lần bị chặn 24h', 3, 10, 'lần', 'OK')] },
    data: { metrics: [metric('missingWbs', 'Thiếu ngày kế hoạch', 5, 10, '%', 'OK')] },
    planDrift: { rows: [] },
    ...over,
  };
}

interface Calls {
  readonly resynced: string[];
}

async function installApi(page: Page, over: Record<string, unknown> = {}): Promise<Calls> {
  const calls: Calls = { resynced: [] };

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown) => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

      // Multi-tenant: /api/me nuôi ProjectProvider — thiếu nó là bị đá về `/`.
      if (path === '/api/me') {
        return route.fulfill(
          json({
            userId: 'ops@example.com',
            isAdmin: false,
            projects: [{ projectKey: 'PAY', displayName: 'Payments', role: 'PM' }],
          }),
        );
      }
      if (path.endsWith('/resync')) {
        // `/api/projects/PAY/epics/PAY-9/resync` — mã Epic đứng ngay trước đuôi.
        calls.resynced.push(path.split('/').at(-2) ?? '');
        return route.fulfill(json({ jobId: 'sync-epic:PAY-9', queued: true, estimatedSeconds: 40 }));
      }
      if (path.endsWith('/ops/health')) return route.fulfill(json(healthBody(over)));
      return route.fulfill(json({}));
    },
  );

  return calls;
}

// ---------------------------------------------------------------------------

test('mọi số đo hiện kèm NGƯỠNG của nó', async ({ page }) => {
  // "18 phút" là tốt hay xấu? Chỉ biết khi thấy ngưỡng là 240 phút.
  await installApi(page);
  await page.goto('/p/PAY/ops');

  await expect(page.getByText('Thời lượng job đêm: 18 / 240 phút')).toBeVisible();
  await expect(page.getByText('Lần bị chặn 24h: 3 / 10 lần')).toBeVisible();
});

test('màn hình luôn hiện THỜI ĐIỂM số liệu được lấy', async ({ page }) => {
  // Thiếu nó thì có người ra quyết định trên số liệu của 20 phút trước.
  await installApi(page);
  await page.goto('/p/PAY/ops');

  await expect(page.getByText('Data collected at 2026-03-10T02:15:00Z')).toBeVisible();
});

test('chỉ số chưa đo được nói "chưa đo được", KHÔNG hiện số 0', async ({ page }) => {
  await installApi(page, {
    jira: { metrics: [metric('rateLimitHits', 'Lần bị chặn 24h', null, 10, 'lần', 'UNKNOWN')] },
  });
  await page.goto('/p/PAY/ops');

  await expect(page.getByText('Lần bị chặn 24h: not measured yet')).toBeVisible();
});

test('Epic lỗi hiện NGUYÊN VĂN thông báo và bấm chạy lại được', async ({ page }) => {
  const calls = await installApi(page, {
    jobs: {
      ...healthBody().jobs,
      erroredEpics: [
        { epicKey: 'PAY-9', lastError: 'Jira trả 401: token hết hạn', erroredSinceHours: 26 },
      ],
    },
  });
  await page.goto('/p/PAY/ops');

  await expect(page.getByText('Jira trả 401: token hết hạn')).toBeVisible();
  await expect(page.getByText('26h')).toBeVisible();

  await page.getByRole('button', { name: 'Run again' }).click();
  await expect(page.getByRole('button', { name: 'Queued' })).toBeVisible();
  expect(calls.resynced).toEqual(['PAY-9']);
});

test('chưa có lần chạy nào thì nói rõ, KHÔNG hiện như thể mọi thứ bình thường', async ({ page }) => {
  // Đây là lỗi im lặng nguy hiểm nhất của một màn hình giám sát.
  await installApi(page, {
    jobs: { ...healthBody().jobs, recentRuns: [] },
  });
  await page.goto('/p/PAY/ops');

  await expect(page.getByRole('heading', { name: 'No job has ever run' })).toBeVisible();
  await expect(page.getByText(/NOT 'everything is fine'/)).toBeVisible();
});

test('Phase trôi kế hoạch nặng nhất hiện ở đầu danh sách', async ({ page }) => {
  await installApi(page, {
    planDrift: {
      rows: [
        { epicKey: 'PAY-1', phaseCode: 'DESIGN', shiftedWorkdays: 2, planWorkdays: 10, ratio: 0.2, level: 'WARN' },
        { epicKey: 'PAY-2', phaseCode: 'DEV', shiftedWorkdays: 6, planWorkdays: 10, ratio: 0.6, level: 'CRITICAL' },
      ],
    },
  });
  await page.goto('/p/PAY/ops');

  const rows = page.locator('li.row', { hasText: 'slipped' });
  await expect(rows.first()).toContainText('CRITICAL');
  await expect(rows.first()).toContainText('PAY-2');
});

test('tắt được tự làm mới', async ({ page }) => {
  await installApi(page);
  await page.goto('/p/PAY/ops');

  const toggle = page.getByLabel('Auto-refresh every 60 seconds');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
});
