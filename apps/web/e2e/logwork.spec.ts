import { expect, test, type Page } from '@playwright/test';

/**
 * E2E màn "Log work" — theo dõi việc log work của member (toàn đội).
 *
 * Spec KHÔNG cần API thật: chặn `/api/**` bằng `page.route`. Trạng thái "đã
 * verify" giữ trong một biến đóng để bấm verify → POST → tải lại thấy đổi.
 */

interface Opts {
  role: 'ADMIN' | 'PM' | 'VIEWER';
  hasParticipantData: boolean;
  noMembers?: boolean;
  verified?: boolean;
}

function report(opts: Opts, verified: boolean) {
  const members = opts.noMembers
    ? []
    : [
        {
          accountId: 'u1',
          displayName: 'Nguyễn An',
          totalLoggedHours: 12.5,
          hasOpenAssignments: true,
          tickets: [
            {
              issueKey: 'PAY-11',
              epicKey: 'PAY-1',
              projectKey: 'PAY',
              summary: 'Payout retry worker',
              parentKey: null,
              phaseCode: 'DEV',
              statusCategory: 'indeterminate',
              originalEstimateHours: 8,
              memberLoggedHours: 0,
              totalLoggedHours: 0,
              notLogged: !verified,
              exempted: verified,
              exemptedBy: verified ? 'pm@example.com' : null,
              exemptedAt: verified ? '2026-08-12T00:00:00.000Z' : null,
            },
          ],
          notLoggedCount: verified ? 0 : 1,
          exemptedCount: verified ? 1 : 0,
          primaryEpicKey: 'PAY-1',
          expectedHours: 40,
          deficitHours: 27.5,
          behind: true,
        },
      ];
  return {
    from: '2026-08-10',
    to: '2026-08-16',
    members,
    totalMembers: members.length,
    totalNotLogged: verified || opts.noMembers ? 0 : 1,
    visibleEpicCount: 1,
    hasParticipantData: opts.hasParticipantData,
    partialPeriod: false,
    warnings: [],
  };
}

/**
 * Lưới PIC × ngày: bốn ngày (Fri làm, Sat/Sun nghỉ, Mon làm), hai PIC — đủ cả bốn
 * dấu: under (3h), over (9h), offday (log ngày nghỉ), missing (ngày làm việc trống).
 * `today` ở tương lai để mọi ngày đều "đã qua" (missing tính được).
 */
function byPicReport() {
  return {
    from: '2026-08-07',
    to: '2026-08-10',
    dates: ['2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10'],
    workingDays: [true, false, false, true],
    today: '2026-08-12',
    rows: [
      {
        accountId: 'u1',
        displayName: 'Nguyễn An',
        hoursByDate: [3, 2, 0, 9],
        ticketsByDate: [
          [{ issueKey: 'PAY-1', summary: 'Fix payout bug', hours: 3 }],
          [{ issueKey: 'PAY-8', summary: 'Weekend hotfix', hours: 2 }],
          [],
          [{ issueKey: 'PAY-11', summary: 'Payout retry worker', hours: 9 }],
        ],
        totalHours: 14,
        warnCount: 2,
        missingCount: 0,
        offdayCount: 1,
      },
      {
        accountId: 'u2',
        displayName: 'Trần Bình',
        hoursByDate: [0, 0, 5, 0],
        ticketsByDate: [[], [], [{ issueKey: 'PAY-13', summary: 'Sunday work', hours: 5 }], []],
        totalHours: 5,
        warnCount: 0,
        missingCount: 2,
        offdayCount: 1,
      },
    ],
    dailyTotals: [3, 2, 5, 9],
    grandTotal: 19,
    underLimitHours: 4,
    overLimitHours: 8,
    warnings: [],
  };
}

async function installApi(page: Page, opts: Opts): Promise<void> {
  const state = { verified: opts.verified ?? false };
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const json = (body: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

      if (path === '/api/logwork/by-pic') {
        await json(byPicReport());
        return;
      }
      if (path === '/api/logwork/exemptions') {
        state.verified = req.method() === 'POST';
        await json({ ok: true });
        return;
      }
      if (path === '/api/logwork/settings') {
        await json({
          defaultHoursPerDay: 8,
          projects: [{ projectKey: 'PAY', expectedHoursPerDay: null, canEdit: opts.role !== 'VIEWER' }],
        });
        return;
      }
      if (path === '/api/logwork') {
        await json(report(opts, state.verified));
        return;
      }
      if (path === '/api/me') {
        await json({ userId: 'pm@example.com', role: opts.role, projects: ['PAY'] });
        return;
      }
      await json({});
    },
  );
}

test('hiện member và ticket chưa log; PM thấy nút verify', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork');

  await expect(page.getByText('Nguyễn An').first()).toBeVisible();
  // Card mở sẵn vì còn ticket chưa log.
  await expect(page.getByText('⚠ no worklog')).toBeVisible();
  await expect(page.getByRole('button', { name: '✓ verify' })).toBeVisible();
});

test('PM bấm verify thì ticket chuyển sang "đã xác nhận"', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork');

  await page.getByRole('button', { name: '✓ verify' }).click();
  await expect(page.getByText('✔ verified')).toBeVisible();
});

test('VIEWER không thấy nút verify, chỉ thấy nhắc "PM verifies"', async ({ page }) => {
  await installApi(page, { role: 'VIEWER', hasParticipantData: true });
  await page.goto('/logwork');

  await expect(page.getByText('⚠ no worklog')).toBeVisible();
  await expect(page.getByRole('button', { name: '✓ verify' })).toHaveCount(0);
  await expect(page.getByText('PM verifies')).toBeVisible();
});

test('preset "Last week" đẩy from/to vào URL', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork');

  await page.getByRole('button', { name: 'Last week' }).click();
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}/);
  await expect(page).toHaveURL(/to=\d{4}-\d{2}-\d{2}/);
});

test('Custom: nhập khoảng ngày tuỳ ý rồi bấm Search mới đẩy vào URL', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork');

  await page.getByRole('button', { name: 'Custom' }).click();
  await page.getByLabel('From date').fill('2026-07-01');
  await page.getByLabel('To date').fill('2026-08-16');

  // Chạm ô chưa đổi URL — phải bấm Search.
  await expect(page).not.toHaveURL(/from=2026-07-01/);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/from=2026-07-01/);
  await expect(page).toHaveURL(/to=2026-08-16/);
});

test('Custom: khoảng ngược báo lỗi và không tìm', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork');

  await page.getByRole('button', { name: 'Custom' }).click();
  await page.getByLabel('From date').fill('2026-08-16');
  await page.getByLabel('To date').fill('2026-07-01');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByRole('alert')).toContainText('on or after');
  await expect(page).not.toHaveURL(/from=2026-08-16/);
});

test('search khớp mã/tiêu đề ticket; không khớp thì hiện empty-state', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork');

  const box = page.getByRole('searchbox', { name: 'Search members and tickets' });
  // Khớp tiêu đề ticket "Payout retry worker".
  await box.fill('payout');
  await expect(page.getByText('Nguyễn An').first()).toBeVisible();
  // Khớp mã ticket.
  await box.fill('PAY-11');
  await expect(page.getByText('Nguyễn An').first()).toBeVisible();
  // Không khớp gì.
  await box.fill('nobody-here');
  await expect(page.getByRole('heading', { name: 'No member matches those conditions' })).toBeVisible();
});

test('"Only not logged" giữ member còn ticket chưa log', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork');

  await page.getByRole('checkbox', { name: 'Only not logged' }).check();
  await expect(page.getByText('Nguyễn An').first()).toBeVisible();
});

test('không có participant thì nêu rõ hai khả năng trong empty-state', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: false, noMembers: true });
  await page.goto('/logwork');

  await expect(page.getByText('Request participants')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No members in view' })).toBeVisible();
});

test('tab "By PIC / day" hiện lưới giờ theo ngày, tô ô thiếu (<=4h) và quá (>8h)', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork');

  await page.getByRole('button', { name: 'By PIC / day' }).click();
  await expect(page).toHaveURL(/view=grid/);

  await expect(page.getByText('Hours logged per PIC per day')).toBeVisible();
  await expect(page.getByText('Nguyễn An')).toBeVisible();
  await expect(page.getByText('Trần Bình')).toBeVisible();

  // Đúng một ô "thiếu" (3h) và một ô "quá" (9h) được tô.
  await expect(page.locator('td.logwork-grid__cell--under')).toHaveText('3');
  await expect(page.locator('td.logwork-grid__cell--over')).toHaveText('9');
});

test('lưới đánh dấu ngày làm việc trống (missing) và ngày nghỉ có log (offday)', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork?view=grid');

  await expect(page.getByText('Hours logged per PIC per day')).toBeVisible();

  // Trần Bình bỏ trống hai ngày làm việc (Fri + Mon) → hai ô "missing".
  await expect(page.locator('td.logwork-grid__cell--missing')).toHaveCount(2);
  // Log vào ngày nghỉ: An (Sat 2h) và Bình (Sun 5h) → hai ô "offday".
  const offday = page.locator('td.logwork-grid__cell--offday');
  await expect(offday).toHaveCount(2);
  await expect(offday.filter({ hasText: '2' })).toBeVisible();
  await expect(offday.filter({ hasText: '5' })).toBeVisible();
});

test('rê vào ô có log mở thẻ liệt kê ticket đã log ngày đó (link sang Jira)', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork?view=grid');

  await expect(page.getByText('Hours logged per PIC per day')).toBeVisible();

  // Rê vào ô "quá" (9h, Mon của An) → thẻ nổi hiện ticket PAY-11 kèm tiêu đề.
  await page.locator('td.logwork-grid__cell--over').hover();
  const card = page.getByRole('dialog');
  await expect(card).toBeVisible();
  await expect(card.getByText('PAY-11')).toBeVisible();
  await expect(card.getByText('Payout retry worker')).toBeVisible();
});

test('đổi qua lại hai tab giữ nguyên kỳ; By member vẫn hoạt động', async ({ page }) => {
  await installApi(page, { role: 'PM', hasParticipantData: true });
  await page.goto('/logwork');

  await page.getByRole('button', { name: 'Last week' }).click();
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}/);

  // Sang lưới: giữ from/to, thêm view=grid.
  await page.getByRole('button', { name: 'By PIC / day' }).click();
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}/);
  await expect(page).toHaveURL(/view=grid/);

  // Quay lại By member: bỏ view=grid, vẫn thấy card member.
  await page.getByRole('button', { name: 'By member' }).click();
  await expect(page).not.toHaveURL(/view=grid/);
  await expect(page.getByText('Nguyễn An').first()).toBeVisible();
});
