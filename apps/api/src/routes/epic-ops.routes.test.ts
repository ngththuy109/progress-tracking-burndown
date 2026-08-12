import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  type ChangelogEvent,
  type EpicHealthResponse,
  type ExplainResponse,
  type PlanShiftHistoryResponse,
  type PlanShiftRecord,
  type Principal,
  type ResyncResponse,
  type StatusIdMap,
  type SubtaskRecord,
  type TrackedEpicStatus,
  type WorkCalendar,
} from '@app/shared';
import {
  registerEpicOpsRoutes,
  type EpicOpsReadPort,
  type EpicOpsWritePort,
} from './epic-ops.routes.js';
import { levelOf } from '../services/epic-health.service.js';
import { asAdmin, asPm, asViewer, testGuards } from '../test-fakes.js';

const CALENDAR: WorkCalendar = {
  calendarId: 'test',
  timezone: 'Asia/Ho_Chi_Minh',
  workdaysMask: DEFAULT_WORKDAYS_MASK,
  hoursPerDay: 8,
  holidays: new Set(),
  warnings: [],
};

const STATUS_IDS: StatusIdMap = new Map([
  ['1', 'new'],
  ['3', 'indeterminate'],
  ['6', 'done'],
]);


const ms = (iso: string): number => Date.parse(iso);

function st(from: string, to: string, at: string): ChangelogEvent {
  return { issueKey: '', field: 'status', fromValue: from, toValue: to, createdAtMs: ms(at) };
}
function est(to: string | null, at: string): ChangelogEvent {
  return { issueKey: '', field: 'timeestimate', fromValue: null, toValue: to, createdAtMs: ms(at) };
}

function sub(key: string, over: Partial<SubtaskRecord> = {}): SubtaskRecord {
  return {
    key,
    phaseCode: 'DESIGN',
    originalEstimateSeconds: 28_800,
    createdAtMs: ms('2026-03-01T01:00:00+07:00'),
    removedAtMs: null,
    wbsStartDate: '2026-03-02',
    wbsEndDate: '2026-03-06',
    changelog: [],
    worklogs: [],
    ...over,
  };
}

class FakeReads implements EpicOpsReadPort {
  status: TrackedEpicStatus = 'ACTIVE';
  projectKey = 'PAY';
  lastError: string | null = null;
  subtasks: SubtaskRecord[] = [];
  stored: number | null = 28_800;
  ratios = {
    missingEstimateRatio: 0,
    unclassifiedPhaseRatio: 0,
    missingWbsDateRatio: 0,
    unparsedSubtaskRatio: 0,
  };
  dates = new Set<string>(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']);
  shifts: (PlanShiftRecord & { detectedAt: Date })[] = [];
  planWorkdays = 10;

  async epicMeta() {
    return {
      projectKey: this.projectKey,
      status: this.status,
      lastSyncedAt: new Date('2026-03-06T17:00:00Z'),
      lastError: this.lastError,
      calendar: CALENDAR,
      firstSnapshotDate: '2026-03-02',
      lastSnapshotDate: '2026-03-06',
    };
  }
  async healthRatios() {
    return this.ratios;
  }
  async snapshotDates() {
    return this.dates;
  }
  async storedRemaining() {
    return this.stored;
  }
  async subtasksWithHistory() {
    return {
      subtasks: this.subtasks,
      summaries: Object.fromEntries(this.subtasks.map((s) => [s.key, `Việc ${s.key}`])),
      statusIdMap: STATUS_IDS,
      changeAuthors: { [`PAY-12:${ms('2026-03-03T10:00:00+07:00')}`]: 'thuy' },
    };
  }
  async planShifts() {
    return this.shifts;
  }
  async totalPlanWorkdays() {
    return this.planWorkdays;
  }
}

class FakeWrites implements EpicOpsWritePort {
  statusCalls: TrackedEpicStatus[] = [];
  enqueued: string[] = [];
  /**
   * Nội dung job đã đẩy — KHÔNG chỉ đếm số lần gọi.
   *
   * Bản cũ của lớp giả này bỏ luôn tham số thứ hai, nên mọi test đều xanh trong
   * khi `full` chưa từng đi tới worker. Lớp giả bỏ qua tham số là một cách nói
   * dối rất khó nhìn ra.
   */
  payloads: { from: string | null; to: string | null; full: boolean }[] = [];

  async setStatus(_k: string, status: TrackedEpicStatus) {
    this.statusCalls.push(status);
  }
  async enqueueSync(
    epicKey: string,
    args: { from: string | null; to: string | null; full: boolean },
  ) {
    const jobId = `sync-epic:${epicKey}`;
    this.payloads.push(args);
    // Chống trùng: cùng jobId thì chỉ giữ một cái, giống BullMQ.
    if (!this.enqueued.includes(jobId)) this.enqueued.push(jobId);
    return jobId;
  }
}

let reads: FakeReads;
let writes: FakeWrites;
let app: FastifyInstance;
let principal: Principal | null;

beforeEach(async () => {
  reads = new FakeReads();
  writes = new FakeWrites();
  principal = asAdmin();

  app = Fastify();
  registerEpicOpsRoutes(app, {
    reads,
    writes,
    guards: testGuards({ principal: () => principal }),
  });
  await app.ready();
});

async function call<T>(method: 'GET' | 'POST', url: string, body?: Record<string, unknown>) {
  const res =
    body === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload: body });
  return { status: res.statusCode, body: res.json() as T & { error?: string; message?: string } };
}

// ---------------------------------------------------------------------------

describe('giải thích số liệu', () => {
  it('Sub-task đã Done áp dụng Quy tắc 1 và còn lại 0 giờ', async () => {
    reads.subtasks = [
      sub('PAY-11', { changelog: [st('1', '6', '2026-03-02T18:00:00+07:00')] }),
    ];
    reads.stored = 0;

    const { body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-03/explain');
    const row = body.rows[0];

    expect(row?.appliedRule).toBe(1);
    expect(row?.remainingHours).toBe(0);
    expect(row?.statusCategoryAtDay).toBe('done');
    expect(row?.ruleExplanation).toContain('Done status category');
  });

  it('Sub-task bị sửa tay ước lượng áp dụng Quy tắc 2 và trả về estimateOverride', async () => {
    // Đây chính là thứ runbook bảo đi tìm khi PM báo số liệu sai.
    reads.subtasks = [sub('PAY-12', { changelog: [est('18000', '2026-03-03T10:00:00+07:00')] })];
    reads.stored = 18_000;

    const { body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-04/explain');
    const row = body.rows[0];

    expect(row?.appliedRule).toBe(2);
    expect(row?.remainingHours).toBe(5);
    expect(row?.estimateOverride?.valueHours).toBe(5);
    expect(row?.estimateOverride?.changedBy).toBe('thuy');
  });

  it('Sub-task bình thường áp dụng Quy tắc 3: ước lượng trừ giờ đã log', async () => {
    reads.subtasks = [
      sub('PAY-13', {
        worklogs: [
          { worklogId: 'w1', issueKey: 'PAY-13', timeSpentSeconds: 7200, startedAtMs: ms('2026-03-02T09:00:00+07:00'), isDeleted: false },
        ],
      }),
    ];
    reads.stored = 21_600;

    const { body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-03/explain');
    const row = body.rows[0];

    expect(row?.appliedRule).toBe(3);
    expect(row?.originalEstimateHours).toBe(8);
    expect(row?.spentHoursUpToDay).toBe(2);
    expect(row?.remainingHours).toBe(6);
  });

  it('Quy tắc 2 THẮNG Quy tắc 3 khi cả hai cùng thoả', async () => {
    // Nguyên nhân sai số phổ biến nhất (PRD §10.3): ai đó sửa tay một lần và
    // giá trị đó dính mãi, log thêm giờ cũng không kéo nó xuống.
    reads.subtasks = [
      sub('PAY-14', {
        changelog: [est('18000', '2026-03-02T10:00:00+07:00')],
        worklogs: [
          { worklogId: 'w1', issueKey: 'PAY-14', timeSpentSeconds: 25_200, startedAtMs: ms('2026-03-02T09:00:00+07:00'), isDeleted: false },
        ],
      }),
    ];
    reads.stored = 18_000;

    const { body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-03/explain');

    expect(body.rows[0]?.appliedRule).toBe(2);
    // Quy tắc 3 sẽ cho 28800 − 25200 = 3600 (1 giờ). Quy tắc 2 cho 5 giờ.
    expect(body.rows[0]?.remainingHours).toBe(5);
  });

  it('Quy tắc 1 THẮNG cả Quy tắc 2 lẫn 3 khi đã Done', async () => {
    reads.subtasks = [
      sub('PAY-15', {
        changelog: [est('18000', '2026-03-02T10:00:00+07:00'), st('3', '6', '2026-03-02T18:00:00+07:00')],
      }),
    ];
    reads.stored = 0;

    const { body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-03/explain');
    expect(body.rows[0]?.appliedRule).toBe(1);
  });

  it('tổng các dòng khớp đúng số đã lưu thì không có phần mismatch', async () => {
    reads.subtasks = [sub('PAY-11'), sub('PAY-12')];
    reads.stored = 57_600;

    const { body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-03/explain');

    expect(body.recomputedRemainingHours).toBe(16);
    expect(body.storedRemainingHours).toBe(16);
    expect(body.mismatch).toBeNull();
  });

  it('số tính lại LỆCH số đã lưu thì trả về cả hai con số', async () => {
    // Đây là lý do tồn tại của endpoint: phát hiện snapshot cũ hoặc engine sai.
    reads.subtasks = [sub('PAY-11')];
    reads.stored = 14_400;

    const { body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-03/explain');

    expect(body.mismatch).toEqual({ storedHours: 4, recomputedHours: 8, differenceHours: 4 });
  });

  it('mỗi dòng có câu giải thích tiếng Việt, không chỉ số quy tắc', async () => {
    reads.subtasks = [sub('PAY-11')];
    const { body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-03/explain');

    expect(body.rows[0]?.ruleExplanation).toContain('Rule 3');
    expect(body.rows[0]?.ruleExplanation.length).toBeGreaterThan(30);
  });

  it('Sub-task UNCLASSIFIED VẪN xuất hiện trong danh sách', async () => {
    // Bỏ nó đi thì tổng không khớp snapshot và người điều tra sẽ đi tìm một sai
    // số không tồn tại (C-11).
    reads.subtasks = [sub('PAY-11'), sub('PAY-99', { phaseCode: 'UNCLASSIFIED' })];
    reads.stored = 57_600;

    const { body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-03/explain');

    expect(body.rows.map((r) => r.issueKey)).toEqual(['PAY-11', 'PAY-99']);
    expect(body.mismatch).toBeNull();
  });

  it('Sub-task tạo sau ngày đó KHÔNG xuất hiện', async () => {
    reads.subtasks = [sub('PAY-11'), sub('PAY-20', { createdAtMs: ms('2026-03-05T09:00:00+07:00') })];
    reads.stored = 28_800;

    const { body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-03/explain');
    expect(body.rows.map((r) => r.issueKey)).toEqual(['PAY-11']);
  });

  it('ngày chưa có snapshot trả 404 kèm cách khắc phục, KHÔNG tính bù tại chỗ', async () => {
    reads.stored = null;
    const { status, body } = await call<ExplainResponse>('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/2026-03-12/explain');

    expect(status).toBe(404);
    expect(body.error).toBe('NO_SNAPSHOT');
    expect(body.message).toContain('Resync');
  });

  it('ngày sai định dạng bị từ chối', async () => {
    const { status } = await call('GET', '/api/projects/PAY/epics/PAY-1/burndown/day/12-03-2026/explain');
    expect(status).toBe(400);
  });
});

describe('sức khoẻ dữ liệu', () => {
  it('missingSnapshotDays trả về NGÀY cụ thể, không phải con số', async () => {
    reads.dates = new Set(['2026-03-02', '2026-03-03', '2026-03-05', '2026-03-06']);
    const { body } = await call<EpicHealthResponse>('GET', '/api/projects/PAY/epics/PAY-1/health');

    expect(body.missingSnapshotDays).toEqual(['2026-03-04']);
  });

  it('Epic dữ liệu sạch cho mọi chỉ số mức OK', async () => {
    const { body } = await call<EpicHealthResponse>('GET', '/api/projects/PAY/epics/PAY-1/health');

    expect(body.metrics.every((m) => m.level === 'OK')).toBe(true);
    expect(body.overallLevel).toBe('OK');
  });

  it('ngưỡng cảnh báo khớp đúng PRD §10.4', () => {
    expect(levelOf('unclassifiedPhaseRatio', 0.19)).toBe('OK');
    expect(levelOf('unclassifiedPhaseRatio', 0.2)).toBe('WARN');
    expect(levelOf('unclassifiedPhaseRatio', 0.4)).toBe('CRITICAL');

    expect(levelOf('missingWbsDateRatio', 0.09)).toBe('OK');
    expect(levelOf('missingWbsDateRatio', 0.1)).toBe('WARN');
    expect(levelOf('missingWbsDateRatio', 0.3)).toBe('CRITICAL');
  });

  it('mức tổng lấy chỉ số XẤU NHẤT, không lấy trung bình', async () => {
    // Trung bình sẽ để ba chỉ số tốt che mất một chỉ số nghiêm trọng.
    reads.ratios = { ...reads.ratios, missingWbsDateRatio: 0.5 };
    const { body } = await call<EpicHealthResponse>('GET', '/api/projects/PAY/epics/PAY-1/health');

    expect(body.overallLevel).toBe('CRITICAL');
  });

  it('mỗi chỉ số vượt ngưỡng đều nói rõ phải làm gì tiếp', async () => {
    reads.ratios = { ...reads.ratios, unclassifiedPhaseRatio: 0.25 };
    const { body } = await call<EpicHealthResponse>('GET', '/api/projects/PAY/epics/PAY-1/health');

    const metric = body.metrics.find((m) => m.name === 'unclassifiedPhaseRatio');
    expect(metric?.message).toContain('Phase settings');
  });

  it('Epic đang ERROR trả kèm nguyên văn lỗi', async () => {
    reads.status = 'ERROR';
    reads.lastError = 'Jira trả 401: token hết hạn';
    const { body } = await call<EpicHealthResponse>('GET', '/api/projects/PAY/epics/PAY-1/health');

    expect(body.status).toBe('ERROR');
    expect(body.lastError).toBe('Jira trả 401: token hết hạn');
  });
});

describe('đồng bộ lại', () => {
  it('đẩy job và trả về NGAY, không chạy đồng bộ trong request', async () => {
    const { status, body } = await call<ResyncResponse>('POST', '/api/projects/PAY/epics/PAY-1/resync', {});

    expect(status).toBe(200);
    expect(body.queued).toBe(true);
    expect(writes.enqueued).toEqual(['sync-epic:PAY-1']);
  });

  it('Epic đang ERROR thì chuyển về BACKFILLING qua máy trạng thái', async () => {
    reads.status = 'ERROR';
    await call('POST', '/api/projects/PAY/epics/PAY-1/resync', { full: true });

    expect(writes.statusCalls).toEqual(['BACKFILLING']);
  });

  it('Epic đang PAUSED thì bị từ chối, kèm cách bật lại', async () => {
    // Đánh thức một Epic đã cố ý tạm dừng sẽ vô hiệu hoá chính nút Tạm dừng.
    reads.status = 'PAUSED';
    const { status, body } = await call('POST', '/api/projects/PAY/epics/PAY-1/resync', {});

    expect(status).toBe(409);
    expect(body.error).toBe('EPIC_PAUSED');
    expect(body.message).toContain('Resume it');
    expect(writes.enqueued).toEqual([]);
  });

  it('Epic đang ACTIVE KHÔNG bị đổi trạng thái khi đồng bộ lại', async () => {
    // Máy trạng thái của T-10 cố ý không có nhánh ACTIVE → BACKFILLING: Epic
    // đang chạy bình thường vẫn phải ở ACTIVE trong lúc đồng bộ lại.
    reads.status = 'ACTIVE';
    const { status } = await call('POST', '/api/projects/PAY/epics/PAY-1/resync', {});

    expect(status).toBe(200);
    expect(writes.statusCalls).toEqual([]);
  });

  it('bấm hai lần chỉ tạo một job', async () => {
    await call('POST', '/api/projects/PAY/epics/PAY-1/resync', {});
    await call('POST', '/api/projects/PAY/epics/PAY-1/resync', {});

    expect(writes.enqueued).toHaveLength(1);
  });

  it('VIEWER của dự án không được đồng bộ lại (403)', async () => {
    principal = asViewer('PAY');
    const { status, body } = await call('POST', '/api/projects/PAY/epics/PAY-1/resync', {});

    expect(status).toBe(403);
    expect(body.error).toBe('FORBIDDEN');
  });

  it('PM của dự án KHÁC → 404, không lộ tenant', async () => {
    principal = asPm('CRM');
    const { status, body } = await call('POST', '/api/projects/PAY/epics/PAY-1/resync', {});
    expect(status).toBe(404);
    expect(body.error).toBe('PROJECT_NOT_FOUND');
  });

  it('Epic thuộc tenant khác ghép vào URL dự án mình → 404 EPIC_NOT_FOUND', async () => {
    principal = asPm('PAY');
    reads.projectKey = 'CRM'; // Epic thật ra của CRM
    const { status, body } = await call('POST', '/api/projects/PAY/epics/CRM-9/resync', {});
    expect(status).toBe(404);
    expect(body.error).toBe('EPIC_NOT_FOUND');
    expect(writes.enqueued).toEqual([]);
  });

  it('full = true ĐI TỚI ĐƯỢC nội dung job', async () => {
    // Đây là mắt xích từng đứt: API nhận `full`, đẩy vào job, rồi worker khai
    // kiểu job chỉ có `epicKey` nên không bao giờ nhìn thấy nó. Lệnh trong
    // runbook chạy trót lọt mà không dựng lại gì cả.
    await call('POST', '/api/projects/PAY/epics/PAY-1/resync', { full: true });

    expect(writes.payloads).toEqual([{ from: null, to: null, full: true }]);
  });

  it('dải ngày gõ tay cũng đi tới được nội dung job', async () => {
    await call('POST', '/api/projects/PAY/epics/PAY-1/resync', { from: '2026-03-01', to: '2026-03-11' });

    expect(writes.payloads).toEqual([{ from: '2026-03-01', to: '2026-03-11', full: false }]);
  });

  it('thân yêu cầu rỗng cho ra lượt đồng bộ tăng dần', async () => {
    await call('POST', '/api/projects/PAY/epics/PAY-1/resync', {});
    expect(writes.payloads).toEqual([{ from: null, to: null, full: false }]);
  });

  it('full là chuỗi "true" bị từ chối kèm ví dụ đúng, KHÔNG bị ép kiểu', async () => {
    // Lỗi gõ tay phổ biến nhất khi dán lệnh curl. Ép kiểu ngầm sẽ biến cả chuỗi
    // "false" thành true.
    const { status, body } = await call('POST', '/api/projects/PAY/epics/PAY-1/resync', { full: 'true' });

    expect(status).toBe(400);
    expect(body.message).toContain('full');
    expect(body.message).toContain('{"full": true}');
    expect(writes.enqueued).toEqual([]);
  });

  it('ngày sai định dạng bị chặn ngay ở API, không để job chết sau', async () => {
    const { status, body } = await call('POST', '/api/projects/PAY/epics/PAY-1/resync', { from: '01/03/2026' });

    expect(status).toBe(400);
    expect(body.message).toContain('YYYY-MM-DD');
    expect(writes.enqueued).toEqual([]);
  });
});

describe('lịch sử dịch chuyển kế hoạch', () => {
  const shift = (phaseCode: string, days: number, detectedAt: string) => ({
    phaseCode,
    shiftType: 'END_MOVED' as const,
    fromDate: '2026-03-04',
    toDate: '2026-03-10',
    shiftedWorkdays: days,
    causedByKeys: ['PAY-17'],
    detectedAt: new Date(detectedAt),
  });

  it('trả danh sách mới nhất trước', async () => {
    reads.shifts = [shift('A', 1, '2026-03-01T00:00:00Z'), shift('B', 1, '2026-03-05T00:00:00Z')];
    const { body } = await call<PlanShiftHistoryResponse>('GET', '/api/projects/PAY/epics/PAY-1/plan-shift-history');

    expect(body.shifts.map((s) => s.phaseCode)).toEqual(['B', 'A']);
  });

  it('lùi quá 40% độ dài kế hoạch cho mức nghiêm trọng', async () => {
    reads.shifts = [shift('DESIGN', 5, '2026-03-05T00:00:00Z')];
    const { body } = await call<PlanShiftHistoryResponse>('GET', '/api/projects/PAY/epics/PAY-1/plan-shift-history');

    expect(body.totalShiftedWorkdays).toBe(5);
    expect(body.warningLevel).toBe('CRITICAL');
  });

  it('KHÔNG trừ phần kéo sớm lên khi cộng tổng ngày lùi', async () => {
    reads.shifts = [shift('A', 3, '2026-03-05T00:00:00Z'), shift('B', -3, '2026-03-06T00:00:00Z')];
    const { body } = await call<PlanShiftHistoryResponse>('GET', '/api/projects/PAY/epics/PAY-1/plan-shift-history');

    expect(body.totalShiftedWorkdays).toBe(3);
  });

  it('Epic chưa từng bị lùi trả danh sách rỗng và mức OK', async () => {
    const { body } = await call<PlanShiftHistoryResponse>('GET', '/api/projects/PAY/epics/PAY-1/plan-shift-history');

    expect(body.shifts).toEqual([]);
    expect(body.warningLevel).toBe('OK');
  });
});
