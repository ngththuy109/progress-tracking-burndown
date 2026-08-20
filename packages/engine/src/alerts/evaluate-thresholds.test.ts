import { describe, expect, it } from 'vitest';
import { ALERT_CODE, ALERT_SPEC, type AlertCode } from '@app/shared';
import { evaluateThresholds, THRESHOLDS, type EvaluateArgs } from './evaluate-thresholds.js';

/** Epic sạch: không có chỉ số nào vượt ngưỡng. */
const CLEAN = {
  epicKey: 'PAY-1',
  lastJobFailed: false,
  missingSnapshotDays: [] as string[],
  rateLimitHits24h: 0,
  driftRatio: 0,
  planShiftRatio: 0,
  errorSinceHours: null as number | null,
  unclassifiedRatio: 0,
  missingEstimateRatio: 0,
  missingWbsRatio: 0,
  unparsedSubtaskRatio: 0,
};

function run(overrides: Partial<typeof CLEAN>, args: Partial<EvaluateArgs> = {}) {
  return evaluateThresholds({
    localHour: 3,
    epics: [{ ...CLEAN, ...overrides }],
    ...args,
  });
}

const codes = (alerts: { code: AlertCode }[]) => alerts.map((a) => a.code);

describe('mười một ngưỡng', () => {
  it('mỗi mã trong danh sách đều kích hoạt được ít nhất một lần', () => {
    // Chống bỏ sót: thêm mã mới vào `ALERT_CODE` mà quên viết nhánh đánh giá
    // thì test này đỏ ngay.
    const triggered = new Set<AlertCode>([
      ...codes(run({ lastJobFailed: true })),
      ...codes(run({ missingSnapshotDays: ['2026-03-12'] })),
      ...codes(run({ rateLimitHits24h: 11 })),
      ...codes(run({ driftRatio: 0.006 })),
      ...codes(run({ planShiftRatio: 0.21 })),
      ...codes(run({ errorSinceHours: 25 })),
      ...codes(run({ unclassifiedRatio: 0.21 })),
      ...codes(run({ missingEstimateRatio: 0.11 })),
      ...codes(run({ missingWbsRatio: 0.11 })),
      ...codes(run({ unparsedSubtaskRatio: 0.31 })),
      ...codes(evaluateThresholds({ localHour: 3, epics: [], system: { apiP95Ms: 2500 } })),
    ]);

    expect([...triggered].sort()).toEqual([...ALERT_CODE].sort());
  });

  it('Epic sạch không phát cảnh báo nào', () => {
    expect(run({})).toEqual([]);
  });
});

describe('mức và kênh gửi khớp bảng PRD §10.4', () => {
  it('job thất bại là P1, gửi cả Slack lẫn email', () => {
    const [alert] = run({ lastJobFailed: true });
    expect(alert?.level).toBe('P1');
    expect(ALERT_SPEC.JOB_FAILED.channels).toEqual(['SLACK', 'EMAIL']);
  });

  it('dữ liệu bẩn là P3, chỉ gửi email cho PM', () => {
    const [alert] = run({ unclassifiedRatio: 0.25 });
    expect(alert?.level).toBe('P3');
    expect(ALERT_SPEC.DIRTY_PHASE_DATA.channels).toEqual(['EMAIL']);
  });

  it('đủ 11 mã, mỗi mã có đúng một dòng đặc tả', () => {
    expect(ALERT_CODE).toHaveLength(11);
    expect(Object.keys(ALERT_SPEC).sort()).toEqual([...ALERT_CODE].sort());
  });
});

describe('biên ngưỡng', () => {
  it('đúng giá trị biên KHÔNG kích hoạt — dùng > chứ không phải >=', () => {
    expect(run({ rateLimitHits24h: THRESHOLDS.RATE_LIMIT_PER_DAY })).toEqual([]);
    expect(codes(run({ rateLimitHits24h: THRESHOLDS.RATE_LIMIT_PER_DAY + 1 }))).toEqual(['RATE_LIMIT_HIGH']);

    expect(run({ errorSinceHours: THRESHOLDS.EPIC_ERROR_HOURS })).toEqual([]);
    expect(codes(run({ errorSinceHours: 25 }))).toEqual(['EPIC_STUCK_ERROR']);

    expect(run({ unparsedSubtaskRatio: THRESHOLDS.UNPARSED_SUBTASK_RATIO })).toEqual([]);
    expect(codes(run({ unparsedSubtaskRatio: 0.31 }))).toEqual(['UNPARSED_SUBTASK']);
  });
});

describe('ngưỡng phụ thuộc thời điểm', () => {
  it('thiếu snapshot SAU 02:00 mới báo động', () => {
    expect(codes(run({ missingSnapshotDays: ['2026-03-12'] }, { localHour: 3 }))).toEqual([
      'SNAPSHOT_MISSING',
    ]);
  });

  it('thiếu snapshot lúc 01:00 thì CHƯA báo — job đêm còn đang chạy', () => {
    expect(run({ missingSnapshotDays: ['2026-03-12'] }, { localHour: 1 })).toEqual([]);
  });

  it('hàm không đọc đồng hồ: cùng đầu vào luôn cho cùng kết quả', () => {
    const args: EvaluateArgs = { localHour: 5, epics: [{ ...CLEAN, rateLimitHits24h: 20 }] };
    expect(evaluateThresholds(args)).toEqual(evaluateThresholds(args));
  });
});

describe('thiếu số liệu đầu vào', () => {
  it('KHÔNG phát cảnh báo và cũng KHÔNG coi là OK', () => {
    // Báo "mọi thứ bình thường" trong khi chưa đo được gì là kiểu nói dối tệ
    // nhất của một hệ thống giám sát (C-10).
    const alerts = evaluateThresholds({ localHour: 12, epics: [{ epicKey: 'PAY-1' }] });
    expect(alerts).toEqual([]);
  });

  it('chỉ số chưa đo được (undefined) khác hẳn chỉ số bằng 0', () => {
    const undefinedRatio = evaluateThresholds({ localHour: 12, epics: [{ epicKey: 'PAY-1' }] });
    const zeroRatio = run({ unclassifiedRatio: 0 });
    // Cả hai đều không phát cảnh báo, nhưng vì hai lý do khác nhau — phân biệt
    // được là việc của dashboard, không phải của hàm này.
    expect(undefinedRatio).toEqual([]);
    expect(zeroRatio).toEqual([]);
  });
});

describe('nội dung cảnh báo', () => {
  it('mỗi cảnh báo nói cả điều gì sai lẫn làm gì tiếp', () => {
    const all = [
      ...run({ lastJobFailed: true }),
      ...run({ missingSnapshotDays: ['2026-03-12'] }),
      ...run({ rateLimitHits24h: 11 }),
      ...run({ errorSinceHours: 30 }),
      ...run({ unclassifiedRatio: 0.25 }),
      ...run({ missingWbsRatio: 0.2 }),
    ];

    for (const a of all) {
      expect(a.message.length, a.code).toBeGreaterThan(50);
      // Câu nào cũng phải chứa một động từ hành động (message đã chuyển ngữ tiếng Anh).
      expect(/check|open|see|ask|click|watch/i.test(a.message), `${a.code}: ${a.message}`).toBe(true);
    }
  });

  it('trả kèm giá trị đo được và ngưỡng để người trực đối chiếu', () => {
    const [alert] = run({ rateLimitHits24h: 17 });
    expect(alert?.value).toBe(17);
    expect(alert?.threshold).toBe(10);
  });

  it('cảnh báo mức hệ thống không gắn vào Epic nào', () => {
    const [alert] = evaluateThresholds({ localHour: 12, epics: [], system: { apiP95Ms: 3000 } });
    expect(alert?.code).toBe('API_SLOW');
    expect(alert?.epicKey).toBeNull();
  });
});

describe('nhiều Epic', () => {
  it('mỗi Epic được đánh giá độc lập', () => {
    const alerts = evaluateThresholds({
      localHour: 3,
      epics: [
        { ...CLEAN, epicKey: 'PAY-1', lastJobFailed: true },
        { ...CLEAN, epicKey: 'PAY-2' },
        { ...CLEAN, epicKey: 'PAY-3', driftRatio: 0.01 },
      ],
    });

    expect(alerts.map((a) => `${a.epicKey}:${a.code}`)).toEqual([
      'PAY-1:JOB_FAILED',
      'PAY-3:DATA_DRIFT',
    ]);
  });
});
