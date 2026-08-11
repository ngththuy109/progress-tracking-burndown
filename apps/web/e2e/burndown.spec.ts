import { expect, test, type Page } from '@playwright/test';

/**
 * E2E biểu đồ Burndown — US-03, US-04, US-05, US-11.
 *
 * Máy chủ giả ĐẾM số lần gọi để chứng minh điều quan trọng nhất của màn hình
 * này: **đổi chế độ xem không gọi lại API**.
 */

const DAYS = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];

const point = (date: string, planned: number | null, actual: number | null) => ({
  date,
  plannedRemainingHours: planned,
  actualRemainingHours: actual,
  varianceHours: planned === null || actual === null ? null : planned - actual,
});

function burndownBody(over: Record<string, unknown> = {}) {
  return {
    epicKey: 'PAY-1',
    mode: 'EPIC',
    from: DAYS[0],
    to: DAYS[DAYS.length - 1],
    series: [
      {
        key: 'EPIC',
        label: 'Whole Epic',
        colorHex: null,
        points: DAYS.map((d, i) => point(d, 80 - i * 16, 80 - i * 14)),
      },
      {
        key: 'DESIGN',
        label: 'Thiết kế',
        colorHex: '#4A90D9',
        points: DAYS.map((d, i) => point(d, 40 - i * 8, 40 - i * 7)),
      },
      {
        key: 'DEV',
        label: 'Lập trình',
        colorHex: null,
        points: DAYS.map((d, i) => point(d, 40 - i * 8, 40 - i * 7)),
      },
    ],
    markers: [],
    planShiftSummary: { totalShiftedWorkdays: 0, shiftCount: 0, warningLevel: 'OK' },
    dataHealth: {
      missingSnapshotDays: [],
      missingEstimateRatio: 0,
      unclassifiedPhaseRatio: 0,
      missingWbsDateRatio: 0,
    },
    planIsFloating: true,
    planNote:
      'The Planned line is recomputed after every sync, including the part already in the past. Look for the ⚑ marks to see when a planned date moved.',
    ...over,
  };
}

/** Epic cho bộ chọn khi vào màn hình mà chưa có `?epic=` trên URL. */
const epicSummary = (over: Record<string, unknown> = {}) => ({
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

const EPICS = [
  epicSummary(),
  epicSummary({ epicKey: 'PAY-2', displayName: 'Báo cáo' }),
  // Không active → bộ chọn phải bỏ qua.
  epicSummary({ epicKey: 'PAY-9', displayName: 'Đã dừng', status: 'PAUSED' }),
];

const EXPLAIN = {
  epicKey: 'PAY-1',
  date: '2026-03-03',
  rows: [
    {
      issueKey: 'PAY-11',
      summary: 'Màn đăng nhập',
      phaseCode: 'DESIGN',
      statusCategoryAtDay: 'indeterminate',
      appliedRule: 2,
      ruleExplanation:
        'Rule 2 — someone manually set the remaining estimate to 5h. A human-entered value wins over subtraction.',
      originalEstimateHours: 8,
      spentHoursUpToDay: 7,
      remainingHours: 5,
      estimateOverride: { valueHours: 5, changedAt: '2026-03-03T03:00:00Z', changedBy: 'thuy' },
    },
  ],
  recomputedRemainingHours: 5,
  storedRemainingHours: 5,
  mismatch: null,
};

interface Counts {
  burndown: number;
  explain: number;
}

async function installApi(page: Page, over: Record<string, unknown> = {}): Promise<Counts> {
  const counts: Counts = { burndown: 0, explain: 0 };

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown) => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

      if (path.includes('/explain')) {
        counts.explain += 1;
        await route.fulfill(json(EXPLAIN));
        return;
      }
      if (path.includes('/burndown/epic/')) {
        counts.burndown += 1;
        await route.fulfill(json(burndownBody(over)));
        return;
      }
      // Bộ chọn Epic (khi vào màn hình không kèm `?epic=`) gọi danh sách Epic.
      if (path.endsWith('/epics')) {
        await route.fulfill(json({ epics: EPICS }));
        return;
      }
      await route.fulfill(json({}));
    },
  );

  return counts;
}

// CỐ Ý không đặt tên là `URL`: hằng số đó sẽ che mất `URL` toàn cục mà
// `installApi` đang dùng, và mọi test đỏ với 'URL is not a constructor'.
const PAGE = '/burndown?epic=PAY-1';

// ---------------------------------------------------------------------------

test('mở biểu đồ Epic thấy đủ hai đường Kế hoạch và Thực tế', async ({ page }) => {
  await installApi(page);
  await page.goto(PAGE);

  await expect(page.getByText('Whole Epic · Actual')).toBeVisible();
  await expect(page.getByText('Whole Epic · Planned')).toBeVisible();
});

test('đổi sang chế độ một Phase KHÔNG gọi lại API', async ({ page }) => {
  // T-17 đã tính sẵn đường Kế hoạch của từng Phase vào `per_phase` chính vì lý
  // do này. Gọi lại là hỏng mất công của card đó.
  const counts = await installApi(page);
  await page.goto(PAGE);
  await expect(page.getByText('Whole Epic · Actual')).toBeVisible();

  const before = counts.burndown;

  await page.getByRole('tab', { name: 'Single Phase' }).click();
  await page.getByRole('button', { name: 'DESIGN' }).click();
  await expect(page.getByText('Thiết kế · Actual')).toBeVisible();

  expect(counts.burndown).toBe(before);
});

test('chế độ so sánh vẽ mỗi Phase một đường và KHÔNG vẽ đường Kế hoạch', async ({ page }) => {
  // Bốn Phase × hai đường là tám đường chồng nhau, không ai đọc được.
  await installApi(page);
  await page.goto(PAGE);

  await page.getByRole('tab', { name: 'Compare Phases' }).click();
  await page.getByRole('button', { name: 'DESIGN' }).click();
  await page.getByRole('button', { name: 'DEV' }).click();

  await expect(page.getByText('Thiết kế · Actual')).toBeVisible();
  await expect(page.getByText('Lập trình · Actual')).toBeVisible();
  await expect(page.getByText('Thiết kế · Planned')).toHaveCount(0);
});

test('chú thích về việc vẽ lại đường Kế hoạch LUÔN hiện, không phải bấm mới thấy', async ({ page }) => {
  // Không nói thì PM thấy điểm hôm qua đổi chỗ và tưởng hệ thống hỏng (R-11).
  await installApi(page);
  await page.goto(PAGE);

  await expect(page.getByText(/recomputed after every sync/)).toBeVisible();
});

test('ngày thiếu snapshot được báo rõ, KHÔNG bị giấu đi', async ({ page }) => {
  await installApi(page, {
    dataHealth: {
      missingSnapshotDays: ['2026-03-04'],
      missingEstimateRatio: 0,
      unclassifiedPhaseRatio: 0,
      missingWbsDateRatio: 0,
    },
  });
  await page.goto(PAGE);

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('1 days have no snapshot');
  await expect(alert).toContainText('2026-03-04');
  await expect(alert).toContainText('instead of joining across them');
});

test('ngày phát sinh việc hiện dấu mốc kèm Sub-task gây ra', async ({ page }) => {
  await installApi(page, {
    markers: [
      {
        date: '2026-03-04',
        type: 'SCOPE_ADDED',
        amount: 30,
        detail: '30h of work was added on this day.',
        causedByKeys: ['PAY-13', 'PAY-14'],
      },
    ],
  });
  await page.goto(PAGE);

  const markers = page.getByRole('heading', { name: 'Chart markers' });
  await expect(markers).toBeVisible();
  await expect(page.getByText('30h of work was added')).toBeVisible();
  await expect(page.getByText('PAY-13, PAY-14')).toBeVisible();
});

test('kế hoạch bị lùi quá ngưỡng thì báo động ngay trên màn hình', async ({ page }) => {
  await installApi(page, {
    planShiftSummary: { totalShiftedWorkdays: 6, shiftCount: 2, warningLevel: 'CRITICAL' },
  });
  await page.goto(PAGE);

  await expect(page.getByText(/6 working days/)).toBeVisible();
  await expect(page.getByText('CRITICAL')).toBeVisible();
});

test('bấm vào biểu đồ mở bảng giải thích có ghi quy tắc đã áp dụng', async ({ page }) => {
  const counts = await installApi(page);
  await page.goto(PAGE);
  await expect(page.getByText('Whole Epic · Actual')).toBeVisible();

  // Chỉ gọi API giải thích KHI người dùng bấm.
  expect(counts.explain).toBe(0);

  await page.locator('.recharts-wrapper').click({ position: { x: 300, y: 200 } });

  await expect(page.getByRole('heading', { name: /number comes from/ })).toBeVisible();

  // Huy hiệu quy tắc: khớp CHÍNH XÁC, vì câu giải thích dài bên dưới cũng bắt
  // đầu bằng "Quy tắc 2 —" và khớp gần đúng sẽ trúng nhiều phần tử.
  await expect(page.getByText('Rule 2', { exact: true })).toBeVisible();

  // Đây là thứ runbook bảo đi tìm: ai sửa tay, sửa thành bao nhiêu, lúc nào.
  const ruleCell = page.getByRole('cell').filter({ hasText: 'Rule 2 —' });
  await expect(ruleCell).toContainText('Manually set to 5h');
  await expect(ruleCell).toContainText('by thuy');
});

test('chưa chọn Epic thì hiện bộ chọn Epic active để bấm thẳng, không để ngõ cụt', async ({ page }) => {
  await installApi(page);
  await page.goto('/burndown');

  // Thay cho ô trống "sang màn Epics": danh sách Epic active kèm mã + tiêu đề.
  await expect(page.getByRole('heading', { name: 'Pick an Epic to chart' })).toBeVisible();
  const choice = page.getByRole('button', { name: /PAY-1/ });
  await expect(choice).toContainText('Thanh toán');
  // Epic đang tạm dừng KHÔNG lọt vào danh sách.
  await expect(page.getByRole('button', { name: /PAY-9/ })).toHaveCount(0);

  // Bấm một Epic là nạp chart ngay tại chỗ, không phải rời màn hình.
  await choice.click();
  await expect(page).toHaveURL(/epic=PAY-1/);
  await expect(page.getByText('Whole Epic · Actual')).toBeVisible();
});
