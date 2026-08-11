import { expect, test, type Page } from '@playwright/test';

/**
 * E2E màn hình cấu hình Phase — theo đúng US-07, US-08, US-09.
 *
 * API được thay bằng một máy chủ giả dựng ngay trong spec (`installApi`). Nó
 * KHÔNG trả về giá trị cố định: nó đọc thân request và trả lời theo nội dung —
 * nếu không thì test "xem thử phản ánh cấu hình nháp" sẽ xanh kể cả khi màn
 * hình gửi lên một cấu hình hoàn toàn khác.
 *
 * Vì sao không dùng API thật: nó cần PostgreSQL, Redis và Jira. Hợp đồng của
 * API đã được T-09 kiểm bằng bộ test riêng chạy qua `fastify.inject()`.
 */

const BASE_CONFIG = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[{name}]', sortOrder: 1 }],
  subtaskPatterns: [{ patternText: '[{function}]_{task}', sortOrder: 1 }],
  phaseDefinitions: [
    { phaseCode: 'DESIGN', labelVi: 'Thiết kế', labelJa: '設計', displayOrder: 1 },
    { phaseCode: 'TEST', labelVi: 'Kiểm thử', labelJa: 'テスト', displayOrder: 2 },
  ],
  matchRules: [{ keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 }],
  signboardColumns: [],
};

const GLOBAL_CONFIG = {
  ...BASE_CONFIG,
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
  ...BASE_CONFIG,
  projectKey: 'SHOP',
  globalVersion: 4,
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

const VERSIONS = [
  { version: 4, isActive: true, createdBy: 'thuy', createdAt: '2026-08-01T09:00:00Z', note: 'thêm Phase Kiểm thử' },
  { version: 3, isActive: false, createdBy: 'thuy', createdAt: '2026-07-20T09:00:00Z', note: null },
];

interface MatchRule {
  readonly keyword: string;
  readonly matchMode: string;
  readonly phaseCode: string;
  readonly matchPriority: number;
}

interface ApiCalls {
  /** Mọi lần PUT /config/phase — dùng để khẳng định "xem thử KHÔNG lưu gì". */
  readonly saves: unknown[];
  readonly rollbacks: number[];
  readonly previews: unknown[];
}

/**
 * Dựng bảng Xem thử từ CHÍNH cấu hình nháp được gửi lên.
 *
 * Ba Task cố định; mỗi Task tìm luật khớp đầu tiên theo `matchPriority`. Nhờ
 * vậy thêm một luật ở màn hình là kết quả trên bảng đổi thật.
 */
function buildPreview(draft: { matchRules: MatchRule[]; phaseDefinitions: { phaseCode: string; labelVi: string }[] }) {
  const tasks = [
    { taskKey: 'PAY-11', title: '[Design] 決済画面', previous: 'DESIGN' },
    { taskKey: 'PAY-12', title: '[Design Review] 決済画面', previous: 'DESIGN' },
    { taskKey: 'PAY-13', title: '[Release] 本番反映', previous: 'UNCLASSIFIED' },
  ];

  const sorted = [...draft.matchRules].sort((a, b) => a.matchPriority - b.matchPriority);
  const labelOf = (code: string) =>
    draft.phaseDefinitions.find((p) => p.phaseCode === code)?.labelVi ?? 'Chưa phân loại';

  const rows = tasks.map((task) => {
    const label = task.title.slice(1, task.title.indexOf(']'));
    const rule = sorted.find((r) => label.toLowerCase().includes(r.keyword.toLowerCase()));
    const resultPhaseCode = rule?.phaseCode ?? 'UNCLASSIFIED';
    return {
      taskKey: task.taskKey,
      originalTitle: task.title,
      matchedPattern: '[{name}]',
      extractedName: label,
      winningRule:
        rule === undefined
          ? null
          : { keyword: rule.keyword, mode: rule.matchMode, priority: rule.matchPriority },
      resultPhaseCode,
      resultLabel: labelOf(resultPhaseCode),
      previousPhaseCode: task.previous,
      status:
        resultPhaseCode === 'UNCLASSIFIED'
          ? 'STILL_UNCLASSIFIED'
          : resultPhaseCode === task.previous
            ? 'UNCHANGED'
            : 'CHANGED',
    };
  });

  const count = (s: string) => rows.filter((r) => r.status === s).length;

  return {
    projectKey: null,
    totalTasks: rows.length,
    summary: {
      unchanged: count('UNCHANGED'),
      changed: count('CHANGED'),
      stillUnclassified: count('STILL_UNCLASSIFIED'),
      affectedEpics: 3,
      estimatedRecomputeSeconds: 120,
    },
    warnings: [],
    rows,
  };
}

async function installApi(page: Page, options: { projectConfig?: boolean } = {}): Promise<ApiCalls> {
  const calls: ApiCalls = { saves: [], rollbacks: [], previews: [] };
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  // CẠM BẪY ĐÃ DÍNH MỘT LẦN: dùng glob `**/api/**` thì Playwright chặn luôn
  // `/src/api/client.ts` — mã nguồn của chính app, vì thư mục cũng tên `api`.
  // Trình duyệt nhận JSON thay cho module JavaScript, app không khởi động nổi,
  // và cả 7 test đỏ với "không tìm thấy phần tử". Dùng hàm so đường dẫn thay vì
  // glob thì không thể nhầm.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    // Multi-tenant: /api/me nuôi ProjectProvider — thiếu nó là bị đá về `/`.
    if (path === '/api/me') {
      await route.fulfill(
        json({
          userId: 'pm@example.com',
          isAdmin: false,
          projects: [{ projectKey: 'SHOP', displayName: 'Shop', role: 'PM' }],
        }),
      );
      return;
    }

    if (path.endsWith('/config/phase/preview')) {
      const body = route.request().postDataJSON() as { draft: Parameters<typeof buildPreview>[0] };
      calls.previews.push(body);
      await route.fulfill(json(buildPreview(body.draft)));
      return;
    }

    if (path.endsWith('/config/phase/versions')) {
      await route.fulfill(json({ versions: VERSIONS }));
      return;
    }

    if (path.endsWith('/config/phase/unmatched')) {
      await route.fulfill(json({ labels: [{ rawPhaseLabel: 'Release', count: 4, sampleTaskKeys: ['PAY-13'] }] }));
      return;
    }

    if (path.includes('/config/phase/rollback/')) {
      const version = Number(path.split('/').pop());
      calls.rollbacks.push(version);
      await route.fulfill(json({ version: 5, affectedEpics: 3, estimatedRecomputeSeconds: 120 }));
      return;
    }

    if (path.endsWith('/config/phase') && method === 'PUT') {
      const body = route.request().postDataJSON() as { payload: { matchRules: MatchRule[]; phaseDefinitions: { phaseCode: string }[] } };
      const codes = new Set(body.payload.phaseDefinitions.map((p) => p.phaseCode));
      const orphan = body.payload.matchRules.findIndex((r) => !codes.has(r.phaseCode));

      if (orphan >= 0) {
        // Giống hệt `validateConfigPayload` của engine: có `path` để UI neo lỗi.
        await route.fulfill(
          json(
            {
              error: 'CONFIG_INVALID',
              message: 'Cấu hình không hợp lệ, chưa lưu gì cả.',
              issues: [
                {
                  level: 'ERROR',
                  code: 'ORPHAN_PHASE_CODE',
                  message: `Rule "${body.payload.matchRules[orphan]?.keyword}" points at a Phase that is not defined.`,
                  path: `matchRules[${orphan}].phaseCode`,
                },
              ],
            },
            400,
          ),
        );
        return;
      }

      calls.saves.push(body);
      await route.fulfill(json({ version: 5, affectedEpics: 3, estimatedRecomputeSeconds: 120 }));
      return;
    }

    if (path.endsWith('/config/phase')) {
      await route.fulfill(json(options.projectConfig === true ? PROJECT_CONFIG : GLOBAL_CONFIG));
      return;
    }

      await route.fulfill(json({}, 404));
    },
  );

  return calls;
}

async function addRule(page: Page, keyword: string, phaseCode: string, priority: string): Promise<void> {
  await page.getByRole('button', { name: '+ Add rule' }).click();
  const rows = page.getByLabel(/^Keyword, row/);
  const last = (await rows.count()) - 1;
  await rows.nth(last).fill(keyword);
  await page.getByLabel(`Target Phase, row ${last + 1}`).selectOption(phaseCode);
  await page.getByLabel(`Match priority, row ${last + 1}`).fill(priority);
}

test('thêm luật từ khoá mới và bấm Xem thử thì thấy bảng kết quả, cấu hình CHƯA được lưu', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto('/p/SHOP/config/phase');
  await expect(page.getByText('③ Keyword matching rules')).toBeVisible();

  await addRule(page, 'Design Review', 'TEST', '10');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.getByRole('button', { name: '👁 Preview' }).click();

  await expect(page.getByRole('heading', { name: 'Preview results' })).toBeVisible();
  // Điểm mấu chốt của US-07: xem thử KHÔNG được ghi bất cứ thứ gì.
  expect(calls.saves).toHaveLength(0);
  expect(calls.previews).toHaveLength(1);
});

test('bảng Xem thử hiện rõ luật nào đã thắng cho từng Task', async ({ page }) => {
  await installApi(page);
  await page.goto('/p/SHOP/config/phase');
  await expect(page.getByText('③ Keyword matching rules')).toBeVisible();

  await addRule(page, 'Design Review', 'TEST', '10');
  await page.getByRole('button', { name: '👁 Preview' }).click();

  const reviewRow = page.getByRole('row', { name: /PAY-12/ });
  // Hai luật cùng khớp "Design Review"; luật ưu tiên 10 phải thắng luật ưu tiên 50.
  await expect(reviewRow).toContainText('Design Review');
  await expect(reviewRow).toContainText('priority 10');
  await expect(reviewRow).toContainText('Kiểm thử');

  const plainRow = page.getByRole('row', { name: /PAY-11/ });
  await expect(plainRow).toContainText('priority 50');
  await expect(plainRow).toContainText('Thiết kế');
});

test('dòng tổng kết đếm đúng số Task đổi phân loại', async ({ page }) => {
  await installApi(page);
  await page.goto('/p/SHOP/config/phase');
  await expect(page.getByText('③ Keyword matching rules')).toBeVisible();

  await addRule(page, 'Design Review', 'TEST', '10');
  await page.getByRole('button', { name: '👁 Preview' }).click();

  // PAY-11 giữ nguyên DESIGN, PAY-12 chuyển DESIGN → TEST, PAY-13 vẫn chưa nhận diện được.
  await expect(page.getByText(/3 Task/)).toBeVisible();
  await expect(page.getByText(/1 reclassified/)).toBeVisible();
  await expect(page.getByText(/1 unchanged/)).toBeVisible();
  await expect(page.getByText(/1 still unclassified/)).toBeVisible();
});

test('bấm Xác nhận lưu thì tạo version mới và hiện số Epic sẽ tính lại', async ({ page }) => {
  const calls = await installApi(page);
  await page.goto('/p/SHOP/config/phase');
  await expect(page.getByText('③ Keyword matching rules')).toBeVisible();

  await addRule(page, 'Design Review', 'TEST', '10');
  await page.getByRole('button', { name: '👁 Preview' }).click();
  await page.getByRole('button', { name: 'Confirm save' }).click();

  await expect(page.getByRole('status')).toContainText('Saved as version v5');
  await expect(page.getByRole('status')).toContainText('3 Epics will be recomputed');
  expect(calls.saves).toHaveLength(1);
});

test('luật trỏ tới Phase không tồn tại thì lỗi hiện ngay tại dòng luật đó, không phải banner chung', async ({
  page,
}) => {
  await installApi(page);
  await page.goto('/p/SHOP/config/phase');
  await expect(page.getByText('② Phase list')).toBeVisible();

  // Xoá Phase TEST trong khi vẫn còn luật trỏ vào nó.
  await addRule(page, 'Design Review', 'TEST', '10');
  await page.getByRole('button', { name: 'Delete TEST' }).click();

  await page.getByRole('button', { name: '💾 Save without preview' }).click();
  await page.getByRole('button', { name: 'Save anyway' }).click();

  const rowAlert = page.getByRole('alert').filter({ hasText: 'is not defined' });
  await expect(rowAlert).toBeVisible();

  // Thông báo phải nằm TRONG dòng luật vừa thêm, không phải ở đầu trang.
  const ruleRow = page.locator('li.row', { has: rowAlert });
  await expect(ruleRow.getByLabel(/^Keyword, row/)).toHaveValue('Design Review');
});

test('mở dự án SHOP và bấm Ghi đè mẫu tiêu đề thì khu Phase vẫn hiện nhãn kế thừa từ Mặc định', async ({
  page,
}) => {
  // PRD §2.2.6: ba phần kế thừa ĐỘC LẬP nhau. Multi-tenant: phạm vi dự án lấy
  // thẳng từ URL /p/SHOP — không còn ô gõ tay mã project.
  await installApi(page, { projectConfig: true });
  await page.goto('/p/SHOP/config/phase');

  const patternSection = page.locator('section', { has: page.getByText('① Task title patterns') });
  await patternSection.getByRole('button', { name: 'Override for project SHOP' }).click();

  await expect(patternSection.getByText(/inherited from the Default set/)).toBeHidden();

  const phaseSection = page.locator('section', { has: page.getByText('② Phase list') });
  await expect(phaseSection.getByText(/inherited from the Default set/)).toBeVisible();
  await expect(phaseSection.getByRole('button', { name: 'Override for project SHOP' })).toBeVisible();
});

test('mở tab Lịch sử và bấm Quay lại version cũ thì tạo version mới, version bị bỏ vẫn còn trong danh sách', async ({
  page,
}) => {
  const calls = await installApi(page);
  await page.goto('/p/SHOP/config/phase');

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('cell', { name: 'thêm Phase Kiểm thử' })).toBeVisible();

  await page.getByRole('button', { name: 'Roll back to v3' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('creates a new version');
  await page.getByRole('button', { name: 'Yes, roll back' }).click();

  await expect(page.getByRole('status')).toContainText('Created version v5');
  expect(calls.rollbacks).toEqual([3]);

  // v4 KHÔNG bị xoá khỏi lịch sử — quay lại là ghi thêm, không phải xoá bớt.
  await expect(page.getByRole('cell', { name: /v4/ })).toBeVisible();
});
