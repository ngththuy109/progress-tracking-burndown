import { expect, test, type Page } from '@playwright/test';

/** E2E màn hình cấu hình cột Signboard. */

const CONFIG = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[Phase] {name}', sortOrder: 1 }],
  subtaskPatterns: [{ patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 }],
  phaseDefinitions: [{ phaseCode: 'DESIGN', labelVi: 'Thiết kế', labelJa: null, displayOrder: 1 }],
  matchRules: [],
  signboardColumns: [
    { taskCode: 'Create', labelVi: 'Create', labelJa: null, displayOrder: 1 },
    { taskCode: 'BALReview', labelVi: 'BAL review', labelJa: null, displayOrder: 2 },
  ],
  projectKey: null,
  globalVersion: 4,
  projectVersion: null,
  inherited: {
    titlePatterns: false,
    subtaskPatterns: false,
    phaseDefinitions: false,
    matchRules: false,
    signboardColumns: false,
    subPhaseOrders: false,
  },
};

const PROJECT_CONFIG = {
  ...CONFIG,
  projectKey: 'SHOP',
  inherited: {
    titlePatterns: true,
    subtaskPatterns: true,
    phaseDefinitions: true,
    matchRules: true,
    signboardColumns: true,
    subPhaseOrders: true,
  },
};

interface Calls {
  readonly saves: {
    payload: {
      signboardColumns: { taskCode: string }[];
      matchRules: unknown[];
      subPhaseOrders: { phaseCode: string; subPhaseCode: string; displayOrder: number }[];
    };
  }[];
}

async function installApi(page: Page, options: { project?: boolean; duplicate?: boolean } = {}): Promise<Calls> {
  const calls: Calls = { saves: [] };
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

      if (path.endsWith('/unmatched')) return route.fulfill(json({ labels: [] }));
      if (path.endsWith('/versions')) return route.fulfill(json({ versions: [] }));

      if (path.endsWith('/config/phase') && method === 'PUT') {
        const body = route.request().postDataJSON() as Calls['saves'][number];
        if (options.duplicate === true) {
          return route.fulfill(
            json(
              {
                error: 'CONFIG_INVALID',
                message: 'Cấu hình không hợp lệ, chưa lưu gì cả.',
                issues: [
                  {
                    level: 'ERROR',
                    code: 'DUPLICATE_TASK_CODE',
                    message: 'Column code "Create" is declared twice.',
                    path: 'signboardColumns[1].taskCode',
                  },
                ],
              },
              400,
            ),
          );
        }
        calls.saves.push(body);
        return route.fulfill(json({ version: 5, affectedEpics: 3, estimatedRecomputeSeconds: 120 }));
      }

      return route.fulfill(json(options.project === true ? PROJECT_CONFIG : CONFIG));
    },
  );

  return calls;
}

const PAGE = '/config/signboard';

// ---------------------------------------------------------------------------

test('thêm cột mới rồi lưu thì gửi đúng danh sách cột', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto(PAGE);

  await page.getByRole('button', { name: '+ Add column' }).click();
  await page.getByLabel('Column code, row 3').fill('Deploy');
  await page.getByLabel('Vietnamese label, row 3').fill('Triển khai');
  await page.getByRole('button', { name: /Save columns/ }).click();

  await expect.poll(() => calls.saves.length).toBe(1);
  expect(calls.saves[0]?.payload.signboardColumns.map((c) => c.taskCode)).toEqual([
    'Create',
    'BALReview',
    'Deploy',
  ]);
});

test('đổi thứ tự cột chỉ đụng cột, KHÔNG đụng luật khớp Phase', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto(PAGE);

  await page.getByRole('button', { name: 'Move Create down' }).click();
  await page.getByRole('button', { name: /Save columns/ }).click();

  await expect.poll(() => calls.saves.length).toBe(1);
  expect(calls.saves[0]?.payload.signboardColumns.map((c) => c.taskCode)).toEqual([
    'BALReview',
    'Create',
  ]);
  expect(calls.saves[0]?.payload.matchRules).toEqual([]);
});

test('xoá cột thì cảnh báo Sub-task sẽ rơi khỏi bảng', async ({ page }) => {
  await installApi(page);
  await page.goto(PAGE);

  await page.getByRole('button', { name: 'Delete Create' }).click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('drop off the Signboard');
  await expect(dialog).toContainText('still count towards Burndown');
});

test('khai trùng mã cột thì lỗi hiện NGAY TẠI DÒNG đó', async ({ page }) => {
  await installApi(page, { duplicate: true });
  await page.goto(PAGE);

  await page.getByRole('button', { name: '+ Add column' }).click();
  await page.getByLabel('Column code, row 3').fill('Create');
  await page.getByRole('button', { name: /Save columns/ }).click();

  const rowAlert = page.getByRole('alert').filter({ hasText: 'is declared twice' });
  await expect(rowAlert).toBeVisible();
  // Nằm trong đúng dòng, không phải banner ở đầu trang.
  await expect(rowAlert.locator('xpath=ancestor::li[1]')).toBeVisible();
});

test('project ghi đè cột thì các phần khác VẪN kế thừa', async ({ page }) => {
  await installApi(page, { project: true });
  await page.goto(`${PAGE}?project=SHOP`);

  // Cả khu ④ (cột) lẫn khu ⑤ (Sub-phase order) đều có nhãn kế thừa riêng —
  // kiểm cả hai để chắc phần MỚI cũng đi đúng luật kế thừa theo phần.
  await expect(page.getByText(/inherited from the Default set/)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Override for project SHOP' }).first()).toBeVisible();
});

test('xem thử cho biết tiêu đề mẫu rơi vào cột nào hay rơi ra ngoài', async ({ page }) => {
  await installApi(page);
  await page.goto(PAGE);

  await page.getByLabel('Sample titles').fill('[PAY][TeamA][Design][Login]_Create');
  await expect(page.getByText('goes to column Create')).toBeVisible();

  await page.getByLabel('Sample titles').fill('[PAY][TeamA][Design][Login]_Deploy');
  await expect(page.getByText(/falls off the board/)).toBeVisible();
});

test('mở từ gợi ý của bảng Signboard thì mã cột được điền sẵn', async ({ page }) => {
  await installApi(page);
  await page.goto(`${PAGE}?add=Deploy`);

  await expect(page.getByLabel('Column code, row 3')).toHaveValue('Deploy');
});

test('mở từ link "Set sub-phase order" thì nhóm được điền sẵn; xếp lại rồi lưu gửi đúng thứ tự', async ({
  page,
}) => {
  const calls = await installApi(page);
  await page.goto(`${PAGE}?orderPhase=FUT_TestCase&subs=fut_confirmpoint%2Cfut_testcase`);

  // Nhóm điền sẵn đúng Phase và đúng các Sub-phase đang có trên bảng.
  await expect(page.getByLabel('Phase of sub-phase group 1')).toHaveValue('FUT_TestCase');
  await expect(page.getByLabel('Sub-phase code, FUT_TestCase row 1')).toHaveValue('fut_confirmpoint');
  await expect(page.getByLabel('Sub-phase code, FUT_TestCase row 2')).toHaveValue('fut_testcase');

  // Đảo thứ tự bằng nút mũi tên rồi lưu — payload mang displayOrder MỚI.
  await page.getByRole('button', { name: 'Move fut_confirmpoint down' }).click();
  await page.getByRole('button', { name: /Save columns/ }).click();

  await expect.poll(() => calls.saves.length).toBe(1);
  expect(calls.saves[0]?.payload.subPhaseOrders).toEqual([
    { phaseCode: 'FUT_TestCase', subPhaseCode: 'fut_testcase', displayOrder: 1 },
    { phaseCode: 'FUT_TestCase', subPhaseCode: 'fut_confirmpoint', displayOrder: 2 },
  ]);
});

test('Phase không có Sub-phase thì khu ⑤ chỉ là ghi chú, không bắt khai gì', async ({ page }) => {
  await installApi(page);
  await page.goto(PAGE);

  await expect(page.getByRole('heading', { name: /Sub-phase order/ })).toBeVisible();
  await expect(page.getByText('No sub-phase order declared yet')).toBeVisible();
});
