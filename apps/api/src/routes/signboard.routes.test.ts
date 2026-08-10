import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  type Principal,
  type SignboardPhase,
  type SignboardPhasesResponse,
  type SignboardResponse,
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
    ...over,
  };
}

class FakeReads implements SignboardReadPort {
  subtaskList: SignboardSubtask[] = [];
  columnList: ColumnSpec[] = COLUMNS;
  raw: Record<string, string | null> = {};
  phaseList: SignboardPhase[] = [];
  subPhaseMetaMap: Map<string, SubPhaseMetaEntry> = new Map();
  queries = 0;

  async epicMeta() {
    return { projectKey: 'PAY', calendar: CALENDAR };
  }
  async phases() {
    return this.phaseList;
  }
  async subtasks() {
    this.queries += 1;
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
    reads.subtaskList = [sub({ issueKey: 'S-1', taskType: 'Create' })];
    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.rows[0]?.cells[0]).toMatchObject({ present: true });
    expect(body.rows[0]?.cells[1]).toEqual({ present: false });
    expect(body.rows[0]?.cells[2]).toEqual({ present: false });
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
    reads.subtaskList = [sub({ issueKey: 'S-1' })];
    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.columns.map((c) => c.taskCode)).toEqual(['Create', 'BALReview', 'JMReview']);
  });

  it('taskType lạ KHÔNG sinh thêm cột mới', async () => {
    // Cột là do người quyết định, không phải suy ra từ dữ liệu (C-10).
    reads.subtaskList = [sub({ issueKey: 'S-1', taskType: 'Deploy', parseStatus: 'UNKNOWN_TASK_TYPE' })];
    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.columns).toHaveLength(3);
    expect(body.columns.map((c) => c.taskCode)).not.toContain('Deploy');
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

describe('nhóm cột theo Sub-phase', () => {
  it('mỗi [Sub-phase] thành một nhóm cột; cột lá lặp bộ loại task', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: 'FUT_ConfirmPoint', taskType: 'Create' }),
      sub({ issueKey: 'S-2', subPhaseRaw: 'FUT_TestCase', taskType: 'Create' }),
    ];

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

  it('ô của Function được xếp đúng vào nhóm Sub-phase của nó', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', subPhaseRaw: 'A', taskType: 'Create', statusCategory: 'done' }),
      sub({ issueKey: 'S-2', subPhaseRaw: 'B', taskType: 'BALReview', statusCategory: 'done' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);
    const row = body.rows[0];

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

  it('totalCells = số hàng × (số Sub-phase × số loại task)', async () => {
    reads.subtaskList = [
      sub({ issueKey: 'S-1', functionKey: 'a', functionName: 'A', subPhaseRaw: 'P1', taskType: 'Create' }),
      sub({ issueKey: 'S-2', functionKey: 'b', functionName: 'B', subPhaseRaw: 'P2', taskType: 'Create' }),
    ];

    const { body } = await get<SignboardResponse>(BOARD);

    // 2 hàng × (2 Sub-phase × 3 loại task) = 12.
    expect(body.summary.totalCells).toBe(12);
    const counted = Object.values(body.summary.byStatus).reduce((a, b) => a + b, 0);
    expect(counted + body.summary.emptyCells).toBe(12);
  });
});

describe('thanh tóm tắt', () => {
  it('ô trống KHÔNG được đếm vào bất kỳ trạng thái nào', async () => {
    reads.subtaskList = [sub({ issueKey: 'S-1', taskType: 'Create', statusCategory: 'done' })];
    const { body } = await get<SignboardResponse>(BOARD);

    expect(body.summary.byStatus).toEqual({ COMPLETED: 1 });
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
    expect(body.summary.totalCells).toBe(2 * 3);
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
