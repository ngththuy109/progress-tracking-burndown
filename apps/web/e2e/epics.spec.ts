import { expect, test, type Page } from '@playwright/test';

/**
 * E2E màn hình danh sách Epic — US-01, US-02, US-10.
 *
 * Máy chủ API được thay bằng bản giả dựng ngay trong spec: nó ĐỌC thân request
 * và trả lời theo nội dung, chứ không trả giá trị cố định.
 *
 * So đường dẫn bằng HÀM chứ không bằng glob `**\/api\/**` — glob đó chặn luôn
 * `/src/api/client.ts`, mã nguồn của chính app (cạm bẫy đã dính ở T-21).
 */

const EPIC = (over: Record<string, unknown> = {}) => ({
  epicKey: 'PAY-1',
  displayName: 'Thanh toán',
  projectKey: 'PAY',
  status: 'ACTIVE',
  timezone: 'Asia/Tokyo',
  calendarId: 'default',
  lastSyncedAt: '2026-03-06T17:00:00Z',
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

interface ApiCalls {
  readonly validated: string[][];
  readonly added: unknown[];
  readonly patched: unknown[];
  readonly deleted: unknown[];
  /** Thân yêu cầu đồng bộ lại — kiểm NỘI DUNG, không chỉ đếm số lần bấm. */
  readonly resynced: unknown[];
}

async function installApi(
  page: Page,
  options: { epics?: unknown[]; validateResults?: unknown[] } = {},
): Promise<ApiCalls> {
  const calls: ApiCalls = { validated: [], added: [], patched: [], deleted: [], resynced: [] };
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();

      // Multi-tenant: /api/me nuôi ProjectProvider — thiếu nó là bị đá về `/`
      // trước khi màn hình Epics kịp render.
      if (path === '/api/me') {
        await route.fulfill(
          json({
            userId: 'pm@example.com',
            isAdmin: false,
            projects: [{ projectKey: 'PAY', displayName: 'Payments', role: 'PM' }],
          }),
        );
        return;
      }

      if (path.endsWith('/epics/validate')) {
        const body = route.request().postDataJSON() as { keys: string[] };
        calls.validated.push(body.keys);
        const results =
          options.validateResults ??
          body.keys.map((key) =>
            key.startsWith('PAY')
              ? {
                  key,
                  valid: true,
                  displayName: `Epic ${key}`,
                  projectKey: 'PAY',
                  phaseCount: 3,
                  subtaskCount: 10,
                  totalEstimateHours: 80,
                  missingWbsDateCount: 0,
                  warnings: [],
                }
              : {
                  key,
                  valid: false,
                  reason: 'NOT_FOUND',
                  message: 'No such issue on Jira. Check the key — it may be a typo.',
                },
          );
        const valid = results.filter((r) => (r as { valid: boolean }).valid).length;
        await route.fulfill(
          json({ results, summary: { valid, invalid: results.length - valid, canAdd: valid } }),
        );
        return;
      }

      if (path.endsWith('/missing-dates')) {
        await route.fulfill(
          json({
            epicKey: 'PAY-1',
            rows: [
              { issueKey: 'PAY-11', summary: 'Màn đăng nhập', parentKey: 'PAY-10', missingStart: true, missingEnd: false },
            ],
          }),
        );
        return;
      }

      if (path.endsWith('/resync') && method === 'POST') {
        calls.resynced.push(route.request().postDataJSON());
        await route.fulfill(json({ jobId: 'sync-epic:PAY-1', queued: true, estimatedSeconds: 40 }));
        return;
      }

      if (path.endsWith('/epics') && method === 'POST') {
        const body = route.request().postDataJSON() as { keys: string[] };
        calls.added.push(body);
        await route.fulfill(json({ added: body.keys, skipped: [], estimatedSeconds: 80 }));
        return;
      }

      if (path.endsWith('/epics') && method === 'GET') {
        await route.fulfill(json({ epics: options.epics ?? [EPIC()] }));
        return;
      }

      if (method === 'PATCH') {
        calls.patched.push(route.request().postDataJSON());
        await route.fulfill({ status: 204, body: '' });
        return;
      }

      if (method === 'DELETE') {
        calls.deleted.push(route.request().postDataJSON());
        await route.fulfill({ status: 204, body: '' });
        return;
      }

      await route.fulfill(json({}, 404));
    },
  );

  return calls;
}

// ---------------------------------------------------------------------------

test('dán 3 mã rồi bấm Kiểm tra thì thấy cái nào thêm được, và CHƯA thêm gì cả', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto('/p/PAY/epics');

  await page.getByLabel('Epic keys').fill('PAY-100, PAY-200, XXX-1');
  await page.getByRole('button', { name: /Check 3 keys/ }).click();

  const results = page.getByRole('list', { name: 'Check results' });
  // Phải khớp CHÍNH XÁC: chuỗi "không thêm được" chứa "thêm được", nên khớp gần
  // đúng sẽ đếm ra 3 thay vì 2.
  await expect(results.getByText('can add', { exact: true })).toHaveCount(2);
  await expect(results.getByText('cannot add', { exact: true })).toHaveCount(1);

  // Điểm mấu chốt: kiểm tra KHÔNG được ghi gì.
  expect(calls.validated).toEqual([['PAY-100', 'PAY-200', 'XXX-1']]);
  expect(calls.added).toEqual([]);
});

test('mã không tồn tại hiện LÝ DO đọc được, không hiện mã lỗi', async ({ page }) => {
  await installApi(page);
  await page.goto('/p/PAY/epics');

  await page.getByLabel('Epic keys').fill('XXX-1');
  await page.getByRole('button', { name: /Check/ }).click();

  await expect(page.getByText('No such issue on Jira')).toBeVisible();
  await expect(page.getByText('NOT_FOUND')).toBeHidden();
});

test('màn hình nói rõ thời gian ước tính TRƯỚC khi bấm thêm', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto('/p/PAY/epics');

  await page.getByLabel('Epic keys').fill('PAY-100, PAY-200');
  await page.getByRole('button', { name: /Check/ }).click();

  const estimate = page.getByRole('status').filter({ hasText: 'Will add' });
  await expect(estimate).toContainText('about 2 minutes');
  await expect(estimate).toContainText('no chart yet');
  expect(calls.added).toEqual([]);

  await page.getByRole('button', { name: /Add 2 Epics/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Added' })).toContainText('Added 2 Epics');
});

test('Epic chưa từng đồng bộ hiện "đang dựng lịch sử lần đầu", KHÔNG để ô trống', async ({ page }) => {
  // Ô trống trông y hệt "hệ thống hỏng".
  await installApi(page, {
    epics: [EPIC({ status: 'BACKFILLING', lastSyncedAt: null })],
  });
  await page.goto('/p/PAY/epics');

  await expect(page.getByRole('cell', { name: 'building history for the first time' })).toBeVisible();
  await expect(page.getByText('building history', { exact: true })).toBeVisible();
});

test('Epic đang lỗi hiện NGUYÊN VĂN thông báo lỗi', async ({ page }) => {
  await installApi(page, {
    epics: [EPIC({ status: 'ERROR', lastError: 'Jira trả 401: token hết hạn' })],
  });
  await page.goto('/p/PAY/epics');

  await expect(page.getByText('Jira trả 401: token hết hạn')).toBeVisible();
});

test('nhãn nói rõ Tạm dừng giữ dữ liệu còn Bỏ theo dõi xoá dữ liệu', async ({ page }) => {
  await installApi(page);
  await page.goto('/p/PAY/epics');

  await expect(page.getByRole('button', { name: 'Pause (keep data)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Untrack (delete data)' })).toBeVisible();
});

test('tạm dừng gửi đúng trạng thái PAUSED', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto('/p/PAY/epics');

  await page.getByRole('button', { name: 'Pause (keep data)' }).click();

  await expect.poll(() => calls.patched).toEqual([{ status: 'PAUSED' }]);
});

test('nút Đồng bộ lại tồn tại đúng tên mà runbook và màn hình Biểu đồ chỉ tới', async ({ page }) => {
  // Cả `docs/RUNBOOK.md` lẫn khối cảnh báo ở màn hình Biểu đồ đều bảo người dùng
  // "bấm Đồng bộ lại ở màn hình Epic". Trước đây nút đó KHÔNG tồn tại — hướng
  // dẫn chỉ tới hư không.
  await installApi(page);
  await page.goto('/p/PAY/epics');

  await expect(page.getByRole('button', { name: 'Resync' })).toBeVisible();
});

test('hộp thoại cho chọn đủ BA mức, mặc định là mức rẻ nhất', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto('/p/PAY/epics');

  await page.getByRole('button', { name: 'Resync' }).click();

  const dialog = page.getByRole('dialog', { name: 'Choose resync depth' });
  await expect(dialog.getByRole('radio')).toHaveCount(3);
  // Chọn theo tên NGẮN VÀ CHÍNH XÁC: "Nhanh" cũng xuất hiện trong câu mô tả của
  // mức Toàn bộ, nên khớp gần đúng sẽ dính hai phần tử.
  await expect(dialog.getByRole('radio', { name: 'Quick rebuild', exact: true })).toBeChecked();

  // Mở hộp thoại KHÔNG được gửi gì.
  expect(calls.resynced).toEqual([]);

  await dialog.getByRole('button', { name: 'Resync' }).click();
  await expect.poll(() => calls.resynced).toEqual([{ from: null, to: null, full: false }]);
});

test('mức Toàn bộ gửi full = true và cảnh báo về hạn mức Jira', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto('/p/PAY/epics');

  await page.getByRole('button', { name: 'Resync' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose resync depth' });

  await dialog.getByRole('radio', { name: 'Full rebuild', exact: true }).check();
  // Mức đắt phải nói rõ cái giá TRƯỚC khi bấm.
  await expect(dialog.getByRole('note')).toContainText('shared Jira rate limit');

  await dialog.getByRole('button', { name: 'Resync' }).click();
  await expect.poll(() => calls.resynced).toEqual([{ from: null, to: null, full: true }]);
});

test('mức Dải ngày chặn dải ngược và gửi đúng hai đầu', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto('/p/PAY/epics');

  await page.getByRole('button', { name: 'Resync' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose resync depth' });
  const submit = dialog.getByRole('button', { name: 'Resync' });

  await dialog.getByRole('radio', { name: 'Date range rebuild', exact: true }).check();
  // Chưa chọn ngày thì chưa gửi được.
  await expect(submit).toBeDisabled();

  await dialog.getByLabel('From').fill('2026-03-11');
  await dialog.getByLabel('To').fill('2026-03-01');
  await expect(dialog.getByRole('alert')).toContainText('comes after end date');
  await expect(submit).toBeDisabled();

  await dialog.getByLabel('To').fill('2026-03-11');
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect.poll(() => calls.resynced).toEqual([
    { from: '2026-03-11', to: '2026-03-11', full: false },
  ]);
});

test('Epic đang tạm dừng thì không bấm Đồng bộ lại được', async ({ page }) => {
  // Đánh thức một Epic đã cố ý tạm dừng sẽ vô hiệu hoá chính nút Tạm dừng; API
  // trả 409, nên nút phải mờ đi thay vì để người dùng bấm rồi nhận lỗi.
  await installApi(page, { epics: [EPIC({ status: 'PAUSED' })] });
  await page.goto('/p/PAY/epics');

  await expect(page.getByRole('button', { name: 'Resync' })).toBeDisabled();
});

test('bỏ theo dõi BẮT gõ lại mã Epic trước khi cho bấm', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto('/p/PAY/epics');

  await page.getByRole('button', { name: 'Untrack (delete data)' }).click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('cannot be undone');
  await expect(dialog).toContainText('Pause');

  const confirmButton = dialog.getByRole('button', { name: 'Delete permanently' });
  await expect(confirmButton).toBeDisabled();

  await dialog.getByLabel('Type the Epic key to confirm').fill('PAY-9');
  await expect(confirmButton).toBeDisabled();

  await dialog.getByLabel('Type the Epic key to confirm').fill('PAY-1');
  await expect(confirmButton).toBeEnabled();

  await confirmButton.click();
  await expect.poll(() => calls.deleted).toEqual([{ purge: true, confirmKey: 'PAY-1' }]);
});

test('Epic có Sub-task thiếu ngày hiện số lượng và bấm vào xem được danh sách', async ({ page }) => {
  await installApi(page, {
    epics: [EPIC({ dataHealth: { ...EPIC().dataHealth, missingWbsDateCount: 3 } })],
  });
  await page.goto('/p/PAY/epics');

  await page.getByRole('button', { name: '3', exact: true }).click();

  await expect(page.getByRole('heading', { name: /Sub-tasks missing planned dates/ })).toBeVisible();
  await expect(page.getByText('Màn đăng nhập')).toBeVisible();
  await expect(page.getByText('no start date')).toBeVisible();
});

test('chưa theo dõi Epic nào thì hướng dẫn bước tiếp theo, không để trang trắng', async ({ page }) => {
  await installApi(page, { epics: [] });
  await page.goto('/p/PAY/epics');

  await expect(page.getByRole('heading', { name: 'No Epics tracked yet' })).toBeVisible();
  await expect(page.getByText(/click Check to get started/)).toBeVisible();
});
