import { describe, it, expect } from 'vitest';
import { opsHealthResponseSchema } from '@app/shared';
import { buildOpsHealth, capLevel, planDriftLevel, type OpsHealthInput } from './ops-health.service.js';

/**
 * Dashboard giám sát vận hành (T-33) — logic thuần: ngưỡng, sắp xếp, trạng thái
 * rỗng. Ba cạm bẫy được canh ở đây, không cần PostgreSQL.
 */

const COLLECTED_AT = new Date('2026-03-10T02:00:00.000Z');

function input(over: Partial<OpsHealthInput> = {}): OpsHealthInput {
  return {
    collectedAt: COLLECTED_AT,
    nightlyDurationMinutes: 18,
    rateLimitHits24h: 3,
    erroredEpicCount: 0,
    snapshotBehindCount: 0,
    data: {
      total: 100,
      missingEstimateRatio: 0.05,
      unclassifiedPhaseRatio: 0.05,
      missingWbsDateRatio: 0.05,
      unparsedSubtaskRatio: 0.05,
    },
    dataByEpic: [],
    recentRuns: [],
    erroredEpics: [],
    planDrift: [],
    ...over,
  };
}

const metricByName = (res: ReturnType<typeof buildOpsHealth>, name: string) =>
  [...res.jobs.metrics, ...res.jira.metrics, ...res.data.metrics].find((m) => m.name === name);

describe('capLevel — số đo kiểu "trần", càng cao càng xấu', () => {
  it('ngưỡng dương: vượt → CRITICAL, chạm 80% → WARN, dưới → OK', () => {
    expect(capLevel(300, 240)).toBe('CRITICAL');
    expect(capLevel(200, 240)).toBe('WARN'); // 200 >= 192
    expect(capLevel(18, 240)).toBe('OK');
  });

  it('ngưỡng 0 (không dung sai): mọi giá trị dương là CRITICAL ngay', () => {
    expect(capLevel(0, 0)).toBe('OK');
    expect(capLevel(1, 0)).toBe('CRITICAL');
  });
});

describe('planDriftLevel — R-11, dùng chung ngưỡng 20%/40%', () => {
  it('>40% CRITICAL, >20% WARN, còn lại OK', () => {
    expect(planDriftLevel(0.6)).toBe('CRITICAL');
    expect(planDriftLevel(0.3)).toBe('WARN');
    expect(planDriftLevel(0.2)).toBe('OK'); // đúng 20% chưa QUÁ ngưỡng
    expect(planDriftLevel(0.1)).toBe('OK');
  });
});

describe('buildOpsHealth — hợp đồng phản hồi', () => {
  it('trả về ĐỦ bốn nhóm số liệu trong MỘT lần gọi và khớp schema hợp đồng', () => {
    const res = buildOpsHealth(input());
    // Khớp đúng schema mà web client sẽ parse — sai một trường là màn hình vỡ.
    expect(() => opsHealthResponseSchema.parse(res)).not.toThrow();
    expect(res.jobs.metrics.length).toBeGreaterThan(0);
    expect(res.jira.metrics.length).toBeGreaterThan(0);
    expect(res.data.metrics.length).toBe(4);
    expect(res.planDrift.rows).toEqual([]);
  });

  it('luôn hiện THỜI ĐIỂM lấy số liệu (collectedAt) dưới dạng ISO', () => {
    const res = buildOpsHealth(input());
    expect(res.collectedAt).toBe(COLLECTED_AT.toISOString());
  });

  it('KHÔNG có trường thừa — endpoint chỉ ghép số đếm, không rò rỉ gì khác', () => {
    const res = buildOpsHealth(input());
    expect(Object.keys(res).sort()).toEqual(['collectedAt', 'data', 'jira', 'jobs', 'planDrift']);
    expect(Object.keys(res.jobs).sort()).toEqual(['erroredEpics', 'metrics', 'recentRuns']);
  });
});

describe('buildOpsHealth — số đo vượt ngưỡng bị đánh dấu', () => {
  it('job đêm quá 240 phút → CRITICAL; chạm 80% → WARN', () => {
    expect(metricByName(buildOpsHealth(input({ nightlyDurationMinutes: 300 })), 'nightlyDuration')?.level).toBe(
      'CRITICAL',
    );
    expect(metricByName(buildOpsHealth(input({ nightlyDurationMinutes: 200 })), 'nightlyDuration')?.level).toBe('WARN');
  });

  it('bị Jira chặn vượt 10 lần/24h → CRITICAL', () => {
    const m = metricByName(buildOpsHealth(input({ rateLimitHits24h: 11 })), 'rateLimitHits');
    expect(m?.level).toBe('CRITICAL');
    expect(m?.value).toBe(11);
    expect(m?.threshold).toBe(10);
  });

  it('có Epic đang lỗi → CRITICAL (ngưỡng 0, không dung sai)', () => {
    expect(metricByName(buildOpsHealth(input({ erroredEpicCount: 2 })), 'erroredEpics')?.level).toBe('CRITICAL');
  });

  it('dữ liệu bẩn: 20% thiếu ngày kế hoạch → WARN, 40% → CRITICAL, hiện dạng phần trăm kèm ngưỡng', () => {
    const warn = metricByName(
      buildOpsHealth(input({ data: { ...input().data, missingWbsDateRatio: 0.2 } })),
      'missingWbsDate',
    );
    expect(warn?.value).toBe(20);
    expect(warn?.threshold).toBe(10); // warn 0.1 → 10%
    expect(warn?.unit).toBe('%');
    expect(warn?.level).toBe('WARN');

    const crit = metricByName(
      buildOpsHealth(input({ data: { ...input().data, missingWbsDateRatio: 0.4 } })),
      'missingWbsDate',
    );
    expect(crit?.level).toBe('CRITICAL');
  });
});

describe('buildOpsHealth — chưa đo được nói "chưa đo được", KHÔNG hiện 0', () => {
  it('nightly chưa từng chạy → value null + UNKNOWN', () => {
    const m = metricByName(buildOpsHealth(input({ nightlyDurationMinutes: null })), 'nightlyDuration');
    expect(m?.value).toBeNull();
    expect(m?.level).toBe('UNKNOWN');
  });

  it('chưa có Sub-task nào (total 0) → mọi số đo dữ liệu là null/UNKNOWN, không phải 0/OK', () => {
    const res = buildOpsHealth(input({ data: { ...input().data, total: 0 } }));
    for (const m of res.data.metrics) {
      expect(m.value).toBeNull();
      expect(m.level).toBe('UNKNOWN');
      // Ngưỡng vẫn hiện để biết đang đo cái gì.
      expect(m.threshold).toBeGreaterThan(0);
    }
  });
});

describe('buildOpsHealth — Data quality tách theo Epic đang theo dõi', () => {
  it('mỗi Epic có bộ 4 số đo riêng, cùng ngưỡng với số toàn cục', () => {
    const res = buildOpsHealth(
      input({
        dataByEpic: [
          {
            epicKey: 'PAY-1',
            displayName: 'Payment',
            total: 50,
            missingEstimateRatio: 0.4, // CRITICAL
            unclassifiedPhaseRatio: 0,
            missingWbsDateRatio: 0,
            unparsedSubtaskRatio: 0,
          },
          {
            epicKey: 'CRM-1',
            displayName: 'CRM',
            total: 50,
            missingEstimateRatio: 0,
            unclassifiedPhaseRatio: 0,
            missingWbsDateRatio: 0,
            unparsedSubtaskRatio: 0,
          },
        ],
      }),
    );
    expect(res.data.byEpic).toHaveLength(2);
    // Epic tệ nhất lên trước — người trực đọc từ trên xuống.
    expect(res.data.byEpic[0]?.epicKey).toBe('PAY-1');
    expect(res.data.byEpic[0]?.metrics.find((m) => m.name === 'missingEstimate')?.level).toBe('CRITICAL');
    expect(res.data.byEpic[1]?.metrics.every((m) => m.level === 'OK')).toBe(true);
    expect(() => opsHealthResponseSchema.parse(res)).not.toThrow();
  });

  it('Epic chưa có Sub-task nào → null/UNKNOWN, không hiện 0 như thể sạch', () => {
    const res = buildOpsHealth(
      input({
        dataByEpic: [
          {
            epicKey: 'NEW-1',
            displayName: 'Mới thêm',
            total: 0,
            missingEstimateRatio: 0,
            unclassifiedPhaseRatio: 0,
            missingWbsDateRatio: 0,
            unparsedSubtaskRatio: 0,
          },
        ],
      }),
    );
    for (const m of res.data.byEpic[0]?.metrics ?? []) {
      expect(m.value).toBeNull();
      expect(m.level).toBe('UNKNOWN');
    }
  });
});

describe('buildOpsHealth — Epic lỗi', () => {
  it('giữ NGUYÊN VĂN thông báo lỗi và tính đúng số giờ đã lỗi', () => {
    const res = buildOpsHealth(
      input({
        erroredEpicCount: 1,
        erroredEpics: [
          { epicKey: 'PAY-9', lastError: 'Jira trả 401: token hết hạn', since: new Date('2026-03-09T00:00:00.000Z') },
        ],
      }),
    );
    expect(res.jobs.erroredEpics).toHaveLength(1);
    expect(res.jobs.erroredEpics[0]?.lastError).toBe('Jira trả 401: token hết hạn');
    // 2026-03-10T02:00 − 2026-03-09T00:00 = 26 giờ.
    expect(res.jobs.erroredEpics[0]?.erroredSinceHours).toBe(26);
  });
});

describe('buildOpsHealth — lần chạy job gần nhất', () => {
  it('đổi ms sang giây; job đang chạy (durationMs null) → durationSeconds null', () => {
    const res = buildOpsHealth(
      input({
        recentRuns: [
          {
            runId: '1',
            epicKey: 'PAY-1',
            runType: 'DAILY',
            status: 'SUCCESS',
            startedAt: new Date('2026-03-10T00:01:00.000Z'),
            durationMs: 1_080_000,
            errorMessage: null,
          },
          {
            runId: '2',
            epicKey: 'PAY-2',
            runType: 'DAILY',
            status: 'RUNNING',
            startedAt: new Date('2026-03-10T00:02:00.000Z'),
            durationMs: null,
            errorMessage: null,
          },
        ],
      }),
    );
    expect(res.jobs.recentRuns[0]?.durationSeconds).toBe(1080);
    expect(res.jobs.recentRuns[0]?.startedAt).toBe('2026-03-10T00:01:00.000Z');
    expect(res.jobs.recentRuns[1]?.durationSeconds).toBeNull();
  });
});

describe('buildOpsHealth — trôi kế hoạch', () => {
  it('CHỈ hiện Phase đã trôi quá ngưỡng, nghiêm trọng nhất lên đầu', () => {
    const res = buildOpsHealth(
      input({
        planDrift: [
          { epicKey: 'PAY-1', phaseCode: 'DESIGN', shiftedWorkdays: 3, planWorkdays: 10 }, // 0.3 → WARN
          { epicKey: 'PAY-2', phaseCode: 'DEV', shiftedWorkdays: 6, planWorkdays: 10 }, // 0.6 → CRITICAL
          { epicKey: 'PAY-3', phaseCode: 'TEST', shiftedWorkdays: 1, planWorkdays: 10 }, // 0.1 → OK, bị lọc
        ],
      }),
    );
    expect(res.planDrift.rows).toHaveLength(2);
    expect(res.planDrift.rows[0]?.epicKey).toBe('PAY-2');
    expect(res.planDrift.rows[0]?.level).toBe('CRITICAL');
    expect(res.planDrift.rows[1]?.level).toBe('WARN');
    expect(res.planDrift.rows[0]?.ratio).toBeCloseTo(0.6);
  });

  it('Phase không có độ dài kế hoạch (planWorkdays 0) không thể tính tỉ lệ → bị lọc', () => {
    const res = buildOpsHealth(
      input({ planDrift: [{ epicKey: 'PAY-1', phaseCode: 'DESIGN', shiftedWorkdays: 9, planWorkdays: 0 }] }),
    );
    expect(res.planDrift.rows).toEqual([]);
  });
});
