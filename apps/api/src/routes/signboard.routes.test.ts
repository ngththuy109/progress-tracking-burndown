import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  type Principal,
  type SignboardPhase,
  type SignboardPhasesResponse,
  type SignboardResponse,
  type SignboardStage,
  type SignboardSubtask,
  type UnparsedResponse,
  type WorkCalendar,
} from '@app/shared';
import { registerSignboardRoutes, type SignboardReadPort } from './signboard.routes.js';
import { type ColumnSpec, type SubPhaseMetaEntry } from '../services/signboard.service.js';

const CALENDAR: WorkCalendar = {
  calendarId: 'test',
  timezone: 'Asia/Ho_Chi_Minh',
  workdaysMask: DEFAULT_WORKDAYS_MASK,
  hoursPerDay: 8,
  holidays: new Set(),
  warnings: [],
};

const COLUMNS: ColumnSpec[] = [
  { taskCode: 'Create', label: 'Tạo' },
  { taskCode: 'BALReview', label: 'BAL review' },
  { taskCode: 'JMReview', label: 'JM review' },
];

const ADMIN: Principal = { userId: 'a', role: 'ADMIN', projects: [] };

function sub(over: Partial<SignboardSubtask> & { issueKey: string }): SignboardSubtask {
  return {
    summary: `Việc ${over.issueKey}`,
    functionKey: 'login',
    functionName: 'Login',
    subPhaseRaw: 'Design',
    taskType: 'Create',
    parseStatus: 'OK',
    planStart: '2026-03-02',
    planEnd: '2026-03-06',
    actualStart: null,
    actualEnd: null,
    statusCategory: 'new',
    pics: [],
    ...over,
  };
}

class FakeReads implements SignboardReadPort {
  subtaskList: SignboardSubtask[] = [];
  columnList: ColumnSpec[] = COLUMNS;
  raw: Record<string, string | null> = {};
  phaseList: SignboardPhase[] = [];
  stageInfo: { tierLabel: string | null; items: SignboardStage[] } = { tierLabel: null, items: [] };
  subPhaseMetaMap: Map<string, SubPhaseMetaEntry> = new Map();
  queries = 0;
  /** `stage` mà route đã truyền xuống ở lần gọi gần nhất — để test khẳng định. */
  lastPhasesStage: string | null | undefined;
  lastSubtasksStage: string | null | undefined;

  async epicMeta() {
    return { projectKey: 'PAY', calendar: CALENDAR };
  }
  async phases(_epicKey: string, _projectKey: string, stage: string | null) {
    this.lastPhasesStage = stage;
    return this.phaseList;
  }
  async stages() {
    return this.stageInfo;
  }
  async subtasks(_epicKey: string, _phaseCode: string, stage: string | null) {
    this.queries += 1;
    this.lastSubtasksStage = stage;
    return this.subtaskList;
  }
  async columns() {
    return this.columnList;
  }
  async subPhaseMeta() {
    return this.subPhaseMetaMap;
  }
  async rawTaskTypes() {
    return this.raw;
  }
}

let reads: FakeReads;
let app: FastifyInstance;
let principal: Principal | null;
let now: Date;

beforeEach(async () => {
  reads = new FakeReads();
  principal = ADMIN;
  // 10/03/2026, 08:00 giờ Việt Nam.
  now = new Date('2026-03-10T01:00:00Z');

  app = Fastify();
  registerSignboardRoutes(app, {
    reads,
    resolvePrincipal: () => principal,
    now: () => now,
  });
  await app.ready();
});

async function get<T>(url: string) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T & { error?: string; message?: string } };
}

const BOARD = '/api/signboard/epic/PAY-1/phase/DESIGN';

// ---------------------------------------------------------------------------

describe('dựng bảng', () => {
  it('ba Sub-task cùng Function khác hoa thường gộp thành MỘT hàng', async () => {
    // `Login`, `login`, `Ｌｏｇｉｎ` đều có `functionKey = 'login'` (E-31).
    reads.subtaskList = [
      sub({ issueKey: 'S-1', functionName: 'Login', taskType: 'Create' }),
      sub({ issueKey: 'S-2', functionName: 'login', taskType: 'BALReview' }),
      sub({ issueKey: 'S-3', functionName: 'Ｌｏｇｉｎ', taskType: 'JMReview' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.functionKey).toBe('login');
  });

  it('tên hàng hiển thị theo dạng gặp ĐẦU TIÊN, không phải dạng đã chuẩn hoá', async () => {
    reads.subtaskList = [sub({ issueKey: 'S-1', functionName: 'Login' })];
    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.rows[0]?.functionName).toBe('Login');
  });

  it('Function không có Sub-task nào cho một cột thì ô đó là ô TRỐNG', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', taskType: 'Create' }),
      // Một Function KHÁC giữ cho hai cột còn lại có việc — nếu không, chúng bị
      // rút khỏi bảng (cột rỗng toàn tập) và không còn ô trống nào để kiểm.
      sub({ issueKey: 'S-2', functionKey: 'export', functionName: 'Export', taskType: 'BALReview' }),
      sub({ issueKey: 'S-3', functionKey: 'export', functionName: 'Export', taskType: 'JMReview' }),
    ];
    const { body } = await get<SignboardResponse>(BOARD);
    const row = body.rows.find((r) => r.functionKey === 'login');

    expect(row?.cells[0]).toMatchObject({ present: true });
    expect(row?.cells[1]).toEqual({ present: false });
    expect(row?.cells[2]).toEqual({ present: false });
  });

  it('hai Sub-task cùng ô thì ô mang trạng thái XẤU NHẤT và đếm 2 ticket', async () => {
    reads.subtaskList = [
      // Chưa bắt đầu, đã quá ngày bắt đầu → DELAY_START.
      sub({ issueKey: 'S-1', planStart: '2026-03-02', planEnd: '2026-03-20' }),
      // Đã quá ngày kết thúc → DELAY_END (xấu hơn).
      sub({ issueKey: 'S-2', planStart: '2026-03-02', planEnd: '2026-03-06', actualStart: '2026-03-03', statusCategory: 'indeterminate' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    const cell = body.rows[0]?.cells[0];

    expect(cell).toMatchObject({ present: true, status: 'DELAY_END', ticketCount: 2 });
  });

  it('cột trả về đúng thứ tự cấu hình', async () => {
    // Cấu hình xếp Create → BALReview → JMReview; dữ liệu đến theo thứ tự khác
    // cũng KHÔNG được làm đổi thứ tự cột.
    reads.subtaskList = [
      sub({ issueKey: 'S-1', taskType: 'JMReview' }),
      sub({ issueKey: 'S-2', taskType: 'Create' }),
      sub({ issueKey: 'S-3', taskType: 'BALReview' }),
    ];
    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.columns.map((c) => c.taskCode)).toEqual(['Create', 'BALReview', 'JMReview']);
  });

  it('taskType lạ KHÔNG sinh thêm cột mới', async () => {
    // Cột là do người quyết định, không phải suy ra từ dữ liệu (C-10).
    reads.subtaskList = [
      ...COLUMNS.map((c) => sub({ issueKey: `S-${c.taskCode}`, taskType: c.taskCode })),
      sub({ issueKey: 'S-9', taskType: 'Deploy', parseStatus: 'UNKNOWN_TASK_TYPE' }),
    ];
    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.columns).toHaveLength(3);
    expect(body.columns.map((c) => c.taskCode)).not.toContain('Deploy');
  });

  it('cột không có Sub-task nào thì KHÔNG được dựng', async () => {
    // Cả Phase chỉ làm khâu Create → hai cột review toàn ô trống, dựng ra chỉ
    // đẩy cột có việc ra khỏi màn hình.
    reads.subtaskList = [
      sub({ issueKey: 'S-1', functionKey: 'a', functionName: 'A', taskType: 'Create' }),
      sub({ issueKey: 'S-2', functionKey: 'b', functionName: 'B', taskType: 'Create' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.columns.map((c) => c.taskCode)).toEqual(['Create']);
    expect(body.columnGroups[0]?.taskColumns.map((c) => c.taskCode)).toEqual(['Create']);
    // `cells` vẫn 1:1 với `columns`.
    expect(body.rows.every((r) => r.cells.length === body.columns.length)).toBe(true);
  });

  it('CHỈ MỘT Function có việc ở một cột thì cột đó vẫn được dựng', async () => {
    // Rút cột là chuyện của cả bảng, không phải của từng hàng: một Sub-task duy
    // nhất cũng đủ giữ cột lại, các hàng khác hiện ô trống.
    reads.subtaskList = [
      sub({ issueKey: 'S-1', functionKey: 'a', functionName: 'A', taskType: 'Create' }),
      sub({ issueKey: 'S-2', functionKey: 'b', functionName: 'B', taskType: 'JMReview' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.columns.map((c) => c.taskCode)).toEqual(['Create', 'JMReview']);
    expect(body.rows.find((r) => r.functionKey === 'a')?.cells[1]).toEqual({ present: false });
    expect(body.rows.find((r) => r.functionKey === 'b')?.cells[0]).toEqual({ present: false });
  });

  it('cột Tổng của hàng không bao giờ TỐT HƠN ô xấu nhất', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', taskType: 'Create', statusCategory: 'done' }),
      sub({ issueKey: 'S-2', taskType: 'BALReview', planStart: '2026-03-02', planEnd: '2026-03-06' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    const total = body.rows[0]?.total;

    expect(total).toMatchObject({ present: true, status: 'DELAY_START' });
  });

  it('hàng sắp theo tên Function, đối chiếu tiếng Việt', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', functionKey: 'export', functionName: 'Export' }),
      sub({ issueKey: 'S-2', functionKey: 'dangnhap', functionName: 'Đăng nhập' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    expect(body.rows.map((r) => r.functionName)).toEqual(['Đăng nhập', 'Export']);
  });

  it('chỉ chạy MỘT truy vấn lấy Sub-task', async () => {
    // Gọi từng ticket một sẽ làm API chậm gấp trăm lần mà nhìn code không thấy
    // gì bất thường.
    reads.subtaskList = [sub({ issueKey: 'S-1' }), sub({ issueKey: 'S-2', taskType: 'BALReview' })];
    await get<SignboardResponse>(BOARD);

    expect(reads.queries).toBe(1);
  });
});

describe('cột PIC', () => {
  it('gom Request participants của mọi Sub-task cùng Function, bỏ trùng theo accountId', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', taskType: 'Create', pics: [{ accountId: 'u1', displayName: 'An' }] }),
      sub({
        issueKey: 'S-2',
        taskType: 'BALReview',
        pics: [
          { accountId: 'u1', displayName: 'An' },
          { accountId: 'u2', displayName: 'Bình' },
        ],
      }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);

    // u1 xuất hiện ở cả hai Sub-task nhưng chỉ tính MỘT lần.
    expect(body.rows[0]?.pics).toEqual([
      { accountId: 'u1', displayName: 'An' },
      { accountId: 'u2', displayName: 'Bình' },
    ]);
  });

  it('cùng accountId nhưng một nơi thiếu tên thì ưu tiên bản CÓ tên', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', taskType: 'Create', pics: [{ accountId: 'u1', displayName: null }] }),
      sub({ issueKey: 'S-2', taskType: 'BALReview', pics: [{ accountId: 'u1', displayName: 'An' }] }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    expect(body.rows[0]?.pics).toEqual([{ accountId: 'u1', displayName: 'An' }]);
  });

  it('người chưa tra được tên (chỉ accountId) xếp SAU người có tên', async () => {
    reads.subtaskList = [
      sub({
        issueKey: 'S-1',
        pics: [
          { accountId: 'zzz', displayName: null },
          { accountId: 'u2', displayName: 'An' },
        ],
      }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    expect(body.rows[0]?.pics.map((p) => p.accountId)).toEqual(['u2', 'zzz']);
  });

  it('mỗi Function có danh sách PIC riêng, không trộn lẫn', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', functionKey: 'a', functionName: 'A', pics: [{ accountId: 'u1', displayName: 'An' }] }),
      sub({ issueKey: 'S-2', functionKey: 'b', functionName: 'B', pics: [{ accountId: 'u2', displayName: 'Bình' }] }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    expect(body.rows.find((r) => r.functionKey === 'a')?.pics).toEqual([
      { accountId: 'u1', displayName: 'An' },
    ]);
    expect(body.rows.find((r) => r.functionKey === 'b')?.pics).toEqual([
      { accountId: 'u2', displayName: 'Bình' },
    ]);
  });

  it('Function không có ai tham gia thì pics rỗng', async () => {
    reads.subtaskList = [sub({ issueKey: 'S-1' })];
    const { body } = await get<SignboardResponse>(BOARD);
    expect(body.rows[0]?.pics).toEqual([]);
  });
});

describe('nhóm cột theo Sub-phase', () => {
  it('mỗi [Sub-phase] thành một nhóm cột; cột lá lặp bộ loại task', async () => {
    // Cả hai Sub-phase đều có đủ 3 loại task nên bộ cột lặp nguyên vẹn.
    reads.subtaskList = ['FUT_ConfirmPoint', 'FUT_TestCase'].flatMap((sp) =>
      COLUMNS.map((c) => sub({ issueKey: `${sp}-${c.taskCode}`, subPhaseRaw: sp, taskType: c.taskCode })),
    );

    const { body } = await get<SignboardResponse>(BOARD);

    // Không có cấu hình → hai Sub-phase lạ, xếp theo nhãn A→Z.
    expect(body.columnGroups.map((g) => g.subPhaseKey)).toEqual([
      'fut_confirmpoint',
      'fut_testcase',
    ]);
    // 2 Sub-phase × 3 loại task = 6 cột lá, giữ thứ tự nhóm.
    expect(body.columns).toHaveLength(6);
    expect(body.columns.map((c) => c.subPhaseKey)).toEqual([
      'fut_confirmpoint',
      'fut_confirmpoint',
      'fut_confirmpoint',
      'fut_testcase',
      'fut_testcase',
      'fut_testcase',
    ]);
    // Mỗi nhóm cùng bộ loại task, đúng thứ tự cấu hình.
    expect(body.columnGroups[0]?.taskColumns.map((c) => c.taskCode)).toEqual([
      'Create',
      'BALReview',
      'JMReview',
    ]);
  });

  it('nhãn Sub-phase lạ lấy theo dạng gặp ĐẦU TIÊN, giữ hoa/thường', async () => {
    reads.subtaskList = [sub({ issueKey: 'S-1', subPhaseRaw: 'FUT_ConfirmPoint' })];
    const { body } = await get<SignboardResponse>(BOARD);
    expect(body.columnGroups[0]?.subPhaseLabel).toBe('FUT_ConfirmPoint');
  });

  it('thứ tự nhóm theo display_order của cấu hình Phase, không phải A→Z', async () => {
    // TestCase order 1, ConfirmPoint order 2 → TestCase đứng TRƯỚC dù A→Z ngược lại.
    reads.subPhaseMetaMap = new Map([
      ['fut_testcase', { label: 'Test Case', order: 1 }],
      ['fut_confirmpoint', { label: 'Confirm Point', order: 2 }],
    ]);
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: 'FUT_ConfirmPoint' }),
      sub({ issueKey: 'S-2', subPhaseRaw: 'FUT_TestCase' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.columnGroups.map((g) => g.subPhaseKey)).toEqual([
      'fut_testcase',
      'fut_confirmpoint',
    ]);
    // Nhãn lấy từ cấu hình, không phải chữ thô trong tiêu đề.
    expect(body.columnGroups.map((g) => g.subPhaseLabel)).toEqual(['Test Case', 'Confirm Point']);
  });

  it('Sub-phase khớp cấu hình đứng trước Sub-phase lạ', async () => {
    reads.subPhaseMetaMap = new Map([['fut_testcase', { label: 'Test Case', order: 5 }]]);
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: 'Zzz_Khac' }),
      sub({ issueKey: 'S-2', subPhaseRaw: 'FUT_TestCase' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    expect(body.columnGroups.map((g) => g.subPhaseKey)).toEqual(['fut_testcase', 'zzz_khac']);
  });

  it('cấu hình Sub-phase order riêng (pinned) THẮNG thứ tự mượn của Phase', async () => {
    // Theo display_order mượn: TestCase (1) trước ConfirmPoint (2). Nhưng PM đã
    // khai thứ tự riêng cho Phase này: ConfirmPoint đứng trước (pinned, order 1)
    // → phải thắng, kể cả khi TestCase cũng khớp một Phase trong cấu hình.
    reads.subPhaseMetaMap = new Map([
      ['fut_testcase', { label: 'Test Case', order: 1 }],
      ['fut_confirmpoint', { label: 'Confirm Point', order: 1, pinned: true }],
    ]);
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: 'FUT_TestCase' }),
      sub({ issueKey: 'S-2', subPhaseRaw: 'FUT_ConfirmPoint' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    expect(body.columnGroups.map((g) => g.subPhaseKey)).toEqual([
      'fut_confirmpoint',
      'fut_testcase',
    ]);
  });

  it('nhiều Sub-phase pinned xếp theo đúng thứ tự PM đã khai', async () => {
    reads.subPhaseMetaMap = new Map([
      ['b_sau', { label: 'B sau', order: 2, pinned: true }],
      ['a_truoc', { label: 'A trước', order: 1, pinned: true }],
      ['fut_testcase', { label: 'Test Case', order: 1 }],
    ]);
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: 'B_Sau' }),
      sub({ issueKey: 'S-2', subPhaseRaw: 'FUT_TestCase' }),
      sub({ issueKey: 'S-3', subPhaseRaw: 'A_Truoc' }),
      sub({ issueKey: 'S-4', subPhaseRaw: null }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    // pinned theo order khai → rồi nhóm mượn cấu hình Phase → "(No sub-phase)" cuối.
    expect(body.columnGroups.map((g) => g.subPhaseKey)).toEqual([
      'a_truoc',
      'b_sau',
      'fut_testcase',
      '',
    ]);
  });

  it('ô của Function được xếp đúng vào nhóm Sub-phase của nó', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: 'A', taskType: 'Create', statusCategory: 'done' }),
      sub({ issueKey: 'S-2', subPhaseRaw: 'B', taskType: 'BALReview', statusCategory: 'done' }),
      // Một Function khác lấp đủ 3 loại task cho CẢ hai Sub-phase, giữ lưới 2×3
      // nguyên vẹn — bài này soi CHỖ ĐỨNG của ô, không soi việc rút cột rỗng.
      ...['A', 'B'].flatMap((sp) =>
        COLUMNS.map((c) =>
          sub({
            issueKey: `F-${sp}-${c.taskCode}`,
            functionKey: 'khac',
            functionName: 'Khác',
            subPhaseRaw: sp,
            taskType: c.taskCode,
          }),
        ),
      ),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    const row = body.rows.find((r) => r.functionKey === 'login');

    // columns: [A/Create, A/BALReview, A/JMReview, B/Create, B/BALReview, B/JMReview]
    expect(row?.cells[0]).toMatchObject({ present: true, status: 'COMPLETED' }); // A/Create ← S-1
    expect(row?.cells[1]).toEqual({ present: false }); // A/BALReview trống
    expect(row?.cells[3]).toEqual({ present: false }); // B/Create trống
    expect(row?.cells[4]).toMatchObject({ present: true, status: 'COMPLETED' }); // B/BALReview ← S-2
  });

  it('mỗi hàng có một ô Σ cho MỖI nhóm Sub-phase, và Tổng lấy xấu nhất toàn hàng', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: 'A', taskType: 'Create', statusCategory: 'done' }),
      // B: đã bắt đầu nhưng quá ngày kết thúc → DELAY_END.
      sub({
        issueKey: 'S-2',
        subPhaseRaw: 'B',
        taskType: 'Create',
        planStart: '2026-03-02',
        planEnd: '2026-03-06',
        actualStart: '2026-03-03',
        statusCategory: 'indeterminate',
      }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    const row = body.rows[0];

    expect(row?.subtotals).toHaveLength(2);
    expect(row?.subtotals[0]).toMatchObject({ present: true, status: 'COMPLETED' }); // nhóm A
    expect(row?.subtotals[1]).toMatchObject({ present: true, status: 'DELAY_END' }); // nhóm B
    expect(row?.total).toMatchObject({ present: true, status: 'DELAY_END' });
  });

  it('Sub-task thiếu [Sub-phase] rơi vào nhóm dự phòng, xếp CUỐI', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: null }),
      sub({ issueKey: 'S-2', subPhaseRaw: 'FUT_TestCase' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    const keys = body.columnGroups.map((g) => g.subPhaseKey);

    expect(keys[keys.length - 1]).toBe(''); // nhóm dự phòng luôn cuối cùng
    expect(body.columnGroups.find((g) => g.subPhaseKey === '')?.subPhaseLabel).toBe('(No sub-phase)');
  });

  it('totalCells = số hàng × số cột lá CÒN LẠI sau khi rút cột rỗng', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', functionKey: 'a', functionName: 'A', subPhaseRaw: 'P1', taskType: 'Create' }),
      sub({ issueKey: 'S-2', functionKey: 'b', functionName: 'B', subPhaseRaw: 'P2', taskType: 'Create' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);

    // Không Sub-phase nào có BALReview/JMReview → mỗi nhóm chỉ còn cột Create.
    // 2 hàng × (2 Sub-phase × 1 loại task) = 4.
    expect(body.columns).toHaveLength(2);
    expect(body.summary.totalCells).toBe(4);
    const counted = Object.values(body.summary.byStatus).reduce((a, b) => a + b, 0);
    expect(counted + body.summary.emptyCells).toBe(4);
  });

  it('cột rỗng được rút theo TỪNG Sub-phase, không phải cả bảng', async () => {
    // P1 chỉ làm Create, P2 chỉ làm JMReview → mỗi nhóm một cột khác nhau. Giữ
    // nguyên bộ 3 cột cho cả hai nhóm sẽ thành 6 cột mà chỉ 2 cột có việc.
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: 'P1', taskType: 'Create' }),
      sub({ issueKey: 'S-2', subPhaseRaw: 'P2', taskType: 'JMReview' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.columnGroups.map((g) => g.taskColumns.map((c) => c.taskCode))).toEqual([
      ['Create'],
      ['JMReview'],
    ]);
    expect(body.columns).toEqual([
      { taskCode: 'Create', label: 'Tạo', subPhaseKey: 'p1' },
      { taskCode: 'JMReview', label: 'JM review', subPhaseKey: 'p2' },
    ]);
    expect(body.rows[0]?.cells).toHaveLength(2);
    expect(body.rows[0]?.subtotals).toHaveLength(2);
  });

  it('Sub-phase chỉ toàn loại task chưa khai cột thì KHÔNG thành nhóm', async () => {
    // `Deploy` không có trong cấu hình cột → Sub-phase P2 không có cột nào để
    // dựng; hiện một header trống rỗng chỉ làm PM tưởng mất dữ liệu. Các
    // Sub-task đó nằm ở khu "chưa lên được bảng".
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: 'P1', taskType: 'Create' }),
      sub({ issueKey: 'S-2', subPhaseRaw: 'P2', taskType: 'Deploy', parseStatus: 'UNKNOWN_TASK_TYPE' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.columnGroups.map((g) => g.subPhaseKey)).toEqual(['p1']);
    expect(body.columns).toHaveLength(1);
  });
});

describe('thanh tóm tắt', () => {
  it('ô trống KHÔNG được đếm vào bất kỳ trạng thái nào', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', functionKey: 'a', functionName: 'A', taskType: 'Create', statusCategory: 'done' }),
      sub({ issueKey: 'S-2', functionKey: 'b', functionName: 'B', taskType: 'BALReview', statusCategory: 'done' }),
    ];
    const { body } = await get<SignboardResponse>(BOARD);

    // Lưới 2 hàng × 2 cột (JMReview bị rút vì không có việc): 2 ô có việc, 2 ô trống.
    expect(body.summary.byStatus).toEqual({ COMPLETED: 2 });
    expect(body.summary.emptyCells).toBe(2);
  });

  it('tổng số ô đếm được cộng ô trống bằng số hàng nhân số cột', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', functionKey: 'a', functionName: 'A', taskType: 'Create' }),
      sub({ issueKey: 'S-2', functionKey: 'b', functionName: 'B', taskType: 'BALReview' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    const counted = Object.values(body.summary.byStatus).reduce((a, b) => a + b, 0);

    expect(counted + body.summary.emptyCells).toBe(body.summary.totalCells);
    // 2 hàng × 2 cột còn lại (JMReview không có việc nên bị rút).
    expect(body.summary.totalCells).toBe(2 * 2);
  });
});

describe('phụ thuộc vào hôm nay', () => {
  it('đổi asOfDate làm đổi trạng thái nhưng KHÔNG đổi ngày kế hoạch', async () => {
    reads.subtaskList = [sub({ issueKey: 'S-1', planStart: '2026-03-12', planEnd: '2026-03-20' })];

    const before = await get<SignboardResponse>(`${BOARD}?asOfDate=2026-03-10`);
    const after = await get<SignboardResponse>(`${BOARD}?asOfDate=2026-03-15`);

    expect(before.body.rows[0]?.cells[0]).toMatchObject({ status: 'NYS', planStart: '2026-03-12' });
    expect(after.body.rows[0]?.cells[0]).toMatchObject({ status: 'DELAY_START', planStart: '2026-03-12' });
  });

  it('không truyền asOfDate thì lấy hôm nay theo múi giờ của Epic, không phải UTC', async () => {
    // 2026-03-10T01:00Z là 08:00 ngày 10/03 giờ Việt Nam.
    reads.subtaskList = [sub({ issueKey: 'S-1' })];
    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.asOfDate).toBe('2026-03-10');
  });

  it('nửa đêm giờ Việt Nam đã sang ngày mới dù UTC còn hôm trước', async () => {
    // Đây là ca làm lộ ra việc lấy nhầm múi giờ máy chủ: 17:30Z ngày 09/03 là
    // 00:30 ngày 10/03 ở Việt Nam.
    now = new Date('2026-03-09T17:30:00Z');
    reads.subtaskList = [sub({ issueKey: 'S-1' })];
    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.asOfDate).toBe('2026-03-10');
  });

  it('asOfDate sai định dạng bị từ chối', async () => {
    reads.subtaskList = [sub({ issueKey: 'S-1' })];
    const { status } = await get(`${BOARD}?asOfDate=10/03/2026`);
    expect(status).toBe(400);
  });
});

describe('khu chưa lên được bảng', () => {
  it('Sub-task đặt tên sai định dạng hiện kèm lý do đọc được', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-9', parseStatus: 'UNPARSED', functionKey: null, functionName: null, taskType: null }),
    ];

    const { body } = await get<UnparsedResponse>(`${BOARD}/unparsed`);

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.reason).toBe('BAD_TITLE_FORMAT');
    expect(body.items[0]?.hint).toContain('DOES still count towards the Burndown chart');
  });

  it('TaskName lạ xuất hiện 3 lần thì gợi ý thêm cột', async () => {
    reads.subtaskList = ['S-1', 'S-2', 'S-3'].map((k) =>
      sub({ issueKey: k, parseStatus: 'UNKNOWN_TASK_TYPE', taskType: null }),
    );
    reads.raw = { 'S-1': 'Deploy', 'S-2': 'Deploy', 'S-3': 'Deploy' };

    const { body } = await get<UnparsedResponse>(`${BOARD}/unparsed`);

    expect(body.suggestedColumns).toEqual([{ taskCode: 'Deploy', count: 3 }]);
  });

  it('TaskName lạ mới xuất hiện 2 lần thì CHƯA gợi ý', async () => {
    reads.subtaskList = ['S-1', 'S-2'].map((k) =>
      sub({ issueKey: k, parseStatus: 'UNKNOWN_TASK_TYPE', taskType: null }),
    );
    reads.raw = { 'S-1': 'Deploy', 'S-2': 'Deploy' };

    const { body } = await get<UnparsedResponse>(`${BOARD}/unparsed`);
    expect(body.suggestedColumns).toEqual([]);
  });

  it('hơn 30% Sub-task không parse được thì bật cờ cảnh báo', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1' }),
      sub({ issueKey: 'S-2' }),
      sub({ issueKey: 'S-3', parseStatus: 'UNPARSED', functionKey: null, taskType: null }),
      sub({ issueKey: 'S-4', parseStatus: 'UNPARSED', functionKey: null, taskType: null }),
    ];

    const board = await get<SignboardResponse>(BOARD);
    const unparsed = await get<UnparsedResponse>(`${BOARD}/unparsed`);

    expect(board.body.parseHealthWarning).toBe(true);
    expect(unparsed.body.parseHealthWarning).toBe(true);
  });

  it('đúng 30% thì CHƯA cảnh báo — biên rõ ràng', async () => {
    reads.subtaskList = [
      ...['S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6', 'S-7'].map((k) => sub({ issueKey: k })),
      sub({ issueKey: 'S-8', parseStatus: 'UNPARSED', functionKey: null, taskType: null }),
      sub({ issueKey: 'S-9', parseStatus: 'UNPARSED', functionKey: null, taskType: null }),
      sub({ issueKey: 'S-10', parseStatus: 'UNPARSED', functionKey: null, taskType: null }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    expect(body.parseHealthWarning).toBe(false);
  });

  it('Epic chưa có Sub-task nào thì KHÔNG cảnh báo — 0/0 không phải là 100%', async () => {
    const { body } = await get<SignboardResponse>(BOARD);
    expect(body.parseHealthWarning).toBe(false);
    expect(body.rows).toEqual([]);
  });
});

describe('bộ chọn Phase', () => {
  const PHASES = '/api/signboard/epic/PAY-1/phases';

  it('trả về danh sách Phase có Sub-task đúng thứ tự cổng đưa ra', async () => {
    reads.phaseList = [
      { phaseCode: 'DESIGN', label: 'Thiết kế', subtaskCount: 4 },
      { phaseCode: 'CODING', label: 'Lập trình', subtaskCount: 12 },
      { phaseCode: 'TESTING', label: 'Kiểm thử', subtaskCount: 7 },
    ];

    const { status, body } = await get<SignboardPhasesResponse>(PHASES);

    expect(status).toBe(200);
    expect(body.epicKey).toBe('PAY-1');
    expect(body.phases.map((p) => p.phaseCode)).toEqual(['DESIGN', 'CODING', 'TESTING']);
    expect(body.phases[1]).toEqual({ phaseCode: 'CODING', label: 'Lập trình', subtaskCount: 12 });
  });

  it('Epic chưa có Sub-task nào thì danh sách rỗng, không phải lỗi', async () => {
    reads.phaseList = [];
    const { status, body } = await get<SignboardPhasesResponse>(PHASES);

    expect(status).toBe(200);
    expect(body.phases).toEqual([]);
  });

  it('PM không phụ trách project nhận HTTP 403', async () => {
    principal = { userId: 'pm', role: 'PM', projects: ['SHOP'] };
    expect((await get(PHASES)).status).toBe(403);
  });

  it('thiếu thông tin người dùng nhận HTTP 401', async () => {
    principal = null;
    expect((await get(PHASES)).status).toBe(401);
  });
});

describe('bộ lọc nhóm tầng-1 (Giai đoạn)', () => {
  const PHASES = '/api/signboard/epic/PAY-1/phases';

  it('/phases trả kèm danh sách nhóm + nhãn tầng từ cổng', async () => {
    reads.stageInfo = {
      tierLabel: 'Giai đoạn',
      items: [
        { code: 'GD1', label: 'Giai đoạn 1', subtaskCount: 9 },
        { code: 'GD2', label: 'Giai đoạn 2', subtaskCount: 4 },
      ],
    };

    const { status, body } = await get<SignboardPhasesResponse>(PHASES);

    expect(status).toBe(200);
    expect(body.stageTierLabel).toBe('Giai đoạn');
    expect(body.stages.map((s) => s.code)).toEqual(['GD1', 'GD2']);
  });

  it('Epic 1 tầng: stages rỗng, stageTierLabel null — UI ẩn bộ lọc', async () => {
    const { body } = await get<SignboardPhasesResponse>(PHASES);
    expect(body.stages).toEqual([]);
    expect(body.stageTierLabel).toBeNull();
  });

  it('?stage= được truyền xuống cổng cho cả /phases lẫn bảng; vắng thì null', async () => {
    await get<SignboardPhasesResponse>(`${PHASES}?stage=GD2`);
    expect(reads.lastPhasesStage).toBe('GD2');

    await get<SignboardResponse>(`${BOARD}?stage=GD2`);
    expect(reads.lastSubtasksStage).toBe('GD2');

    await get<UnparsedResponse>(`${BOARD}/unparsed?stage=GD1`);
    expect(reads.lastSubtasksStage).toBe('GD1');

    await get<SignboardResponse>(BOARD);
    expect(reads.lastSubtasksStage).toBeNull();

    // Chuỗi rỗng / toàn khoảng trắng coi như không lọc.
    await get<SignboardResponse>(`${BOARD}?stage=%20%20`);
    expect(reads.lastSubtasksStage).toBeNull();
  });
});

describe('phân quyền và lỗi', () => {
  it('PM không phụ trách project nhận HTTP 403', async () => {
    principal = { userId: 'pm', role: 'PM', projects: ['SHOP'] };
    expect((await get(BOARD)).status).toBe(403);
  });

  it('VIEWER xem được', async () => {
    principal = { userId: 'v', role: 'VIEWER', projects: [] };
    expect((await get(BOARD)).status).toBe(200);
  });

  it('thiếu thông tin người dùng nhận HTTP 401', async () => {
    principal = null;
    expect((await get(BOARD)).status).toBe(401);
  });
});
