import { expect, test, type Page } from '@playwright/test';

/**
 * E2E bảng Signboard — US-13, US-14, US-15.
 */

const TASK_COLUMNS = [
  { taskCode: 'Create', label: 'Create' },
  { taskCode: 'BALReview', label: 'BAL review' },
  { taskCode: 'JMReview', label: 'JM review' },
];

// Mặc định: MỘT Sub-phase để các assertion cũ (một header 'Create') vẫn đúng.
const COLUMN_GROUPS = [
  { subPhaseKey: 'design', subPhaseLabel: 'Design', taskColumns: TASK_COLUMNS },
];
const FLAT_COLUMNS = TASK_COLUMNS.map((c) => ({ ...c, subPhaseKey: 'design' }));

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
    columnGroups: COLUMN_GROUPS,
    columns: FLAT_COLUMNS,
    rows: [
      {
        functionKey: 'login',
        functionName: 'Login',
        cells: [
          cell('COMPLETED', [ticket('S-1', 'COMPLETED')]),
          cell('DELAY_END', [ticket('S-2', 'DELAY_START'), ticket('S-3', 'DELAY_END')]),
          EMPTY,
        ],
        subtotals: [cell('DELAY_END', [ticket('S-3', 'DELAY_END')])],
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
        subtotals: [cell('NO_PLAN', [ticket('S-4', 'NO_PLAN')])],
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

function phasesBody(over: Record<string, unknown> = {}) {
  return {
    epicKey: 'PAY-1',
    phases: [{ phaseCode: 'DESIGN', label: 'Design', subtaskCount: 5 }],
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

async function installApi(
  page: Page,
  over: {
    board?: Record<string, unknown>;
    unparsed?: Record<string, unknown>;
    phases?: Record<string, unknown>;
  } = {},
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
      // Bộ chọn Phase gọi endpoint này — phải trả ĐÚNG hình dạng phases, nếu
      // không PhaseNav báo lỗi và trên trang có thêm một `role="alert"` thứ hai.
      if (path.endsWith('/phases')) {
        await route.fulfill(json(phasesBody(over.phases)));
        return;
      }
      if (path.includes('/signboard/epic/')) {
        await route.fulfill(json(boardBody(over.board)));
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

  // Chỉ MỘT Sub-phase → không có gì để xếp thứ tự, link khai thứ tự Sub-phase
  // không được hiện kẻo gây nhiễu.
  await expect(page.getByRole('link', { name: 'Set sub-phase order' })).toHaveCount(0);
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

  // Rê vào ô task mở thẻ "mở/copy ticket": mỗi ticket một dòng, kèm trạng thái
  // riêng để PM nhảy thẳng sang đúng cái đang trễ.
  const merged = page.locator('.cell', { hasText: '≡2' });
  await merged.hover();

  const card = page.getByRole('dialog');
  await expect(card).toContainText('S-2');
  await expect(card).toContainText('Late start');
  await expect(card).toContainText('S-3');
  await expect(card).toContainText('Late finish');
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

  // Ô trống được tô XÁM cả ô (td.signboard__empty); ô NO_PLAN thì KHÔNG — nó có
  // việc, chỉ thiếu ngày, nên phải nổi lên chứ không lùi ra sau (§6.6).
  await expect(page.locator('td.signboard__empty').first()).toBeVisible();
  await expect(page.locator('td.signboard__empty .cell--no-plan')).toHaveCount(0);
});

test('ô được tô NỀN theo trạng thái (Done đen, trễ đỏ); NO_PLAN thì không tô', async ({ page }) => {
  await installApi(page);
  await page.goto(PAGE);

  // `data-status` nằm trên <td> để phủ màu HẾT ô, không chỉ badge nhỏ.
  await expect(page.locator('td[data-status="COMPLETED"]').first()).toBeVisible();
  await expect(page.locator('td[data-status="DELAY_END"]').first()).toBeVisible();
  // NO_PLAN có trong mock nhưng KHÔNG được tô — giữ kẻ sọc riêng (§6.6).
  await expect(page.locator('td[data-status="NO_PLAN"]')).toHaveCount(0);

  // Thanh tóm tắt là chú giải: chip số đếm dùng CHUNG màu nền theo trạng thái.
  await expect(page.locator('.signboard__count[data-status="COMPLETED"]')).toBeVisible();
  await expect(page.locator('.signboard__count[data-status="DELAY_END"]')).toBeVisible();

  // Ô "không có task" (ô trống, xám) cũng được ghi vào chú giải kèm số đếm.
  await expect(page.locator('.signboard__count--empty')).toHaveText('3');
});

test('ô "chưa bắt đầu" (NYS) KHÔNG được tô nền', async ({ page }) => {
  const nys = cell('NYS', [ticket('S-2', 'NYS')]);
  await installApi(page, {
    board: {
      rows: [
        {
          functionKey: 'login',
          functionName: 'Login',
          cells: [nys, EMPTY, EMPTY],
          subtotals: [nys],
          total: nys,
        },
      ],
      summary: { byStatus: { NYS: 1 }, emptyCells: 2, totalCells: 3 },
    },
  });
  await page.goto(PAGE);

  await expect(page.getByRole('rowheader', { name: 'Login' })).toBeVisible();
  await expect(page.locator('td[data-status="NYS"]')).toHaveCount(0);
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
          subtotals: [cell('COMPLETED', [ticket('S-1', 'COMPLETED')])],
          total: cell('COMPLETED', [ticket('S-1', 'COMPLETED')]),
        },
      ],
    },
  });
  await page.goto(PAGE);

  await page.getByLabel('Search Functions').fill('login');
  await expect(page.getByRole('rowheader', { name: 'Ｌｏｇｉｎ' })).toBeVisible();
});

test('nhiều Sub-phase thì hiện header nhóm và cột lặp dưới từng nhóm', async ({ page }) => {
  // Phase có 2 Sub-phase: cột loại task lặp lại dưới mỗi nhóm, xếp tuần tự ngang.
  const twoGroups = [
    { subPhaseKey: 'fut_confirmpoint', subPhaseLabel: 'FUT_ConfirmPoint', taskColumns: TASK_COLUMNS },
    { subPhaseKey: 'fut_testcase', subPhaseLabel: 'FUT_TestCase', taskColumns: TASK_COLUMNS },
  ];
  const flat = twoGroups.flatMap((g) =>
    g.taskColumns.map((c) => ({ ...c, subPhaseKey: g.subPhaseKey })),
  );

  await installApi(page, {
    board: {
      columnGroups: twoGroups,
      columns: flat,
      rows: [
        {
          functionKey: 'login',
          functionName: 'Login',
          // 2 nhóm × 3 loại task = 6 ô lá; nhóm ConfirmPoint xong, TestCase trễ.
          cells: [
            cell('COMPLETED', [ticket('S-1', 'COMPLETED')]),
            EMPTY,
            EMPTY,
            cell('DELAY_END', [ticket('S-2', 'DELAY_END')]),
            EMPTY,
            EMPTY,
          ],
          subtotals: [
            cell('COMPLETED', [ticket('S-1', 'COMPLETED')]),
            cell('DELAY_END', [ticket('S-2', 'DELAY_END')]),
          ],
          total: cell('DELAY_END', [ticket('S-2', 'DELAY_END')]),
        },
      ],
      summary: { byStatus: { COMPLETED: 1, DELAY_END: 1 }, emptyCells: 4, totalCells: 6 },
    },
  });
  await page.goto(PAGE);

  // Hai header nhóm Sub-phase hiện ra.
  await expect(page.getByRole('columnheader', { name: 'FUT_ConfirmPoint' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'FUT_TestCase' })).toBeVisible();
  // Loại task 'Create' lặp lại ở CẢ HAI nhóm → có đúng 2 header cùng tên.
  await expect(page.getByRole('columnheader', { name: 'Create', exact: true })).toHaveCount(2);
  // ≥2 Sub-phase: mỗi nhóm có cột Σ riêng để so với nhau (khác cột Overall). Một
  // Sub-phase thì Σ bị bỏ vì trùng Overall — xem test đơn Sub-phase ở unit test.
  await expect(page.getByRole('columnheader', { name: 'Σ' })).toHaveCount(2);

  // Nhiều nhóm → hiện link mở khu "⑤ Sub-phase order" ở màn Signboard columns,
  // kèm sẵn Phase đang xem + các Sub-phase đang có (khoá đã chuẩn hoá) để điền
  // trước — không có nó PM đi tìm nút setting không tồn tại trên màn này.
  await expect(page.getByRole('link', { name: 'Set sub-phase order' })).toHaveAttribute(
    'href',
    '/config/signboard?orderPhase=DESIGN&subs=fut_confirmpoint%2Cfut_testcase',
  );
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

test('chưa chọn Epic thì hiện bộ chọn Epic active để bấm thẳng', async ({ page }) => {
  await installApi(page);
  await page.goto('/signboard');

  await expect(page.getByRole('heading', { name: 'Pick an Epic for the Signboard' })).toBeVisible();
  const choice = page.getByRole('button', { name: /PAY-1/ });
  await expect(choice).toContainText('Thanh toán');
  // Epic đang tạm dừng KHÔNG lọt vào danh sách.
  await expect(page.getByRole('button', { name: /PAY-9/ })).toHaveCount(0);

  // Bấm một Epic → Epic vào URL và hiện thanh chọn Phase ngay tại chỗ.
  await choice.click();
  await expect(page).toHaveURL(/epic=PAY-1/);
  await expect(page.getByRole('button', { name: /Design/ })).toBeVisible();
});

test('bấm Change Epic thì quay lại bộ chọn Epic', async ({ page }) => {
  await installApi(page);
  await page.goto('/signboard?epic=PAY-1&phase=DESIGN');
  await expect(page.getByRole('rowheader', { name: 'Login' })).toBeVisible();

  await page.getByRole('button', { name: 'Change Epic' }).click();
  await expect(page.getByRole('heading', { name: 'Pick an Epic for the Signboard' })).toBeVisible();
});

const TWO_PHASES = {
  phases: {
    phases: [
      { phaseCode: 'DESIGN', label: 'Design', subtaskCount: 5 },
      { phaseCode: 'CODING', label: 'Coding', subtaskCount: 8 },
    ],
  },
};

test('chọn nhiều Phase thì mỗi Phase một bảng, có tiêu đề riêng', async ({ page }) => {
  await installApi(page, TWO_PHASES);
  await page.goto('/signboard?epic=PAY-1&phases=DESIGN,CODING');

  // Hai tiêu đề Phase (nhãn + mã) cho hai bảng xếp chồng nhau.
  await expect(page.getByRole('heading', { name: /Design/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Coding/ })).toBeVisible();
  // Nút “Whole epic” có mặt để mở toàn bộ Epic một cú bấm.
  await expect(page.getByRole('button', { name: 'Whole epic' })).toBeVisible();
  // Mỗi bảng vẫn có ma trận của nó → rowheader Login xuất hiện ở CẢ HAI bảng.
  await expect(page.getByRole('rowheader', { name: 'Login' })).toHaveCount(2);
});

test('“Whole epic” mở mọi Phase của Epic', async ({ page }) => {
  await installApi(page, TWO_PHASES);
  await page.goto('/signboard?epic=PAY-1');

  await page.getByRole('button', { name: 'Whole epic' }).click();

  // URL rút gọn về token __all__ để lựa chọn bám theo danh sách Phase hiện tại.
  await expect(page).toHaveURL(/phases=__all__/);
  await expect(page.getByRole('heading', { name: /Design/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Coding/ })).toBeVisible();
});
