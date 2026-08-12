import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  type BurndownResponse,
  type PhaseRollup,
  type PlanShiftRecord,
  type Principal,
  type SnapshotRow,
  type WorkCalendar,
} from '@app/shared';
import { registerBurndownRoutes, type BurndownReadPort } from './burndown.routes.js';
import { chartCachePattern, createChartCache, type CacheRedis } from '../adapters/chart-cache.js';
import { summarizeShifts, toHours } from '../services/burndown.service.js';
import { asAdmin, asPm, asViewer, testGuards } from '../test-fakes.js';

const CALENDAR: WorkCalendar = {
  calendarId: 'test',
  timezone: 'Asia/Ho_Chi_Minh',
  workdaysMask: DEFAULT_WORKDAYS_MASK,
  hoursPerDay: 8,
  holidays: new Set(),
  warnings: [],
};


function rollup(phaseCode: string, planStart: string | null, planEnd: string | null, planWorkdays: number | null, totalOriginalS = 0): PhaseRollup {
  return {
    phaseCode,
    planStart,
    planEnd,
    planWorkdays,
    actualStart: null,
    actualEnd: null,
    actualEndIsProvisional: true,
    totalOriginalS,
    subtaskCount: 0,
    missingDateCount: 0,
    warnings: [],
  };
}

function snapshot(date: string, planned: number, actual: number, extra: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    snapshotDate: date,
    plannedRemainingS: planned,
    actualRemainingS: actual,
    totalScopeS: 288_000,
    totalSpentS: 0,
    scopeAddedS: 0,
    scopeRemovedS: 0,
    countTodo: 0,
    countInProgress: 0,
    countDone: 0,
    perPhase: [
      {
        phaseCode: 'DESIGN',
        remainingS: actual / 2,
        spentS: 0,
        originalS: 144_000,
        countTodo: 0,
        countInProgress: 0,
        countDone: 0,
        plannedRemainingS: planned / 2,
      },
      {
        phaseCode: 'DEV',
        remainingS: actual / 2,
        spentS: 0,
        originalS: 144_000,
        countTodo: 0,
        countInProgress: 0,
        countDone: 0,
        plannedRemainingS: planned / 2,
      },
    ],
    ...extra,
  };
}

/** Redis giả có cài đặt `SCAN` thật, kèm bộ đếm để bắt lệnh `KEYS`. */
class FakeCacheRedis implements CacheRedis {
  readonly store = new Map<string, string>();
  scanCalls = 0;
  failMode: 'none' | 'read' | 'all' = 'none';

  async get(key: string): Promise<string | null> {
    if (this.failMode !== 'none') throw new Error('Redis đứt');
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    if (this.failMode === 'all') throw new Error('Redis đứt');
    this.store.set(key, value);
    return 'OK';
  }

  async scan(cursor: string, _m: 'MATCH', pattern: string, _c: 'COUNT', n: number): Promise<[string, string[]]> {
    this.scanCalls += 1;
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`);
    const all = [...this.store.keys()].filter((k) => re.test(k));
    const start = Number(cursor);
    const slice = all.slice(start, start + n);
    const next = start + n >= all.length ? '0' : String(start + n);
    return [next, slice];
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return n;
  }

  /** Không tồn tại — gọi tới là test đỏ ngay. */
  keys(): never {
    throw new Error('KEYS bị cấm: nó khoá cả Redis, kể cả token bucket giới hạn tốc độ Jira.');
  }
}

class FakeReads implements BurndownReadPort {
  snapshotQueries = 0;
  rollups: PhaseRollup[] = [rollup('DESIGN', '2026-03-02', '2026-03-06', 5), rollup('DEV', '2026-03-09', '2026-03-13', 5)];
  snapshots: SnapshotRow[] = [];
  planShifts: PlanShiftRecord[] = [];
  meta: { projectKey: string; calendar: WorkCalendar } | null = { projectKey: 'PAY', calendar: CALENDAR };

  async epicMeta() {
    return this.meta;
  }
  async loadSnapshots(_e: string, from: string, to: string) {
    this.snapshotQueries += 1;
    return this.snapshots.filter((s) => s.snapshotDate >= from && s.snapshotDate <= to);
  }
  async latestSnapshotDate() {
    // MAX(snapshot_date) — một lần dò index, KHÔNG tính vào `snapshotQueries` (đó
    // là bộ đếm cho truy vấn nạp lịch sử nặng của biểu đồ).
    let latest: string | null = null;
    for (const s of this.snapshots) if (latest === null || s.snapshotDate > latest) latest = s.snapshotDate;
    return latest;
  }
  async loadRollups() {
    return this.rollups;
  }
  async loadPlanShifts() {
    return this.planShifts;
  }
  async loadRatios() {
    return { missingEstimateRatio: 0.1, unclassifiedPhaseRatio: 0, missingWbsDateRatio: 0.2 };
  }
  async phaseLabels() {
    return {
      DESIGN: { label: 'Thiết kế', colorHex: '#4A90D9' },
      DEV: { label: 'Lập trình', colorHex: null },
    };
  }
}

let reads: FakeReads;
let redis: FakeCacheRedis;
let app: FastifyInstance;
let principal: Principal | null;

beforeEach(async () => {
  reads = new FakeReads();
  redis = new FakeCacheRedis();
  principal = asAdmin();

  // Hai tuần làm việc, mọi ngày đều có snapshot.
  const days = [
    '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
    '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13',
  ];
  reads.snapshots = days.map((d, i) => snapshot(d, 288_000 - i * 28_800, 288_000 - i * 25_200));

  app = Fastify();
  registerBurndownRoutes(app, {
    reads,
    cache: createChartCache({ redis }),
    guards: testGuards({ principal: () => principal }),
  });
  await app.ready();
});

async function get(url: string): Promise<{ status: number; body: BurndownResponse & { error?: string; message?: string } }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as BurndownResponse & { error?: string } };
}

// ---------------------------------------------------------------------------

describe('ba chế độ xem', () => {
  it('chế độ Tổng Epic trải từ MIN(plan_start) tới MAX(plan_end) của mọi Phase', async () => {
    const { status, body } = await get('/api/projects/PAY/epics/PAY-1/burndown');

    expect(status).toBe(200);
    expect(body.mode).toBe('EPIC');
    expect(body.from).toBe('2026-03-02');
    expect(body.to).toBe('2026-03-13');
    // Đường Tổng Epic vẫn ở vị trí đầu. Trục vẽ ĐỦ 12 ngày lịch (2026-08):
    // 10 ngày làm việc + Thứ 7 & CN 07–08/03 mang cờ isOffDay.
    expect(body.series[0]?.key).toBe('EPIC');
    expect(body.series[0]?.points).toHaveLength(12);
    const offDays = body.series[0]?.points.filter((p) => p.isOffDay === true).map((p) => p.date);
    expect(offDays).toEqual(['2026-03-07', '2026-03-08']);
  });

  it('cuối tuần có snapshot (team làm Thứ 7) thì điểm mang SỐ THẬT, vẫn cờ isOffDay', async () => {
    // Quyết định 2026-08: worker chốt sổ mọi ngày lịch. Giờ log cuối tuần phải
    // hiện đúng hôm làm trên đường Thực tế, không dồn vào sáng Thứ 2.
    reads.snapshots = [...reads.snapshots, snapshot('2026-03-07', 200_000, 210_000)];
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');

    const sat = body.series[0]?.points.find((p) => p.date === '2026-03-07');
    expect(sat?.isOffDay).toBe(true);
    expect(sat?.actualRemainingHours).toBe(toHours(210_000));
    expect(sat?.plannedRemainingHours).toBe(toHours(200_000));
  });

  it('cuối tuần KHÔNG có snapshot thì điểm là null — API không bịa số, tầng hiển thị tự kéo phẳng', async () => {
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    const sun = body.series[0]?.points.find((p) => p.date === '2026-03-08');

    expect(sun?.isOffDay).toBe(true);
    expect(sun?.actualRemainingHours).toBeNull();
    // Và cuối tuần không bị đếm vào ngày thiếu snapshot — nghỉ không phải lỗi.
    expect(body.dataHealth.missingSnapshotDays).toEqual([]);
  });

  it('Tổng Epic KÈM chuỗi của MỌI Phase để màn hình dựng được ô chọn Phase', async () => {
    // Đây là lỗi PM báo: ở chế độ Single Phase / Compare không có Phase nào để
    // chọn. Gốc rễ: phản hồi Tổng Epic phải kèm sẵn chuỗi từng Phase (đổi Phase
    // KHÔNG gọi lại API — xem use-burndown.ts), nhưng trước đây chỉ trả mỗi EPIC.
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');

    // EPIC đứng đầu, theo sau là từng Phase đúng thứ tự rollup (display_order).
    expect(body.series.map((s) => s.key)).toEqual(['EPIC', 'DESIGN', 'DEV']);

    const design = body.series.find((s) => s.key === 'DESIGN');
    expect(design?.label).toBe('Thiết kế'); // nhãn + màu lấy từ cấu hình hiệu lực
    expect(design?.colorHex).toBe('#4A90D9');
    expect(design?.points).toHaveLength(12); // 10 ngày làm việc + 2 ngày cuối tuần
    // Số của Phase lấy từ per_phase (một nửa số Epic trong fixture), KHÔNG lấy số Epic.
    expect(design?.points[0]?.actualRemainingHours).toBe(toHours(288_000 / 2));
  });

  it('chế độ một Phase CO LẠI đúng khoảng của Phase đó', async () => {
    // Để nguyên khoảng của cả Epic sẽ vẽ ra một đường nằm ngang dài lê thê ở
    // hai đầu (PRD §5.1).
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown/phase/DEV');

    expect(body.from).toBe('2026-03-09');
    expect(body.to).toBe('2026-03-13');
    expect(body.series[0]?.points).toHaveLength(5);
  });

  it('chế độ một Phase chỉ lấy số từ per_phase, KHÔNG lấy số mức Epic', async () => {
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown/phase/DESIGN');
    const first = body.series[0]?.points[0];

    // Trong fixture, số của Phase bằng một nửa số của Epic.
    expect(first?.actualRemainingHours).toBe(toHours(288_000 / 2));
    expect(first?.plannedRemainingHours).toBe(toHours(288_000 / 2));
  });

  it('chế độ so sánh trả mỗi Phase một chuỗi số riêng, kèm nhãn và màu', async () => {
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown/phases/compare?codes=DESIGN,DEV');

    expect(body.series.map((s) => s.key)).toEqual(['DESIGN', 'DEV']);
    expect(body.series[0]?.label).toBe('Thiết kế');
    expect(body.series[0]?.colorHex).toBe('#4A90D9');
    expect(body.series[1]?.colorHex).toBeNull();
  });

  it('so sánh quá 4 Phase bị từ chối HTTP 400 kèm lý do đọc được', async () => {
    reads.rollups = ['A', 'B', 'C', 'D', 'E'].map((c) => rollup(c, '2026-03-02', '2026-03-06', 5));
    const { status, body } = await get('/api/projects/PAY/epics/PAY-1/burndown/phases/compare?codes=A,B,C,D,E');

    expect(status).toBe(400);
    expect(body.error).toBe('TOO_MANY_PHASES');
    expect(body.message).toContain('at most 4');
  });

  it('Phase không tồn tại trong Epic trả HTTP 404 kèm danh sách Phase đang có', async () => {
    const { status, body } = await get('/api/projects/PAY/epics/PAY-1/burndown/phase/KHONGCO');

    expect(status).toBe(404);
    expect(body.error).toBe('PHASE_NOT_FOUND');
    expect(body.message).toContain('DESIGN, DEV');
  });

  it('Epic không nằm trong sổ theo dõi trả HTTP 404 kèm cách khắc phục', async () => {
    reads.meta = null;
    const { status, body } = await get('/api/projects/PAY/epics/LA-1/burndown');

    expect(status).toBe(404);
    expect(body.message).toContain('Add it on the Epics screen');
  });
});

describe('không tính lịch sử tại chỗ', () => {
  it('chỉ chạy đúng MỘT truy vấn trên daily_snapshot', async () => {
    // API này KHÔNG BAO GIỜ tính lịch sử tại chỗ (PRD §9.1) — đó là lý do đạt
    // được mốc p95 ≤ 800ms.
    await get('/api/projects/PAY/epics/PAY-1/burndown');
    expect(reads.snapshotQueries).toBe(1);
  });
});

describe('ngày thiếu snapshot', () => {
  beforeEach(() => {
    reads.snapshots = reads.snapshots.filter((s) => s.snapshotDate !== '2026-03-12');
  });

  it('missingSnapshotDays chứa đúng NGÀY CỤ THỂ bị thiếu', async () => {
    // Trả một con số ("thiếu 1 ngày") không giúp PM tìm được nguyên nhân.
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    expect(body.dataHealth.missingSnapshotDays).toEqual(['2026-03-12']);
  });

  it('ngày thiếu là LỖ THỦNG null, tuyệt đối KHÔNG nội suy', async () => {
    // Nối tắt hai điểm bên cạnh trông đẹp hơn và không test nào đỏ, nhưng PM sẽ
    // đọc ra một tiến độ không có thật (E-12).
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    const hole = body.series[0]?.points.find((p) => p.date === '2026-03-12');

    expect(hole?.plannedRemainingHours).toBeNull();
    expect(hole?.actualRemainingHours).toBeNull();
    expect(hole?.varianceHours).toBeNull();
  });

  it('vẫn giữ đủ số điểm trên trục, không bỏ hẳn ngày đó đi', async () => {
    // Bỏ hẳn ngày sẽ làm trục thời gian co lại và biểu đồ nhìn như liền mạch.
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    expect(body.series[0]?.points).toHaveLength(12); // 10 ngày làm việc + 2 cuối tuần
  });
});

describe('Epic trễ so với kế hoạch — nới trục qua plan_end', () => {
  it('nới trục tới ngày snapshot mới nhất để không cắt mất hôm qua/hôm nay', async () => {
    // plan_end của cả Epic là 2026-03-06, nhưng đội vẫn làm tiếp và snapshot chạy
    // tới 2026-03-13. Trục lấy plan_end làm cận trên sẽ CẮT MẤT 4 ngày làm việc
    // cuối — đúng lỗi "biểu đồ không vẽ ngày trước hôm nay". Nới tới snapshot cuối.
    reads.rollups = [
      rollup('DESIGN', '2026-03-02', '2026-03-04', 3, 144_000),
      rollup('DEV', '2026-03-05', '2026-03-06', 2, 144_000),
    ];
    // reads.snapshots giữ nguyên: 2026-03-02 .. 2026-03-13

    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');

    expect(body.to).toBe('2026-03-13');
    // Ngày SAU plan_end vẫn có số liệu thật, không bị cắt.
    const late = body.series[0]?.points.find((p) => p.date === '2026-03-13');
    expect(late?.actualRemainingHours).not.toBeNull();
  });

  it('KHÔNG nới ở chế độ một Phase — Phase vẫn co về đúng khoảng kế hoạch (PRD §5.1)', async () => {
    reads.rollups = [
      rollup('DESIGN', '2026-03-02', '2026-03-04', 3, 144_000),
      rollup('DEV', '2026-03-05', '2026-03-06', 2, 144_000),
    ];
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown/phase/DESIGN');

    // Đúng plan_end của DESIGN, KHÔNG nới theo snapshot mức Epic (03-13).
    expect(body.to).toBe('2026-03-04');
  });
});

describe('đường Kế hoạch kéo dài tới hết ngày kế hoạch', () => {
  beforeEach(() => {
    // "Hôm nay" là 2026-03-06: snapshot mới chỉ có tới đó, kế hoạch còn chạy
    // tới 2026-03-13. Rollup mang ước lượng thật để công thức T-16 có gì mà đốt.
    reads.rollups = [
      rollup('DESIGN', '2026-03-02', '2026-03-06', 5, 144_000),
      rollup('DEV', '2026-03-09', '2026-03-13', 5, 144_000),
    ];
    reads.snapshots = reads.snapshots.filter((s) => s.snapshotDate <= '2026-03-06');
  });

  it('KHÔNG kêu thiếu snapshot cho những ngày tương lai sau snapshot cuối', async () => {
    // 03-09..03-13 trống vì CHƯA TỚI (đường Kế hoạch còn chạy tiếp), không phải
    // job đêm hỏng. Trước đây chúng bị đếm vào missingSnapshotDays → dải đỏ báo
    // động giả "5 ngày chưa có snapshot".
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    expect(body.dataHealth.missingSnapshotDays).toEqual([]);
  });

  it('sau snapshot cuối, đường Kế hoạch vẫn vẽ tiếp và chạm 0 đúng ngày plan_end', async () => {
    // Đây là điều PM cần nhìn thấy: kế hoạch dự kiến kết thúc KHI NÀO. Trước
    // đây đường Kế hoạch đứt ở hôm nay cùng chỗ với đường Thực tế.
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    const points = body.series[0]?.points ?? [];

    // 2026-03-09: DESIGN đã cháy trọn 40h, DEV cháy 1/5 của 40h → còn 32h.
    expect(points.find((p) => p.date === '2026-03-09')?.plannedRemainingHours).toBe(32);
    expect(points.find((p) => p.date === '2026-03-13')?.plannedRemainingHours).toBe(0);
  });

  it('đường Thực tế thì KHÔNG chiếu tiếp — tương lai chưa xảy ra', async () => {
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    const future = body.series[0]?.points.find((p) => p.date === '2026-03-13');

    expect(future?.actualRemainingHours).toBeNull();
    expect(future?.varianceHours).toBeNull();
  });

  it('chế độ một Phase chưa có snapshot nào vẫn vẽ trọn đường Kế hoạch của Phase đó', async () => {
    // DEV bắt đầu 2026-03-09, hoàn toàn trong tương lai: không một snapshot nào
    // trong khoảng. Cả trục chỉ có đường Kế hoạch, chiếu từ rollup của Phase.
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown/phase/DEV');
    const points = body.series[0]?.points ?? [];

    expect(points).toHaveLength(5);
    expect(points[0]?.plannedRemainingHours).toBe(32); // 40h − 8h của ngày đầu
    expect(points[4]?.plannedRemainingHours).toBe(0);
    expect(points.every((p) => p.actualRemainingHours === null)).toBe(true);
  });

  it('Phase thiếu dữ liệu kế hoạch thì phần chiếu tiếp vẫn là null, không đoán bừa', async () => {
    // C-10: `planWorkdays` null (khoảng kế hoạch không có ngày làm việc nào)
    // thì công thức T-16 bỏ qua Phase đó — không vẽ, không bịa.
    reads.rollups = [
      rollup('DESIGN', '2026-03-02', '2026-03-06', 5, 144_000),
      rollup('DEV', '2026-03-09', '2026-03-13', null, 144_000),
    ];
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    const dev = body.series.find((s) => s.key === 'DEV');
    const future = dev?.points.find((p) => p.date === '2026-03-13');

    expect(future).toBeDefined();
    expect(future?.plannedRemainingHours).toBeNull();
  });
});

describe('đường Kế hoạch chiếu NGƯỢC trước snapshot đầu tiên', () => {
  beforeEach(() => {
    // Kịch bản của PM: một Phase plan_start 02/03 nhưng snapshot đầu tiên mãi
    // 03/03 mới có (Epic được thêm vào theo dõi muộn hơn plan_start). Rollup mang
    // ước lượng thật để công thức T-16 có gì mà đốt.
    reads.rollups = [
      rollup('DESIGN', '2026-03-02', '2026-03-06', 5, 144_000),
      rollup('DEV', '2026-03-09', '2026-03-13', 5, 144_000),
    ];
    reads.snapshots = reads.snapshots.filter((s) => s.snapshotDate !== '2026-03-02');
  });

  it('ngày TRƯỚC snapshot đầu tiên có đường Kế hoạch (Thực tế vẫn null)', async () => {
    // Trục lấy MIN(plan_start) = 02/03 làm cận dưới, nhưng snapshot đầu là 03/03.
    // Trước khi sửa, 02/03 rơi vào nhánh "trước snapshot cuối" → null → đường Kế
    // hoạch bắt đầu muộn một ngày so với trục. Giờ nó được chiếu ngược.
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    const points = body.series[0]?.points ?? [];
    const first = points.find((p) => p.date === '2026-03-02');

    // 02/03: DESIGN cháy 1/5 của 40h = 8h → 80h − 8h = 72h. DEV chưa tới ngày bắt đầu.
    expect(first?.plannedRemainingHours).toBe(72);
    // Không có số đo thật trước khi theo dõi — đường Thực tế để null, không bịa.
    expect(first?.actualRemainingHours).toBeNull();
    expect(first?.varianceHours).toBeNull();
    // Nối liền mạch: điểm biên 03/03 (snapshot thật) cũng có đường Kế hoạch.
    expect(points.find((p) => p.date === '2026-03-03')?.plannedRemainingHours).not.toBeNull();
  });

  it('ngày trước snapshot đầu KHÔNG bị đếm là thiếu snapshot — đó là báo động giả', async () => {
    // 02/03 là quá khứ TRƯỚC KHI Epic bắt đầu chốt sổ, không phải job đêm bỏ lỡ.
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    expect(body.dataHealth.missingSnapshotDays).toEqual([]);
    // Trục vẫn giữ đủ 12 ngày lịch (10 ngày làm việc + 2 cuối tuần).
    expect(body.series[0]?.points).toHaveLength(12);
  });

  it('lỗ thủng GIỮA hai đầu snapshot vẫn là null — chỉ hai ĐUÔI mới được chiếu', async () => {
    // Bỏ thêm 04/03 (nằm GIỮA 03/03 và snapshot cuối) — đây mới là lỗ thủng thật.
    reads.snapshots = reads.snapshots.filter((s) => s.snapshotDate !== '2026-03-04');
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    const points = body.series[0]?.points ?? [];

    // 02/03 (đuôi trước) được chiếu…
    expect(points.find((p) => p.date === '2026-03-02')?.plannedRemainingHours).not.toBeNull();
    // …nhưng 04/03 (giữa) vẫn là lỗ thủng nhìn thấy được, và bị đếm là thiếu.
    expect(points.find((p) => p.date === '2026-03-04')?.plannedRemainingHours).toBeNull();
    expect(body.dataHealth.missingSnapshotDays).toEqual(['2026-03-04']);
  });

  it('chế độ một Phase cũng chiếu ngược trên phạm vi của chính Phase đó', async () => {
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown/phase/DESIGN');
    const first = body.series[0]?.points.find((p) => p.date === '2026-03-02');

    // Phạm vi Phase = 144_000s (40h). Cháy 1/5 ngày đầu = 8h → còn 32h.
    expect(first?.plannedRemainingHours).toBe(32);
    expect(first?.actualRemainingHours).toBeNull();
  });
});

describe('cache', () => {
  it('lần gọi thứ hai lấy từ cache, không chạm database', async () => {
    await get('/api/projects/PAY/epics/PAY-1/burndown');
    expect(reads.snapshotQueries).toBe(1);

    await get('/api/projects/PAY/epics/PAY-1/burndown');
    expect(reads.snapshotQueries).toBe(1);
  });

  it('khoảng thời gian khác nhau tạo khoá cache khác nhau', async () => {
    // Thiếu phần khoảng trong khoá thì đổi bộ lọc ngày sẽ nhận lại dữ liệu của
    // khoảng cũ — số liệu vẫn trông hợp lý, chỉ là của khoảng khác.
    await get('/api/projects/PAY/epics/PAY-1/burndown?from=2026-03-02&to=2026-03-06');
    await get('/api/projects/PAY/epics/PAY-1/burndown?from=2026-03-09&to=2026-03-13');

    expect(reads.snapshotQueries).toBe(2);
    expect(redis.store.size).toBe(2);
  });

  it('chế độ xem khác nhau cũng tạo khoá khác nhau', async () => {
    await get('/api/projects/PAY/epics/PAY-1/burndown/phase/DESIGN');
    await get('/api/projects/PAY/epics/PAY-1/burndown/phases/compare?codes=DESIGN');

    expect(redis.store.size).toBe(2);
  });

  it('xoá cache dùng SCAN, KHÔNG dùng KEYS', async () => {
    await get('/api/projects/PAY/epics/PAY-1/burndown');
    await get('/api/projects/PAY/epics/PAY-2/burndown');

    const cache = createChartCache({ redis });
    const removed = await cache.invalidateEpic('PAY-1');

    expect(redis.scanCalls).toBeGreaterThan(0);
    expect(removed).toBe(1);
    // Cache của Epic khác không bị đụng tới.
    expect([...redis.store.keys()].some((k) => k.startsWith('chart:PAY-2:'))).toBe(true);
  });

  it('mẫu xoá chỉ khớp đúng Epic được chỉ định', () => {
    expect(chartCachePattern('PAY-1')).toBe('chart:PAY-1:*');
  });

  it('Redis chết thì vẫn trả dữ liệu từ database kèm cảnh báo, KHÔNG trả 500', async () => {
    // Cache là tối ưu, không phải điều kiện để chạy.
    redis.failMode = 'all';
    const warnings: string[] = [];

    const app2 = Fastify();
    registerBurndownRoutes(app2, {
      reads,
      cache: createChartCache({ redis, onWarning: (code) => warnings.push(code) }),
      guards: testGuards({ principal: () => asAdmin() }),
    });
    await app2.ready();

    const res = await app2.inject({ method: 'GET', url: '/api/projects/PAY/epics/PAY-1/burndown' });

    expect(res.statusCode).toBe(200);
    expect(warnings).toContain('CACHE_READ_FAILED');
    expect(warnings).toContain('CACHE_WRITE_FAILED');
  });
});

describe('đường Kế hoạch trôi theo dữ liệu Jira', () => {
  it('phản hồi LUÔN có planIsFloating và câu giải thích', async () => {
    // Không nói rõ thì PM thấy điểm hôm qua đổi chỗ và tưởng hệ thống hỏng.
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');

    expect(body.planIsFloating).toBe(true);
    expect(body.planNote).toContain('recomputed after every sync');
  });

  it('cảnh báo lịch (thiếu ngày lễ, lịch không tồn tại) đi kèm phản hồi — E-14 không im lặng', async () => {
    // T-12 sinh cảnh báo kèm dữ liệu từ đầu, nhưng trước T-38 nó không tới
    // được phản hồi API — màn hình không có gì để hiện.
    reads.meta = {
      projectKey: 'PAY',
      calendar: { ...CALENDAR, warnings: ['Lịch "VN_STANDARD" chưa khai ngày lễ nào.'] },
    };
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');

    expect(body.calendarWarnings).toEqual(['Lịch "VN_STANDARD" chưa khai ngày lễ nào.']);
  });

  it('đếm đúng tổng số ngày bị lùi và số lần lùi', () => {
    const shifts: PlanShiftRecord[] = [
      { phaseCode: 'DESIGN', shiftType: 'END_MOVED', fromDate: '2026-03-04', toDate: '2026-03-10', shiftedWorkdays: 4, causedByKeys: ['PAY-17'] },
      { phaseCode: 'DEV', shiftType: 'END_MOVED', fromDate: '2026-03-13', toDate: '2026-03-16', shiftedWorkdays: 1, causedByKeys: [] },
    ];
    const summary = summarizeShifts(shifts, reads.rollups);

    expect(summary.totalShiftedWorkdays).toBe(5);
    expect(summary.shiftCount).toBe(2);
  });

  it('KHÔNG trừ bớt phần kéo sớm lên khi tính tổng ngày lùi', () => {
    // Một Phase về sớm che mất một Phase đang trễ — đúng thứ R-11 sinh ra để
    // phát hiện.
    const shifts: PlanShiftRecord[] = [
      { phaseCode: 'DESIGN', shiftType: 'END_MOVED', fromDate: '2026-03-04', toDate: '2026-03-10', shiftedWorkdays: 4, causedByKeys: [] },
      { phaseCode: 'DEV', shiftType: 'START_MOVED', fromDate: '2026-03-09', toDate: '2026-03-05', shiftedWorkdays: -4, causedByKeys: [] },
    ];
    const summary = summarizeShifts(shifts, reads.rollups);

    expect(summary.totalShiftedWorkdays).toBe(4);
    expect(summary.shiftCount).toBe(1);
  });

  it('lùi quá 20% độ dài kế hoạch thì cảnh báo, quá 40% thì nghiêm trọng', () => {
    // Tổng độ dài kế hoạch của fixture là 10 ngày làm việc.
    const make = (days: number): PlanShiftRecord[] => [
      { phaseCode: 'DESIGN', shiftType: 'END_MOVED', fromDate: 'x', toDate: 'y', shiftedWorkdays: days, causedByKeys: [] },
    ];

    expect(summarizeShifts(make(1), reads.rollups).warningLevel).toBe('OK');
    expect(summarizeShifts(make(3), reads.rollups).warningLevel).toBe('WARN');
    expect(summarizeShifts(make(5), reads.rollups).warningLevel).toBe('CRITICAL');
  });

  it('Phase chưa có ngày kế hoạch thì KHÔNG tính ra tỉ lệ vô nghĩa', () => {
    // Chia cho 0 cho ra Infinity và mọi Epic mới đều bị báo CRITICAL.
    const noPlan = [rollup('DESIGN', null, null, null)];
    const shifts: PlanShiftRecord[] = [
      { phaseCode: 'DESIGN', shiftType: 'END_MOVED', fromDate: 'x', toDate: 'y', shiftedWorkdays: 9, causedByKeys: [] },
    ];
    expect(summarizeShifts(shifts, noPlan).warningLevel).toBe('OK');
  });
});

describe('dấu mốc', () => {
  it('phát sinh việc sinh dấu mốc SCOPE_ADDED tính bằng giờ', async () => {
    reads.snapshots = [snapshot('2026-03-02', 288_000, 288_000, { scopeAddedS: 36_000 })];
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');

    const marker = body.markers.find((m) => m.type === 'SCOPE_ADDED');
    expect(marker?.amount).toBe(10);
    expect(marker?.detail).toContain('10h');
  });

  it('mốc dịch chuyển kế hoạch nói rõ dời từ đâu sang đâu và do ai', async () => {
    reads.planShifts = [
      { phaseCode: 'DESIGN', shiftType: 'END_MOVED', fromDate: '2026-03-04', toDate: '2026-03-10', shiftedWorkdays: 4, causedByKeys: ['PAY-17'] },
    ];
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');

    const marker = body.markers.find((m) => m.type === 'PLAN_SHIFTED');
    expect(marker?.date).toBe('2026-03-10');
    expect(marker?.detail).toContain('2026-03-04');
    expect(marker?.detail).toContain('4 working days');
    expect(marker?.causedByKeys).toEqual(['PAY-17']);
  });

  it('ngày không phát sinh gì thì KHÔNG sinh dấu mốc', async () => {
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    expect(body.markers).toEqual([]);
  });
});

describe('đơn vị và tham số', () => {
  it('giá trị trả về là GIỜ, không phải giây', async () => {
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    expect(body.series[0]?.points[0]?.actualRemainingHours).toBe(80);
  });

  it('chênh lệch bằng kế hoạch trừ thực tế', async () => {
    const { body } = await get('/api/projects/PAY/epics/PAY-1/burndown');
    const p = body.series[0]?.points[1];
    expect(p?.varianceHours).toBeCloseTo((p?.plannedRemainingHours ?? 0) - (p?.actualRemainingHours ?? 0), 10);
  });

  it('tham số ngày sai định dạng bị từ chối ngay, không im lặng bỏ qua', async () => {
    const { status, body } = await get('/api/projects/PAY/epics/PAY-1/burndown?from=02/03/2026');
    expect(status).toBe(400);
    expect(body.message).toContain('YYYY-MM-DD');
  });

  it('Epic chưa Sub-task nào có ngày kế hoạch thì báo rõ, không trả biểu đồ rỗng', async () => {
    reads.rollups = [rollup('DESIGN', null, null, null)];
    const { status, body } = await get('/api/projects/PAY/epics/PAY-1/burndown');

    expect(status).toBe(409);
    expect(body.message).toContain('wbs_start_date');
  });
});

describe('phân quyền', () => {
  it('PM của dự án KHÁC nhận 404 PROJECT_NOT_FOUND — không lộ tenant tồn tại', async () => {
    principal = asPm('CRM');
    const { status, body } = await get('/api/projects/PAY/epics/PAY-1/burndown');

    expect(status).toBe(404);
    expect(body.error).toBe('PROJECT_NOT_FOUND');
  });

  it('PM phụ trách đúng project thì xem được', async () => {
    principal = asPm('PAY');
    expect((await get('/api/projects/PAY/epics/PAY-1/burndown')).status).toBe(200);
  });

  it('VIEWER của dự án xem được — nhưng CHỈ trong dự án của mình', async () => {
    principal = asViewer('PAY');
    expect((await get('/api/projects/PAY/epics/PAY-1/burndown')).status).toBe(200);
  });

  it('Epic của TENANT KHÁC ghép vào URL dự án mình → 404 EPIC_NOT_FOUND', async () => {
    // Epic có thật nhưng thuộc CRM: PM của PAY không mở được nó qua URL của
    // PAY — trả lời giống hệt "không tồn tại" để không dò được chéo tenant.
    principal = asPm('PAY');
    reads.meta = { projectKey: 'CRM', calendar: CALENDAR };
    const { status, body } = await get('/api/projects/PAY/epics/CRM-9/burndown');

    expect(status).toBe(404);
    expect(body.error).toBe('EPIC_NOT_FOUND');
  });

  it('thiếu thông tin người dùng nhận HTTP 401', async () => {
    principal = null;
    expect((await get('/api/projects/PAY/epics/PAY-1/burndown')).status).toBe(401);
  });
});
