import { expect, test, type Page } from '@playwright/test';

/**
 * E2E bảng Signboard — US-13, US-14, US-15.
 */

const COLUMNS = [
  { taskCode: 'Create', label: 'Create' },
  { taskCode: 'BALReview', label: 'BAL review' },
  { taskCode: 'JMReview', label: 'JM review' },
];

const ticket = (issueKey: string, status: string) => ({
  issueKey,
  planStart: '2026-03-02' as string | null,
  planEnd: '2026-03-06' as string | null,
  actualStart: null as string | null,
  actualEnd: null as string | null,
  status,
});

const cell = (status: string, tickets: ReturnType<typeof ticket>[]) => ({
  present: true,
  planStart: '2026-03-02',
  planEnd: '2026-03-06',
  actualStart: null,
  actualEnd: null,
  status,
  ticketCount: tickets.length,
  tickets,
});

const EMPTY = { present: false };

function boardBody(over: Record<string, unknown> = {}) {
  return {
    epicKey: 'PAY-1',
    phaseCode: 'DESIGN',
    asOfDate: '2026-03-10',
    columns: COLUMNS,
    rows: [
      {
        functionKey: 'login',
        functionName: 'Login',
        cells: [
          cell('COMPLETED', [ticket('S-1', 'COMPLETED')]),
          cell('DELAY_END', [ticket('S-2', 'DELAY_START'), ticket('S-3', 'DELAY_END')]),
          EMPTY,
        ],
        total: cell('DELAY_END', [ticket('S-3', 'DELAY_END')]),
      },
      {
        functionKey: 'thanhtoan',
        functionName: 'Thanh toán',
        cells: [
          cell('NO_PLAN', [{ ...ticket('S-4', 'NO_PLAN'), planStart: null, planEnd: null }]),
          EMPTY,
          EMPTY,
        ],
        total: cell('NO_PLAN', [ticket('S-4', 'NO_PLAN')]),
      },
    ],
    summary: {
      byStatus: { COMPLETED: 1, DELAY_END: 1, NO_PLAN: 1 },
      emptyCells: 3,
      totalCells: 6,
    },
    parseHealthWarning: false,
    ...over,
  };
}

function unparsedBody(over: Record<string, unknown> = {}) {
  return {
    epicKey: 'PAY-1',
    phaseCode: 'DESIGN',
    items: [
      {
        issueKey: 'S-9',
        summary: '決済画面を作る',
        reason: 'BAD_TITLE_FORMAT',
        hint: 'The title is in the wrong format, so it fits no cell. This sub-task DOES still count towards the Burndown chart.',
        rawTaskType: null,
      },
    ],
    suggestedColumns: [],
    totalSubtasks: 5,
    parseHealthWarning: false,
    ...over,
  };
}

async function installApi(
  page: Page,
  over: { board?: Record<string, unknown>; unparsed?: Record<string, unknown> } = {},
): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown) => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

      if (path.endsWith('/unparsed')) {
        await route.fulfill(json(unparsedBody(over.unparsed)));
        return;
      }
      if (path.includes('/signboard/epic/')) {
        await route.fulfill(json(boardBody(over.board)));
        return;
      }
      await route.fulfill(json({}));
    },
  );
}

const PAGE = '/signboard?epic=PAY-1&phase=DESIGN';

// ---------------------------------------------------------------------------

test('chọn một Phase thì thấy ma trận Function × loại task', async ({ page }) => {
  await installApi(page);
  await page.goto(PAGE);

  await expect(page.getByRole('columnheader', { name: 'Create' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'BAL review' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'Login' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'Thanh toán' })).toBeVisible();
});

test('hai ticket cùng một ô thì hiện huy hiệu ≡2 và trạng thái xấu nhất', async ({ page }) => {
  await installApi(page);
  await page.goto(PAGE);

  await expect(page.getByText('≡2')).toBeVisible();
  // Ô gộp DELAY_START + DELAY_END phải mang trạng thái xấu hơn.
  await expect(page.locator('[data-status="DELAY_END"]').first()).toBeVisible();
});

test('rê chuột lên ô gộp thấy danh sách từng ticket kèm trạng thái riêng', async ({ page }) => {
  await installApi(page);
  await page.goto(PAGE);

  const merged = page.locator('.cell', { hasText: '≡2' });
  const tooltip = await merged.getAttribute('title');

  expect(tooltip).toContain('S-2: Late start');
  expect(tooltip).toContain('S-3: Late finish');
});

test('bấm thanh tóm tắt thì lọc, bấm lần nữa thì bỏ lọc', async ({ page }) => {
  await installApi(page);
  await page.goto(PAGE);

  const button = page.getByRole('button', { name: /Late finish/ });
  await button.click();

  // Đang lọc phải có dấu hiệu rõ ràng, nếu không người dùng tưởng dữ liệu mất.
  await expect(page.getByRole('status')).toContainText('Filtering by');
  await expect(page.getByRole('status')).toContainText('not removed');

  await button.click();
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('ô thiếu ngày kế hoạch hiện NO_PLAN có kẻ sọc, KHÁC HẲN ô trống', async ({ page }) => {
  // Một cái nghĩa là "không có việc đó", cái kia nghĩa là "có việc nhưng chưa
  // biết bao giờ". Trộn lẫn làm PM đi tìm việc không tồn tại (§6.5).
  await installApi(page);
  await page.goto(PAGE);

  const noPlan = page.locator('.cell--no-plan').first();
  await expect(noPlan).toBeVisible();
  await expect(noPlan).toContainText('No planned dates');

  const empty = page.locator('.cell--empty').first();
  await expect(empty).toHaveText('—');
  await expect(empty).toHaveAttribute('title', /no such step/);
});

test('mỗi ô có CHỮ nói lên trạng thái, không chỉ có màu', async ({ page }) => {
  // Khoảng 8% nam giới không phân biệt được đỏ với xanh lá.
  await installApi(page);
  await page.goto(PAGE);

  await expect(page.getByText('Done').first()).toBeVisible();
  await expect(page.getByText('Late finish').first()).toBeVisible();
  await expect(page.getByText('No planned dates').first()).toBeVisible();
});

test('gõ "login" vào ô tìm kiếm cũng tìm ra hàng có tên Ｌｏｇｉｎ', async ({ page }) => {
  await installApi(page, {
    board: {
      rows: [
        {
          functionKey: 'login',
          functionName: 'Ｌｏｇｉｎ',
          cells: [cell('COMPLETED', [ticket('S-1', 'COMPLETED')]), EMPTY, EMPTY],
          total: cell('COMPLETED', [ticket('S-1', 'COMPLETED')]),
        },
      ],
    },
  });
  await page.goto(PAGE);

  await page.getByLabel('Search Functions').fill('login');
  await expect(page.getByRole('rowheader', { name: 'Ｌｏｇｉｎ' })).toBeVisible();
});

test('Sub-task đặt tên sai định dạng hiện ở khu dưới, KHÔNG bị giấu đi', async ({ page }) => {
  await installApi(page);
  await page.goto(PAGE);

  await expect(page.getByRole('heading', { name: /Not on the board/ })).toBeVisible();
  await expect(page.getByText('決済画面を作る')).toBeVisible();
  await expect(page.getByText(/DOES still count towards the Burndown chart/).first()).toBeVisible();
});

test('loại task lạ xuất hiện nhiều lần thì gợi ý thêm cột', async ({ page }) => {
  await installApi(page, {
    unparsed: { suggestedColumns: [{ taskCode: 'Deploy', count: 4 }] },
  });
  await page.goto(PAGE);

  await expect(page.getByText('Suggested new columns:')).toBeVisible();
  await expect(page.getByText('Deploy')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open column settings' })).toBeVisible();
});

test('hơn 30% Sub-task sai tiêu đề thì hiện banner cảnh báo', async ({ page }) => {
  await installApi(page, { board: { parseHealthWarning: true } });
  await page.goto(PAGE);

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('More than 30%');
  await expect(alert).toContainText('still count towards the Burndown chart');
});

test('màn hình luôn hiện NGÀY đang dùng để tính trạng thái', async ({ page }) => {
  // Người dùng mở tab từ hôm qua rồi quay lại sẽ thấy trạng thái cũ.
  await installApi(page);
  await page.goto(PAGE);

  await expect(page.getByText('Status as of 2026-03-10')).toBeVisible();
});

test('chưa chọn Epic thì hướng dẫn bước tiếp theo', async ({ page }) => {
  await installApi(page);
  await page.goto('/signboard');

  await expect(page.getByRole('heading', { name: 'No Epic selected' })).toBeVisible();
});
