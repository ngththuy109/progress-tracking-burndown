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
        metric('nightlyDuration', 'Latest nightly job duration', 18, 240, 'min', 'OK'),
        metric('snapshotBehind', 'Epics behind on snapshots', 0, 0, 'Epics', 'OK'),
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
    jira: { metrics: [metric('rateLimitHits', 'Jira rate-limit hits (24h)', 3, 10, 'hits', 'OK')] },
    data: {
      metrics: [
        metric('missingWbsDate', 'Missing planned dates', 5, 10, '%', 'OK'),
        // Loại lỗi thứ sáu (T-37): ghép từ hệ plan-conflicts, có ngưỡng riêng.
        metric('plannedOnDayOff', 'Sub-tasks planned on a day off', 8, 10, '%', 'OK'),
      ],
      byEpic: [],
    },
    planDrift: { rows: [] },
    ...over,
  };
}

/** Một Epic đang theo dõi — nguồn của khu *Planned dates* trong Data quality. */
const EPIC = (over: Record<string, unknown> = {}) => ({
  epicKey: 'PAY-1',
  displayName: 'Thanh toán',
  projectKey: 'PAY',
  status: 'ACTIVE',
  timezone: 'Asia/Tokyo',
  calendarId: 'VN_STANDARD',
  lastSyncedAt: '2026-03-10T00:20:00Z',
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

interface Calls {
  readonly resynced: string[];
}

interface ApiOptions {
  /** Ghi đè các nhánh của `GET /api/ops/health`. */
  readonly health?: Record<string, unknown>;
  readonly epics?: unknown[];
  /** `null` = API đếm plan rơi vào ngày nghỉ hỏng, để kiểm phần "chưa kiểm được". */
  readonly planConflictCounts?: { epicKey: string; total: number }[] | null;
  /** Từng ticket lỗi dữ liệu — nguồn của bảng "Show ticket details". */
  readonly dqIssues?: unknown[];
}

async function installApi(page: Page, options: ApiOptions = {}): Promise<Calls> {
  const calls: Calls = { resynced: [] };

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown, status = 200) => ({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

      if (path.endsWith('/resync')) {
        calls.resynced.push(path.split('/')[3] ?? '');
        return route.fulfill(json({ jobId: 'sync-epic:PAY-9', queued: true, estimatedSeconds: 40 }));
      }
      if (path.endsWith('/ops/health')) return route.fulfill(json(healthBody(options.health)));
      if (path.endsWith('/epics')) return route.fulfill(json({ epics: options.epics ?? [EPIC()] }));
      if (path.endsWith('/plan-conflicts/summary')) {
        const counts = options.planConflictCounts;
        if (counts === null) {
          return route.fulfill(
            json({ code: 'SERVER_ERROR', message: 'Không đọc được lịch nghỉ.' }, 500),
          );
        }
        return route.fulfill(json({ counts: counts ?? [] }));
      }
      if (path.endsWith('/data-quality/issues')) {
        return route.fulfill(
          json({ collectedAt: '2026-03-10T02:15:00Z', issues: options.dqIssues ?? [] }),
        );
      }
      return route.fulfill(json({}));
    },
  );

  return calls;
}

// ---------------------------------------------------------------------------

test('mọi số đo hiện kèm NGƯỠNG của nó', async ({ page }) => {
  // "18 phút" là tốt hay xấu? Chỉ biết khi thấy ngưỡng là 240 phút.
  await installApi(page);
  await page.goto('/ops');

  await expect(page.getByText('Latest nightly job duration: 18 / 240 min')).toBeVisible();
  await expect(page.getByText('Jira rate-limit hits (24h): 3 / 10 hits')).toBeVisible();
});

test('màn hình luôn hiện THỜI ĐIỂM số liệu được lấy', async ({ page }) => {
  // Thiếu nó thì có người ra quyết định trên số liệu của 20 phút trước.
  await installApi(page);
  await page.goto('/ops');

  // Màn hình hiện giờ MÁY NGƯỜI XEM; chuỗi UTC gốc giữ trong tooltip để đối
  // chiếu log máy chủ — nên kiểm cả hai, không neo vào một chuỗi giờ cụ thể.
  const stamp = page.locator('[title="2026-03-10T02:15:00Z"]');
  await expect(stamp).toContainText('Data collected at');
});

test('chỉ số chưa đo được nói "chưa đo được", KHÔNG hiện số 0', async ({ page }) => {
  await installApi(page, {
    health: { jira: { metrics: [metric('rateLimitHits', 'Jira rate-limit hits (24h)', null, 10, 'hits', 'UNKNOWN')] } },
  });
  await page.goto('/ops');

  await expect(page.getByText('Jira rate-limit hits (24h): not measured yet')).toBeVisible();
});

test('Epic lỗi hiện NGUYÊN VĂN thông báo và bấm chạy lại được', async ({ page }) => {
  const calls = await installApi(page, {
    health: {
      jobs: {
        ...healthBody().jobs,
        erroredEpics: [
          { epicKey: 'PAY-9', lastError: 'Jira trả 401: token hết hạn', erroredSinceHours: 26 },
        ],
      },
    },
  });
  await page.goto('/ops');

  await expect(page.getByText('Jira trả 401: token hết hạn')).toBeVisible();
  await expect(page.getByText('26h')).toBeVisible();

  await page.getByRole('button', { name: 'Run again' }).click();
  await expect(page.getByRole('button', { name: 'Queued' })).toBeVisible();
  expect(calls.resynced).toEqual(['PAY-9']);
});

test('chưa có lần chạy nào thì nói rõ, KHÔNG hiện như thể mọi thứ bình thường', async ({ page }) => {
  // Đây là lỗi im lặng nguy hiểm nhất của một màn hình giám sát.
  await installApi(page, {
    health: { jobs: { ...healthBody().jobs, recentRuns: [] } },
  });
  await page.goto('/ops');

  await expect(page.getByRole('heading', { name: 'No job has ever run' })).toBeVisible();
  await expect(page.getByText(/NOT 'everything is fine'/)).toBeVisible();
});

test('Phase trôi kế hoạch nặng nhất hiện ở đầu danh sách', async ({ page }) => {
  await installApi(page, {
    health: {
      planDrift: {
        rows: [
          { epicKey: 'PAY-1', phaseCode: 'DESIGN', shiftedWorkdays: 2, planWorkdays: 10, ratio: 0.2, level: 'WARN' },
          { epicKey: 'PAY-2', phaseCode: 'DEV', shiftedWorkdays: 6, planWorkdays: 10, ratio: 0.6, level: 'CRITICAL' },
        ],
      },
    },
  });
  await page.goto('/ops');

  const rows = page.locator('li.row', { hasText: 'slipped' });
  await expect(rows.first()).toContainText('CRITICAL');
  await expect(rows.first()).toContainText('PAY-2');
});

test('tắt được tự làm mới', async ({ page }) => {
  await installApi(page);
  await page.goto('/ops');

  const toggle = page.getByLabel('Auto-refresh every 60 seconds');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
});

// --- Thứ tự section & loại lỗi "plan vào ngày nghỉ" (T-37) ------------------

test('thứ tự section: Data quality đầu tiên, rồi Most recent job runs, rồi Nightly jobs', async ({ page }) => {
  await installApi(page);
  await page.goto('/ops');
  // Đợi thoát trạng thái Loading trước khi đọc DOM — nếu không thì bắt phải bộ
  // khung tải, chưa có panel nào.
  await expect(page.getByRole('heading', { name: 'Data quality' })).toBeVisible();

  // Tiêu đề panel (h2/h3) và caption bảng theo đúng thứ tự DOM.
  const headings = await page.locator('.panel__title, .table__caption').allInnerTexts();
  const at = (needle: string) => headings.findIndex((t) => t.includes(needle));
  expect(at('Data quality')).toBeGreaterThanOrEqual(0);
  expect(at('Data quality')).toBeLessThan(at('Most recent job runs'));
  expect(at('Most recent job runs')).toBeLessThan(at('Nightly jobs'));
  expect(at('Nightly jobs')).toBeLessThan(at('Jira calls'));
  expect(at('Jira calls')).toBeLessThan(at('Epics in error'));
});

test('Data quality hiện chip "planned on a day off" (loại lỗi thứ sáu) trên dòng Epic', async ({ page }) => {
  // Số đo hiện theo TỪNG Epic — đã bỏ dãy roll-up toàn cục vì con số gộp không
  // nói được đội nào phải sửa nên không ai dùng.
  await installApi(page, {
    health: {
      data: {
        metrics: [],
        byEpic: [
          {
            epicKey: 'PAY-1',
            displayName: 'Thanh toán',
            total: 12,
            metrics: [metric('plannedOnDayOff', 'Sub-tasks planned on a day off', 8, 10, '%', 'OK')],
          },
        ],
      },
    },
  });
  await page.goto('/ops');

  await expect(page.getByText('Sub-tasks planned on a day off: 8 / 10 %')).toBeVisible();
});

// --- Data quality › bảng chi tiết theo PIC ---------------------------------

const DQ_ISSUE = (over: Record<string, unknown> = {}) => ({
  issueKey: 'PAY-101',
  epicKey: 'PAY-1',
  epicDisplayName: 'Thanh toán',
  summary: '[PAY][BE][DEV][Login]_Create',
  problems: ['MISSING_ESTIMATE'],
  pics: [{ accountId: 'a1', displayName: 'Nguyễn An' }],
  exempt: false,
  exemptBy: null,
  ...over,
});

const DQ_ISSUES = [
  DQ_ISSUE(),
  DQ_ISSUE({ issueKey: 'PAY-102', pics: [{ accountId: 'b2', displayName: 'Trần Bình' }] }),
  DQ_ISSUE({ issueKey: 'PAY-103', pics: [] }),
];

test('bảng chi tiết nói AI phải sửa từng ticket', async ({ page }) => {
  await installApi(page, { dqIssues: DQ_ISSUES });
  await page.goto('/ops');
  await page.getByRole('button', { name: 'Show ticket details' }).click();

  // `exact` là bắt buộc: so chuỗi con thì "PIC" khớp luôn cả cột "Epic".
  await expect(page.getByRole('button', { name: 'PIC', exact: true })).toBeVisible();
  // `exact` để không đụng mục "Nguyễn An (1)" trong ô chọn lọc.
  await expect(page.getByText('Nguyễn An', { exact: true })).toBeVisible();
  // Ticket chưa gán ai phải NÓI RÕ, không để ô trống — ô trống trông y hệt
  // "chưa tải xong".
  await expect(page.getByText('no PIC yet', { exact: true })).toBeVisible();
});

test('lọc theo PIC để mỗi người thấy đúng phần việc của mình', async ({ page }) => {
  await installApi(page, { dqIssues: DQ_ISSUES });
  await page.goto('/ops');
  await page.getByRole('button', { name: 'Show ticket details' }).click();

  // Ô chọn CÓ TÌM KIẾM: gõ (kể cả KHÔNG dấu) để lọc nhanh rồi chọn.
  const pic = page.getByRole('combobox', { name: 'Filter by PIC' });
  await pic.click();
  await pic.fill('nguyen');
  await page.getByRole('option', { name: /Nguyễn An/ }).click();

  await expect(page.getByText('PAY-101')).toBeVisible();
  await expect(page.getByText('PAY-102')).toHaveCount(0);
  // File tải về phải khớp với những gì đang nhìn thấy.
  await expect(page.getByRole('button', { name: /Download CSV report \(1 tickets\)/ })).toBeVisible();
});

test('PIC combobox: gõ để thu hẹp danh sách rồi chọn', async ({ page }) => {
  await installApi(page, { dqIssues: DQ_ISSUES });
  await page.goto('/ops');
  await page.getByRole('button', { name: 'Show ticket details' }).click();

  const pic = page.getByRole('combobox', { name: 'Filter by PIC' });
  await pic.click();
  // Mở ra thấy đủ mọi người.
  await expect(page.getByRole('option', { name: /Nguyễn An/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Trần Bình/ })).toBeVisible();
  // Gõ "tran" (không dấu) → chỉ còn Trần Bình.
  await pic.fill('tran');
  await expect(page.getByRole('option', { name: /Trần Bình/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Nguyễn An/ })).toHaveCount(0);
});

test('lọc được riêng nhóm ticket CHƯA có người phụ trách', async ({ page }) => {
  // Nhóm này không thuộc về ai, nên nếu chỉ lọc theo từng người thì nó không
  // bao giờ lọt vào danh sách của ai cả.
  await installApi(page, { dqIssues: DQ_ISSUES });
  await page.goto('/ops');
  await page.getByRole('button', { name: 'Show ticket details' }).click();

  const pic = page.getByRole('combobox', { name: 'Filter by PIC' });
  await pic.click();
  await page.getByRole('option', { name: /No PIC yet/ }).click();

  await expect(page.getByText('PAY-103')).toBeVisible();
  await expect(page.getByText('PAY-101')).toHaveCount(0);
});

test('lọc theo LOẠI LỖI (kể cả "planned on a day off") để xử lý gọn từng nhóm', async ({ page }) => {
  await installApi(page, {
    dqIssues: [
      DQ_ISSUE({ issueKey: 'PAY-101', problems: ['MISSING_ESTIMATE'] }),
      DQ_ISSUE({ issueKey: 'PAY-201', problems: ['PLANNED_ON_DAY_OFF'] }),
    ],
  });
  await page.goto('/ops');
  await page.getByRole('button', { name: 'Show ticket details' }).click();

  // Badge loại lỗi hiện NGAY trên ticket (exact để không đụng mục "… (1)" trong ô chọn).
  await expect(page.getByText('Planned on a day off', { exact: true })).toBeVisible();

  await page.getByLabel('Filter by problem type').selectOption({ label: 'Planned on a day off (1)' });
  await expect(page.getByText('PAY-201')).toBeVisible();
  await expect(page.getByText('PAY-101')).toHaveCount(0);
});
