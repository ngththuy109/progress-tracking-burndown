import { describe, it, expect, beforeEach } from 'vitest';
import { JiraClient, TokenBucketRateLimiter, InMemoryTokenBucketStore, type ResolvedFieldMapping } from '@app/jira';
import type { ConfigPayload, EffectiveConfig } from '@app/shared';
import { syncEpic, type SyncEpicOptions } from './sync-epic.job.js';
import { toJqlTimestamp, skewedWatermark, WATERMARK_SKEW_MINUTES } from '../pipeline/fetch-epic-tree.js';
import { FakeJira, FakeStore, portsOf, type FakeIssue, type FakeJiraOptions } from '../test-fakes.js';

const FIELDS: ResolvedFieldMapping = {
  wbsStartDate: 'customfield_10100',
  wbsEndDate: 'customfield_10101',
};

const PAYLOAD: ConfigPayload = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[Phase] {name}', sortOrder: 1 }],
  subtaskPatterns: [
    { patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 },
  ],
  phaseDefinitions: [
    { phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 1 },
    { phaseCode: 'DEVELOPMENT', labelVi: 'Phát triển', displayOrder: 2 },
    { phaseCode: 'TESTING', labelVi: 'Kiểm thử', displayOrder: 3 },
  ],
  matchRules: [
    { keyword: 'Development', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 40 },
    { keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
    { keyword: 'Test', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 50 },
  ],
  signboardColumns: [
    { taskCode: 'Create', labelVi: 'Tạo mới', side: 'VN', displayOrder: 1 },
    { taskCode: 'BALReview', labelVi: 'BAL review', side: 'VN', displayOrder: 2 },
  ],
  subPhaseOrders: [],
};

const CONFIG: EffectiveConfig = {
  ...PAYLOAD,
  projectKey: null,
  globalVersion: 1,
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

/** Đồng hồ đóng băng — trạng thái và watermark đều phụ thuộc thời gian. */
const NOW = new Date('2026-03-10T02:00:00.000Z');

/** Cây mẫu: 1 Epic, 3 Phase, 25 Sub-task. */
function sampleTree(): FakeIssue[] {
  const issues: FakeIssue[] = [
    { id: '1000', key: 'PAY-100', type: 'EPIC', summary: 'Cổng thanh toán' },
    { id: '1001', key: 'PAY-101', type: 'TASK', parent: 'PAY-100', summary: '[Phase] Design' },
    { id: '1002', key: 'PAY-102', type: 'TASK', parent: 'PAY-100', summary: '[Phase] Development' },
    { id: '1003', key: 'PAY-103', type: 'TASK', parent: 'PAY-100', summary: '[Phase] Test' },
  ];
  for (let i = 0; i < 25; i++) {
    const parent = ['PAY-101', 'PAY-102', 'PAY-103'][i % 3]!;
    const phase = ['Design', 'Development', 'Test'][i % 3]!;
    issues.push({
      id: String(2000 + i),
      key: `PAY-${200 + i}`,
      type: 'SUBTASK',
      parent,
      summary: `[PAY][TeamA][${phase}][Login${i}]_Create`,
      originalEstimate: 3600,
      remainingEstimate: 3600,
      wbsStart: '2026-03-02',
      wbsEnd: '2026-03-06',
    });
  }
  return issues;
}

let store: FakeStore;

function makeClient(jira: FakeJira): JiraClient {
  return new JiraClient({
    credentials: {
      get: () => Promise.resolve({ baseUrl: 'https://x.atlassian.net', authHeader: 'Basic xxx' }),
    },
    // Hạn mức rất cao để test không bị chính bộ giãn tốc độ làm chậm — thứ cần
    // kiểm chứng ở đây là giới hạn SONG SONG (8), không phải giới hạn tốc độ.
    rateLimiter: new TokenBucketRateLimiter({
      store: new InMemoryTokenBucketStore(() => Date.now()),
      ratePerSec: 100_000,
      burst: 100_000,
    }),
    fetchImpl: jira.fetchImpl,
    retry: { sleep: () => Promise.resolve() },
  });
}

function run(opts: FakeJiraOptions, epicKey = 'PAY-100', options: SyncEpicOptions = {}) {
  const jira = new FakeJira(opts);
  const client = makeClient(jira);
  const ports = portsOf(store);
  return {
    jira,
    result: syncEpic(
      { jira: client, fields: FIELDS, config: CONFIG, ...ports, now: () => NOW },
      epicKey,
      options,
    ),
  };
}

beforeEach(() => {
  store = new FakeStore();
  store.epicState.set('PAY-100', { status: 'BACKFILLING', lastSyncedAt: null, lastError: null });
});

describe('lấy dữ liệu', () => {
  it('lấy đủ cây Epic 3 Phase 25 Sub-task bằng đúng 2 lần gọi search', async () => {
    const { jira, result } = run({ issues: sampleTree() });
    const r = await result;

    expect(jira.searchCount).toBe(2);
    expect(r.issuesRead).toBe(29); // 1 Epic + 3 Task + 25 Sub-task
    expect(r.status).toBe('SUCCESS');
  });

  it('worklog và changelog được gọi song song, không quá 8 request đồng thời', async () => {
    const issues = sampleTree();
    const { jira, result } = run({ issues });
    await result;

    // 28 issue × 2 loại lịch sử = 56 request, nếu tuần tự thì maxConcurrent = 1
    expect(jira.maxConcurrent).toBeGreaterThan(1);
    expect(jira.maxConcurrent).toBeLessThanOrEqual(8);
  });

  it('đồng bộ tăng dần chỉ tải Sub-task có updated mới hơn watermark', async () => {
    const issues = sampleTree();
    issues[4]!.updated = '2026-03-09T00:00:00.000+0000'; // mới
    for (let i = 5; i < issues.length; i++) issues[i]!.updated = '2026-01-01T00:00:00.000+0000';

    store.epicState.set('PAY-100', {
      status: 'ACTIVE',
      lastSyncedAt: new Date('2026-03-08T00:00:00.000Z'),
      lastError: null,
    });

    const { result } = run({ issues });
    const r = await result;

    // 1 Epic + 3 Task (luôn lấy, vì là câu hỏi về CẤU TRÚC) + 1 Sub-task mới
    expect(r.issuesRead).toBe(5);
  });

  it('watermark bị trừ lùi 5 phút trong JQL', async () => {
    const lastSynced = new Date('2026-03-08T10:00:00.000Z');
    store.epicState.set('PAY-100', { status: 'ACTIVE', lastSyncedAt: lastSynced, lastError: null });

    const { jira, result } = run({ issues: sampleTree() });
    await result;

    expect(jira.jqls[1]).toContain('updated >= "2026-03-08 09:55"');
    expect(skewedWatermark(lastSynced)!.getTime()).toBe(
      lastSynced.getTime() - WATERMARK_SKEW_MINUTES * 60_000,
    );
  });

  it('mốc thời gian JQL KHÔNG dùng định dạng ISO', async () => {
    // Jira từ chối chuỗi ISO đầy đủ trong JQL
    expect(toJqlTimestamp(new Date('2026-03-08T09:55:00.000Z'))).toBe('2026-03-08 09:55');
  });

  it('lần đầu (chưa có watermark) thì JQL KHÔNG có điều kiện updated', async () => {
    const { jira, result } = run({ issues: sampleTree() });
    await result;
    expect(jira.jqls[1]).not.toContain('updated >=');
  });

  it('ignoreWatermark = true thì BỎ QUA watermark và đọc lại toàn bộ', async () => {
    // Nửa đầu của lệnh `{"full":true}` trong runbook. Không có nó thì "dựng lại
    // toàn bộ lịch sử" chỉ tính lại từ dữ liệu thô đang có — mà nếu dữ liệu thô
    // mới là thứ bị thiếu thì tính lại bao nhiêu lần cũng ra sai y hệt.
    store.epicState.set('PAY-100', {
      status: 'ACTIVE',
      lastSyncedAt: new Date('2026-03-08T10:00:00.000Z'),
      lastError: null,
    });

    const { jira, result } = run({ issues: sampleTree() }, 'PAY-100', { ignoreWatermark: true });
    await result;

    expect(jira.jqls[1]).not.toContain('updated >=');
  });

  it('đọc lại toàn bộ được ghi là BACKFILL, không phải DAILY', async () => {
    // /ops phải phân biệt được lượt chạy 18 giây với lượt chạy 4 giây, nếu không
    // thì "job đêm nay chậm bất thường" trông giống hệt một lỗi.
    store.epicState.set('PAY-100', {
      status: 'ACTIVE',
      lastSyncedAt: new Date('2026-03-08T10:00:00.000Z'),
      lastError: null,
    });

    await run({ issues: sampleTree() }, 'PAY-100', { ignoreWatermark: true }).result;

    expect(store.runs.at(-1)!.runType).toBe('BACKFILL');
  });
});

describe('phân tách tiêu đề', () => {
  it('Sub-task lấy phase_code từ Task cha, KHÔNG lấy từ [Phase] trong tiêu đề của nó', async () => {
    const issues: FakeIssue[] = [
      { id: '1000', key: 'PAY-100', type: 'EPIC', summary: 'Epic' },
      { id: '1001', key: 'PAY-101', type: 'TASK', parent: 'PAY-100', summary: '[Phase] Design' },
      {
        id: '2001',
        key: 'PAY-201',
        type: 'SUBTASK',
        parent: 'PAY-101',
        // Tiêu đề ghi Development, nhưng Task cha là Design
        summary: '[PAY][TeamA][Development][Login]_Create',
        originalEstimate: 3600,
      },
    ];
    const { result } = run({ issues });
    await result;

    const sub = store.issues.get('PAY-201')!;
    expect(sub.phaseCode).toBe('DESIGN'); // Task cha thắng
    expect(sub.sbPhaseRaw).toBe('Development'); // giữ lại, nhưng chỉ để đối chiếu
  });

  it('Phase lệch sinh cảnh báo PHASE_MISMATCH', async () => {
    const issues: FakeIssue[] = [
      { id: '1000', key: 'PAY-100', type: 'EPIC', summary: 'Epic' },
      { id: '1001', key: 'PAY-101', type: 'TASK', parent: 'PAY-100', summary: '[Phase] Design' },
      {
        id: '2001',
        key: 'PAY-201',
        type: 'SUBTASK',
        parent: 'PAY-101',
        summary: '[PAY][TeamA][Development][Login]_Create',
      },
    ];
    const { result } = run({ issues });
    const r = await result;
    expect(r.warnings.some((w) => w.code === 'PHASE_MISMATCH')).toBe(true);
  });

  it('Sub-task sai format vẫn được ghi vào DB với sb_parse_status = UNPARSED', async () => {
    const issues: FakeIssue[] = [
      { id: '1000', key: 'PAY-100', type: 'EPIC', summary: 'Epic' },
      { id: '1001', key: 'PAY-101', type: 'TASK', parent: 'PAY-100', summary: '[Phase] Design' },
      {
        id: '2001',
        key: 'PAY-201',
        type: 'SUBTASK',
        parent: 'PAY-101',
        summary: 'Họp review thiết kế với khách',
        originalEstimate: 7200,
      },
    ];
    const { result } = run({ issues });
    await result;

    const sub = store.issues.get('PAY-201');
    expect(sub).toBeDefined();
    expect(sub!.sbParseStatus).toBe('UNPARSED');
    expect(sub!.functionKey).toBeNull();
    // Vẫn thuộc Phase của Task cha, nên vẫn cộng dồn vào Burndown
    expect(sub!.phaseCode).toBe('DESIGN');
  });

  it('Sub-task sai format vẫn có đủ timeoriginalestimate để cộng dồn sau này', async () => {
    const issues: FakeIssue[] = [
      { id: '1000', key: 'PAY-100', type: 'EPIC', summary: 'Epic' },
      { id: '1001', key: 'PAY-101', type: 'TASK', parent: 'PAY-100', summary: '[Phase] Design' },
      {
        id: '2001',
        key: 'PAY-201',
        type: 'SUBTASK',
        parent: 'PAY-101',
        summary: 'Tiêu đề sai hết',
        originalEstimate: 7200,
        remainingEstimate: 3600,
        timeSpent: 3600,
      },
    ];
    const { result } = run({ issues });
    await result;

    const sub = store.issues.get('PAY-201')!;
    expect(sub.originalEstimateS).toBe(7200n);
    expect(sub.remainingEstimateS).toBe(3600n);
    expect(sub.timeSpentS).toBe(3600n);
  });

  it('ngày wbs_* được đọc và lưu lại', async () => {
    const { result } = run({ issues: sampleTree() });
    await result;
    const sub = store.issues.get('PAY-200')!;
    expect(sub.wbsStartDate?.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(sub.wbsEndDate?.toISOString()).toBe('2026-03-06T00:00:00.000Z');
  });

  it('chỉ đọc statusCategory.key, không đụng tới status.name', async () => {
    const issues = sampleTree();
    issues[1]!.statusCategory = 'done';
    issues[1]!.statusId = '10001';
    const { result } = run({ issues });
    await result;
    expect(store.issues.get('PAY-101')!.statusCategory).toBe('done');
    expect(store.issues.get('PAY-101')!.statusId).toBe('10001');
  });
});

describe('idempotency', () => {
  it('chạy job 2 lần liên tiếp cho ra dữ liệu byte-for-byte giống nhau', async () => {
    const issues = sampleTree();
    const worklogs = [
      { id: '9001', issueId: '2000', issueKey: 'PAY-200', seconds: 3600, started: '2026-03-05T01:00:00.000+0000', created: '2026-03-05T02:00:00.000+0000' },
    ];

    await run({ issues, worklogs }).result;
    const first = store.snapshot();

    // Lần hai chạy lại y hệt, kể cả watermark (đồng hồ đóng băng)
    store.epicState.set('PAY-100', { status: 'ACTIVE', lastSyncedAt: null, lastError: null });
    await run({ issues, worklogs }).result;

    expect(store.snapshot()).toBe(first);
  });

  it('worklog_id trùng không tạo dòng thứ hai', async () => {
    const worklogs = [
      { id: '9001', issueId: '2000', issueKey: 'PAY-200', seconds: 3600, started: '2026-03-05T01:00:00.000+0000', created: '2026-03-05T02:00:00.000+0000' },
      { id: '9001', issueId: '2000', issueKey: 'PAY-200', seconds: 3600, started: '2026-03-05T01:00:00.000+0000', created: '2026-03-05T02:00:00.000+0000' },
    ];
    await run({ issues: sampleTree(), worklogs }).result;
    expect(store.worklogRows.size).toBe(1);
  });

  it('changelog trùng (issue, historyId, field) không tạo dòng thứ hai', async () => {
    const changelog = [
      { issueKey: 'PAY-200', historyId: '5001', created: '2026-03-05T02:00:00.000+0000', items: [{ field: 'status', from: '1', to: '3' }] },
      { issueKey: 'PAY-200', historyId: '5001', created: '2026-03-05T02:00:00.000+0000', items: [{ field: 'status', from: '1', to: '3' }] },
    ];
    await run({ issues: sampleTree(), changelog }).result;
    expect(store.changelogRows.size).toBe(1);
  });
});

describe('xoá mềm', () => {
  it('issue biến mất khỏi Jira thì được đặt removed_at, KHÔNG bị xoá cứng', async () => {
    const issues = sampleTree();
    await run({ issues }).result;
    expect(store.issues.get('PAY-224')!.removedAt).toBeNull();

    // Lần đồng bộ sau, Sub-task cuối biến mất
    await run({ issues: issues.slice(0, -1) }).result;

    const gone = store.issues.get('PAY-224');
    expect(gone).toBeDefined(); // dòng vẫn còn
    expect(gone!.removedAt).toEqual(NOW);
  });

  it('issue xuất hiện lại thì removed_at được bỏ đi', async () => {
    const issues = sampleTree();
    await run({ issues: issues.slice(0, -1) }).result;
    expect(store.issues.has('PAY-224')).toBe(false);

    // Gắn Sub-task trở lại Epic là một thay đổi trên Jira, nên `updated` được
    // Jira đẩy lên mốc mới — nhờ vậy đồng bộ tăng dần vẫn tải nó về.
    issues[issues.length - 1]!.updated = '2026-03-10T01:59:00.000+0000';
    await run({ issues }).result;

    expect(store.issues.get('PAY-224')!.removedAt).toBeNull();
  });

  it('đồng bộ TĂNG DẦN không xoá mềm nhầm phần không đổi', async () => {
    const issues = sampleTree();
    await run({ issues }).result;

    // Chuyển sang tăng dần: chỉ 1 Sub-task đổi
    for (const i of issues) i.updated = '2026-01-01T00:00:00.000+0000';
    issues[4]!.updated = '2026-03-09T00:00:00.000+0000';
    store.epicState.set('PAY-100', {
      status: 'ACTIVE',
      lastSyncedAt: new Date('2026-03-08T00:00:00.000Z'),
      lastError: null,
    });

    const r = await run({ issues }).result;
    expect(r.removed).toBe(0);
    expect([...store.issues.values()].filter((i) => i.removedAt !== null)).toHaveLength(0);
  });

  it('worklog bị xoá trên Jira thì is_deleted = true, dòng vẫn còn', async () => {
    const worklogs = [
      { id: '9001', issueId: '2000', issueKey: 'PAY-200', seconds: 3600, started: '2026-03-05T01:00:00.000+0000', created: '2026-03-05T02:00:00.000+0000' },
    ];
    await run({ issues: sampleTree(), worklogs }).result;
    expect(store.worklogRows.get('9001')!.isDeleted).toBe(false);

    store.epicState.set('PAY-100', {
      status: 'ACTIVE',
      lastSyncedAt: new Date('2026-03-08T00:00:00.000Z'),
      lastError: null,
    });
    const r = await run({ issues: sampleTree(), worklogs, deletedWorklogIds: [9001] }).result;

    expect(r.worklogsDeleted).toBe(1);
    expect(store.worklogRows.get('9001')).toBeDefined();
    expect(store.worklogRows.get('9001')!.isDeleted).toBe(true);
  });

  it('full resync đánh dấu worklog đã biến mất khỏi Jira, dù /worklog/deleted rỗng', async () => {
    // Task đã Done, log giờ 10/8 và 11/8 → cả hai được ghi (actual = 10/8~11/8).
    const both = [
      { id: '9001', issueId: '2000', issueKey: 'PAY-200', seconds: 3600, started: '2026-08-10T01:00:00.000+0000', created: '2026-08-10T02:00:00.000+0000' },
      { id: '9002', issueId: '2000', issueKey: 'PAY-200', seconds: 3600, started: '2026-08-11T01:00:00.000+0000', created: '2026-08-11T02:00:00.000+0000' },
    ];
    await run({ issues: sampleTree(), worklogs: both }).result;
    expect(store.worklogRows.get('9002')!.isDeleted).toBe(false);

    // Phát hiện log nhầm → xoá worklog 11/8 trên Jira → chạy lại FULL RESYNC.
    // Jira KHÔNG còn trả 9002, và /worklog/deleted rỗng vì full resync không có
    // mốc `since`. Trước khi sửa, 9002 kẹt ở is_deleted=false nên actual_end vẫn
    // là 11/8 chứ không lùi về 10/8.
    const r = await run(
      { issues: sampleTree(), worklogs: [both[0]!] },
      'PAY-100',
      { ignoreWatermark: true },
    ).result;

    expect(r.worklogsDeleted).toBe(1);
    expect(store.worklogRows.get('9002')).toBeDefined(); // dòng vẫn còn (E-17)
    expect(store.worklogRows.get('9002')!.isDeleted).toBe(true);
    // 10/8 vẫn sống — chỉ worklog thật sự biến mất mới bị đánh dấu.
    expect(store.worklogRows.get('9001')!.isDeleted).toBe(false);
  });

  it('full resync đối soát đúng cả khi worklog cuối cùng của issue bị xoá', async () => {
    // Chỉ có đúng một worklog: xoá nó đi thì lượt lấy đầy đủ trả về rỗng cho
    // issue. Vẫn phải đánh dấu, nếu không "issue không còn worklog" sẽ bị bỏ sót.
    const one = [
      { id: '9003', issueId: '2001', issueKey: 'PAY-201', seconds: 3600, started: '2026-08-10T01:00:00.000+0000', created: '2026-08-10T02:00:00.000+0000' },
    ];
    await run({ issues: sampleTree(), worklogs: one }).result;
    expect(store.worklogRows.get('9003')!.isDeleted).toBe(false);

    const r = await run({ issues: sampleTree(), worklogs: [] }, 'PAY-100', {
      ignoreWatermark: true,
    }).result;

    expect(r.worklogsDeleted).toBe(1);
    expect(store.worklogRows.get('9003')!.isDeleted).toBe(true);
  });

  it('đồng bộ TĂNG DẦN KHÔNG đối soát xoá nhầm worklog không đổi', async () => {
    // Đối soát chỉ an toàn khi có TẬP ĐẦY ĐỦ (full resync). Ở chế độ tăng dần,
    // worklog lấy về chỉ gồm bản vừa đổi — đối soát sẽ xoá nhầm sạch phần còn lại.
    const both = [
      { id: '9001', issueId: '2000', issueKey: 'PAY-200', seconds: 3600, started: '2026-03-05T01:00:00.000+0000', created: '2026-03-05T02:00:00.000+0000' },
      { id: '9002', issueId: '2000', issueKey: 'PAY-200', seconds: 3600, started: '2026-03-06T01:00:00.000+0000', created: '2026-03-06T02:00:00.000+0000' },
    ];
    await run({ issues: sampleTree(), worklogs: both }).result;

    // Chuyển sang tăng dần: chỉ 9001 nằm trong cửa sổ /worklog/updated.
    store.epicState.set('PAY-100', {
      status: 'ACTIVE',
      lastSyncedAt: new Date('2026-03-08T00:00:00.000Z'),
      lastError: null,
    });
    const r = await run({ issues: sampleTree(), worklogs: [both[0]!] }).result;

    expect(r.worklogsDeleted).toBe(0);
    expect(store.worklogRows.get('9002')!.isDeleted).toBe(false);
  });
});

describe('Epic bị xoá trên Jira', () => {
  it('Resync một Epic đã bị xoá KHÔNG đổ lỗi mà xoá mềm toàn bộ issue', async () => {
    // Lần đầu: Epic còn sống, lấy đủ cây về (1 Epic + 3 Task + 25 Sub-task).
    const issues = sampleTree();
    await run({ issues }).result;
    const countBefore = store.issues.size;
    expect(countBefore).toBe(29);
    expect([...store.issues.values()].every((i) => i.removedAt === null)).toBe(true);

    // Epic bị xoá trên Jira. Resync (Quick — có watermark): JQL `key = "PAY-100"`
    // trả HTTP 400 "does not exist". Trước khi sửa, job đổ ở FETCH_TREE và Epic
    // kẹt ở ERROR, Resync lại chỉ lặp lại đúng lỗi đó.
    store.epicState.set('PAY-100', {
      status: 'ACTIVE',
      lastSyncedAt: new Date('2026-03-08T00:00:00.000Z'),
      lastError: null,
    });
    const r = await run({ issues: [] }).result;

    expect(r.status).toBe('SUCCESS');
    expect(r.errorMessage).toBeNull();
    // Mọi issue được đánh dấu đã gỡ, nhưng DÒNG VẪN CÒN (E-02 — không xoá cứng).
    expect(r.removed).toBe(countBefore);
    expect(store.issues.size).toBe(countBefore);
    expect([...store.issues.values()].every((i) => i.removedAt !== null)).toBe(true);
    // Nhật ký lần chạy là SUCCESS, và Epic KHÔNG bị đẩy sang ERROR.
    expect(store.runs.at(-1)!.status).toBe('SUCCESS');
    expect(store.epicState.get('PAY-100')!.status).not.toBe('ERROR');
    // Có cảnh báo cho vận hành biết vì sao dữ liệu bị gỡ hàng loạt.
    expect(r.warnings.some((w) => w.code === 'EPIC_DELETED_IN_JIRA')).toBe(true);
  });

  it('không gọi worklog/changelog khi Epic đã bị xoá (tránh 404 dây chuyền)', async () => {
    await run({ issues: sampleTree() }).result;

    store.epicState.set('PAY-100', {
      status: 'ACTIVE',
      lastSyncedAt: new Date('2026-03-08T00:00:00.000Z'),
      lastError: null,
    });
    const { jira, result } = run({ issues: [] });
    await result;

    // Dừng ngay sau lần search đầu tiên: không đọc lịch sử của issue con đã biến
    // mất (những lời gọi đó sẽ trả 404 và làm job đổ y như lỗi cũ).
    expect(jira.searchCount).toBe(1);
    expect(jira.paths.some((p) => p.includes('/worklog') || p.includes('/changelog'))).toBe(false);
  });

  it('Epic đã xoá đang ở BACKFILLING (sau ERROR) thì Resync đưa về ACTIVE', async () => {
    await run({ issues: sampleTree() }).result;

    // API chuyển ERROR → BACKFILLING trước khi đẩy job Resync; mô phỏng trạng thái
    // đó rồi chạy full resync (nửa đầu của `{"full":true}`).
    store.epicState.set('PAY-100', {
      status: 'BACKFILLING',
      lastSyncedAt: new Date('2026-03-08T00:00:00.000Z'),
      lastError: 'FETCH_TREE trước đó lỗi',
    });
    const r = await run({ issues: [] }, 'PAY-100', { ignoreWatermark: true }).result;

    expect(r.status).toBe('SUCCESS');
    expect(store.epicState.get('PAY-100')!.status).toBe('ACTIVE');
  });
});

describe('log giờ lùi ngày', () => {
  it('worklog có started lùi 3 ngày so với created thì Epic bị đẩy vào dirty:epics', async () => {
    const worklogs = [
      {
        id: '9001',
        issueId: '2000',
        issueKey: 'PAY-200',
        seconds: 3600,
        started: '2026-03-02T01:00:00.000+0000',
        created: '2026-03-05T01:00:00.000+0000',
      },
    ];
    const r = await run({ issues: sampleTree(), worklogs }).result;
    expect(r.retroLogDetected).toBe(true);
    expect(store.dirty.has('PAY-100')).toBe(true);
  });

  it('worklog bình thường KHÔNG đẩy Epic vào dirty:epics', async () => {
    const worklogs = [
      {
        id: '9001',
        issueId: '2000',
        issueKey: 'PAY-200',
        seconds: 3600,
        // Log lúc 9 giờ sáng cho việc làm tối qua — chuyện bình thường
        started: '2026-03-05T01:00:00.000+0000',
        created: '2026-03-05T09:00:00.000+0000',
      },
    ];
    const r = await run({ issues: sampleTree(), worklogs }).result;
    expect(r.retroLogDetected).toBe(false);
    expect(store.dirty.size).toBe(0);
  });

  it('ngày worklog lấy theo started, KHÔNG theo created', async () => {
    const worklogs = [
      {
        id: '9001',
        issueId: '2000',
        issueKey: 'PAY-200',
        seconds: 3600,
        started: '2026-03-02T01:00:00.000+0000',
        created: '2026-03-05T01:00:00.000+0000',
      },
    ];
    await run({ issues: sampleTree(), worklogs }).result;
    const w = store.worklogRows.get('9001')!;
    expect(w.startedAt.toISOString()).toBe('2026-03-02T01:00:00.000Z');
    expect(w.jiraCreatedAt.toISOString()).toBe('2026-03-05T01:00:00.000Z');
  });
});

describe('vòng đời và nhật ký', () => {
  it('đồng bộ xong chuyển Epic từ BACKFILLING sang ACTIVE', async () => {
    await run({ issues: sampleTree() }).result;
    expect(store.epicState.get('PAY-100')!.status).toBe('ACTIVE');
    expect(store.epicState.get('PAY-100')!.lastSyncedAt).toEqual(NOW);
  });

  it('Epic đang ACTIVE thì giữ nguyên ACTIVE sau khi đồng bộ', async () => {
    store.epicState.set('PAY-100', {
      status: 'ACTIVE',
      lastSyncedAt: new Date('2026-03-08T00:00:00.000Z'),
      lastError: null,
    });
    await run({ issues: sampleTree() }).result;
    expect(store.epicState.get('PAY-100')!.status).toBe('ACTIVE');
  });

  it('sync_run ghi đúng số lần gọi API và số lần bị 429', async () => {
    const { result } = run({ issues: sampleTree(), rateLimitFirstNCalls: 2 });
    const r = await result;

    const run1 = store.runs[0]!;
    expect(run1.status).toBe('SUCCESS');
    expect(run1.rateLimitHits).toBe(2);
    expect(r.rateLimitHits).toBe(2);
    expect(run1.apiCalls).toBe(r.apiCalls);
    expect(run1.apiCalls!).toBeGreaterThan(0);
  });

  it('sync_run được ghi NGAY TỪ ĐẦU với trạng thái RUNNING', async () => {
    const store2 = new FakeStore();
    store2.epicState.set('PAY-100', { status: 'BACKFILLING', lastSyncedAt: null, lastError: null });
    const id = await store2.start({ epicKey: 'PAY-100', runType: 'BACKFILL' });
    expect(store2.runs.find((r) => r.id === id)!.status).toBe('RUNNING');
  });

  it('Jira lỗi liên tục thì sync_run = FAILED và Epic chuyển sang ERROR', async () => {
    const { result } = run({ issues: sampleTree(), failEverything: true });
    const r = await result;

    expect(r.status).toBe('FAILED');
    expect(r.errorMessage).toBeTruthy();
    expect(store.runs[0]!.status).toBe('FAILED');
    expect(store.runs[0]!.errorMessage).toBeTruthy();
    // Màn hình Monitoring cần "lỗi ở đâu, nguyên nhân": Jira chết ngay từ lần
    // gọi đầu → bước lỗi là FETCH_TREE, và stack được giữ nguyên văn.
    expect(store.runs[0]!.errorStep).toBe('FETCH_TREE');
    expect(store.runs[0]!.errorDetail).toBeTruthy();
    expect(store.epicState.get('PAY-100')!.status).toBe('ERROR');
    // KHÔNG gỡ khỏi sổ (E-26): có thể chỉ là lỗi tạm thời
    expect(store.epicState.get('PAY-100')).toBeDefined();
  });

  it('job thất bại vẫn để lại bản ghi sync_run', async () => {
    await run({ issues: sampleTree(), failEverything: true }).result;
    expect(store.runs).toHaveLength(1);
  });

  it('đồng bộ Epic không có trong sổ thì ném lỗi', async () => {
    await expect(run({ issues: sampleTree() }, 'KHONG-CO').result).rejects.toThrow(
      /không có trong sổ theo dõi/,
    );
  });
});
