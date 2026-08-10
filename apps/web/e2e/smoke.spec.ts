import { expect, test, type Page } from '@playwright/test';

/**
 * Smoke test — chứng minh cái khung thật sự chạy trên trình duyệt.
 *
 * Spec KHÔNG cần máy chủ API: mỗi test tự chặn `/api/**`. Nhờ vậy `pnpm e2e`
 * chạy được trên máy chưa dựng PostgreSQL, Redis hay Jira — đúng ràng buộc đã
 * ghi ở ARCHITECTURE.md.
 *
 * Nhãn của bốn mục điều hướng được VIẾT LẠI ở đây thay vì import từ
 * `src/layout/nav-items.ts`. Import thì đổi nhãn trong mã nguồn là test tự đổi
 * theo và vẫn xanh — nó sẽ không còn kiểm được gì nữa.
 */

const NAV_LABELS = [
  'Epics',
  'Burndown chart',
  'Signboard',
  'Phase sub-tasks',
  'Signboard columns',
  'Phase settings',
  'Monitoring',
];

const VALID_CONFIG = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[{name}]', sortOrder: 1 }],
  subtaskPatterns: [{ patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 }],
  phaseDefinitions: [
    { phaseCode: 'DESIGN', labelVi: 'Thiết kế', labelJa: '設計', displayOrder: 1 },
    { phaseCode: 'DEV', labelVi: 'Lập trình', labelJa: null, displayOrder: 2 },
  ],
  matchRules: [{ keyword: '設計', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 10 }],
  signboardColumns: [],
  projectKey: null,
  globalVersion: 3,
  projectVersion: null,
  inherited: { titlePatterns: true, phaseDefinitions: true, matchRules: true, signboardColumns: true, subtaskPatterns: true },
};

/**
 * Trả lời mọi lời gọi API bằng dữ liệu hợp lệ.
 *
 * So đường dẫn bằng HÀM chứ không bằng glob `**\/api\/**`: glob đó chặn luôn
 * `/src/api/client.ts` — mã nguồn của chính app, vì thư mục cũng tên `api`.
 * Trình duyệt nhận JSON thay cho module JavaScript và app không khởi động nổi.
 */
async function stubConfigOk(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = path.endsWith('/unmatched')
        ? { labels: [] }
        : path.endsWith('/versions')
          ? { versions: [] }
          : VALID_CONFIG;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    },
  );
}

/** Thu mọi lỗi console và mọi lỗi JavaScript chưa bắt được. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test('mở app hiện được layout với đủ mục điều hướng', async ({ page }) => {
  await stubConfigOk(page);
  await page.goto('/');

  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav).toBeVisible();

  for (const label of NAV_LABELS) {
    await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await expect(nav.getByRole('link')).toHaveCount(NAV_LABELS.length);

  // Vào `/` phải nhảy sang màn hình mặc định, không để trang trống.
  await expect(page).toHaveURL(/\/epics$/);
});

test('bấm qua mọi route không sinh lỗi console', async ({ page }) => {
  await stubConfigOk(page);
  const errors = collectErrors(page);

  await page.goto('/');

  for (const label of NAV_LABELS) {
    // `exact: true` là BẮT BUỘC: "Signboard" là tiền tố của "Signboard columns",
    // nên khớp gần đúng sẽ dính hai liên kết. Lỗi khớp chuỗi con, lần thứ ba.
    await page.getByRole('link', { name: label, exact: true }).click();
    // Tiêu đề trên thanh trên đổi theo — chứng tỏ route đã đổi thật, không phải
    // chỉ đổi màu mục đang chọn.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(label);
  }

  expect(errors, `Lỗi console: ${errors.join(' | ')}`).toEqual([]);
});

test('mục đang chọn được đánh dấu để trình đọc màn hình biết', async ({ page }) => {
  await stubConfigOk(page);
  await page.goto('/signboard');

  await expect(
    page.getByRole('link', { name: 'Signboard', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test('màn hình cấu hình đọc được dữ liệu từ API và vẽ ra màn hình', async ({ page }) => {
  // Đây là bằng chứng cho cả chuỗi khung: client → TanStack Query → component.
  // Nội dung nghiệp vụ của màn hình do `phase-config.spec.ts` (T-21) kiểm.
  await stubConfigOk(page);
  await page.goto('/config/phase');

  await expect(page.getByText('② Phase list')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Vietnamese label, row 1' })).toHaveValue('Thiết kế');
});

test('API trả lỗi thì màn hình hiện ErrorState, không hiện trang trắng', async ({ page }) => {
  await page.route('**/api/config/phase*', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Lỗi hệ thống.' }),
    }),
  );

  await page.goto('/config/phase');

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Could not load Phase settings');
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();

  // Thanh điều hướng vẫn còn: người dùng đi được sang màn hình khác, không kẹt.
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
});

test('mất mạng thì báo bằng câu của mình, không phải chuỗi thô của trình duyệt', async ({ page }) => {
  await page.route('**/api/config/phase*', (route) => route.abort('failed'));

  await page.goto('/config/phase');

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Cannot reach the server');

  // Chuỗi thô của trình duyệt CÓ trong trang nhưng nằm trong khối "Technical
  // details" đóng sẵn — người dùng không thấy, dev mở ra là đọc được.
  const technical = alert.getByText('TypeError: Failed to fetch');
  await expect(technical).not.toBeVisible();

  await alert.getByText('Technical details').click();
  await expect(technical).toBeVisible();
});

test('đường dẫn không tồn tại thì hiện thông báo, không phải trang trắng', async ({ page }) => {
  await stubConfigOk(page);
  await page.goto('/khong-co-trang-nay');

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
});
