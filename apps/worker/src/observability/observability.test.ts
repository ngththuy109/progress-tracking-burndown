import { describe, expect, it, vi } from 'vitest';
import {
  ALERT_COOLDOWN_SECONDS,
  MetricsRegistry,
  METRIC,
  LabelExplosionError,
  MAX_LABEL_VALUES_PER_METRIC,
  recordSyncJob,
  type Alert,
} from '@app/shared';
import {
  createAlertDispatcher,
  dedupKey,
  type AlertChannel,
  type DedupRedis,
} from './alert-dispatcher.js';

const alert = (over: Partial<Alert> = {}): Alert => ({
  code: 'JOB_FAILED',
  level: 'P1',
  epicKey: 'PAY-1',
  message: 'Job hỏng.',
  value: 1,
  threshold: 0,
  ...over,
});

/** Redis giả cài đúng ngữ nghĩa `SET NX EX`, kèm đồng hồ ảo để tua khoảng lặng. */
class FakeDedupRedis implements DedupRedis {
  private readonly store = new Map<string, number>();
  nowMs = 0;

  // `mode` và `condition` cố định là 'EX'/'NX' nên không cần đọc, nhưng vẫn
  // phải khai đủ tham số để khớp chữ ký `DedupRedis`.
  async set(key: string, ..._rest: ['1' | string, 'EX', number, 'NX']): Promise<string | null> {
    const ttl = _rest[2];
    const expires = this.store.get(key);
    if (expires !== undefined && expires > this.nowMs) return null;
    this.store.set(key, this.nowMs + ttl * 1000);
    return 'OK';
  }
}

function channel(name: AlertChannel['name'], sink: Alert[], fail = false): AlertChannel {
  return {
    name,
    send: async (a) => {
      if (fail) throw new Error(`${name} chết`);
      sink.push(a);
    },
  };
}

describe('định tuyến cảnh báo', () => {
  it('P1 gửi cả Slack lẫn email', async () => {
    const slack: Alert[] = [];
    const email: Alert[] = [];
    const d = createAlertDispatcher({
      channels: [channel('SLACK', slack), channel('EMAIL', email)],
      redis: new FakeDedupRedis(),
    });

    await d.dispatch([alert({ code: 'JOB_FAILED', level: 'P1' })]);

    expect(slack).toHaveLength(1);
    expect(email).toHaveLength(1);
  });

  it('P3 chỉ gửi email cho PM, KHÔNG gọi Slack', async () => {
    // P3 không phải chuyện gọi người dậy lúc nửa đêm.
    const slack: Alert[] = [];
    const email: Alert[] = [];
    const d = createAlertDispatcher({
      channels: [channel('SLACK', slack), channel('EMAIL', email)],
      redis: new FakeDedupRedis(),
    });

    await d.dispatch([alert({ code: 'DIRTY_PHASE_DATA', level: 'P3' })]);

    expect(slack).toEqual([]);
    expect(email).toHaveLength(1);
  });
});

describe('chống gửi lặp', () => {
  it('cùng cảnh báo cho cùng Epic KHÔNG gửi lại trong khoảng lặng', async () => {
    const slack: Alert[] = [];
    const d = createAlertDispatcher({ channels: [channel('SLACK', slack)], redis: new FakeDedupRedis() });

    const first = await d.dispatch([alert()]);
    const second = await d.dispatch([alert()]);

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(slack).toHaveLength(1);
  });

  it('hết khoảng lặng thì được gửi lại', async () => {
    const slack: Alert[] = [];
    const redis = new FakeDedupRedis();
    const d = createAlertDispatcher({ channels: [channel('SLACK', slack)], redis });

    await d.dispatch([alert()]);
    redis.nowMs += (ALERT_COOLDOWN_SECONDS.P1 + 1) * 1000;
    await d.dispatch([alert()]);

    expect(slack).toHaveLength(2);
  });

  it('cảnh báo cho hai Epic khác nhau KHÔNG chặn nhau', async () => {
    // Thiếu phần Epic trong khoá thì một Epic đang lỗi sẽ che cảnh báo của 49
    // Epic còn lại.
    const slack: Alert[] = [];
    const d = createAlertDispatcher({ channels: [channel('SLACK', slack)], redis: new FakeDedupRedis() });

    await d.dispatch([alert({ epicKey: 'PAY-1' }), alert({ epicKey: 'PAY-2' })]);

    expect(slack.map((a) => a.epicKey)).toEqual(['PAY-1', 'PAY-2']);
  });

  it('hai mã cảnh báo khác nhau trên cùng Epic cũng không chặn nhau', async () => {
    const slack: Alert[] = [];
    const d = createAlertDispatcher({ channels: [channel('SLACK', slack)], redis: new FakeDedupRedis() });

    await d.dispatch([alert({ code: 'JOB_FAILED' }), alert({ code: 'RATE_LIMIT_HIGH', level: 'P2' })]);

    expect(slack).toHaveLength(2);
  });

  it('khoá chống lặp chứa cả mã lẫn Epic', () => {
    expect(dedupKey(alert())).toBe('alert:sent:JOB_FAILED:PAY-1');
    expect(dedupKey(alert({ epicKey: null }))).toBe('alert:sent:JOB_FAILED:SYSTEM');
  });

  it('mỗi mức có khoảng lặng riêng: P1 một giờ, P3 một ngày', () => {
    expect(ALERT_COOLDOWN_SECONDS.P1).toBe(3600);
    expect(ALERT_COOLDOWN_SECONDS.P3).toBe(86_400);
  });
});

describe('kênh gửi hỏng', () => {
  it('Slack chết KHÔNG làm sập job, email vẫn nhận được', async () => {
    // Mất một thông báo còn hơn mất cả lượt chốt sổ hằng đêm.
    const email: Alert[] = [];
    const d = createAlertDispatcher({
      channels: [channel('SLACK', [], true), channel('EMAIL', email)],
      redis: new FakeDedupRedis(),
    });

    const result = await d.dispatch([alert()]);

    expect(result.sent).toBe(1);
    expect(result.failedChannels).toEqual(['SLACK']);
    expect(email).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Số đo
// ---------------------------------------------------------------------------

describe('bộ số đo', () => {
  it('đếm tăng dần và đọc lại được', () => {
    const r = new MetricsRegistry();
    r.increment(METRIC.jiraRateLimitHits, 'Số lần bị Jira chặn');
    r.increment(METRIC.jiraRateLimitHits, 'Số lần bị Jira chặn', {}, 3);

    expect(r.read(METRIC.jiraRateLimitHits)).toBe(4);
  });

  it('gauge ghi đè chứ không cộng dồn', () => {
    const r = new MetricsRegistry();
    r.setGauge(METRIC.snapshotMissingDays, 'Số ngày thiếu snapshot', 3, { epic_key: 'PAY-1' });
    r.setGauge(METRIC.snapshotMissingDays, 'Số ngày thiếu snapshot', 1, { epic_key: 'PAY-1' });

    expect(r.read(METRIC.snapshotMissingDays, { epic_key: 'PAY-1' })).toBe(1);
  });

  it('histogram ghi cả tổng, số lần và các mốc', () => {
    const r = new MetricsRegistry();
    recordSyncJob(r, { runType: 'NIGHTLY', status: 'SUCCESS', durationSeconds: 12 });
    recordSyncJob(r, { runType: 'NIGHTLY', status: 'SUCCESS', durationSeconds: 45 });

    const text = r.render();
    expect(text).toContain(`${METRIC.syncJobDuration}_count{run_type="NIGHTLY",status="SUCCESS"} 2`);
    expect(text).toContain(`${METRIC.syncJobDuration}_sum{run_type="NIGHTLY",status="SUCCESS"} 57`);
    // Mốc 30 giây chỉ chứa lần chạy 12 giây; mốc 60 giây chứa cả hai.
    expect(text).toContain(`${METRIC.syncJobDuration}_bucket{le="30",run_type="NIGHTLY",status="SUCCESS"} 1`);
    expect(text).toContain(`${METRIC.syncJobDuration}_bucket{le="60",run_type="NIGHTLY",status="SUCCESS"} 2`);
  });

  it('job đồng bộ KHÔNG gắn nhãn epic_key', () => {
    // 50 Epic × 2 trạng thái × 3 loại job là 300 chuỗi số đo, và con số đó chỉ
    // có tăng khi thêm Epic.
    const r = new MetricsRegistry();
    recordSyncJob(r, { runType: 'NIGHTLY', status: 'FAILED', durationSeconds: 1 });

    expect(r.render()).not.toContain('epic_key');
  });

  it('quá nhiều tổ hợp nhãn thì NÉM LỖI thay vì âm thầm phình ra', () => {
    // Bùng nổ nhãn làm Prometheus nổ, thường vào đúng lúc hệ thống tải nặng.
    const r = new MetricsRegistry();
    const add = (i: number) => r.increment('test_total', 'thử', { id: String(i) });

    for (let i = 0; i < MAX_LABEL_VALUES_PER_METRIC; i++) add(i);

    expect(() => add(MAX_LABEL_VALUES_PER_METRIC)).toThrow(LabelExplosionError);
    expect(() => add(MAX_LABEL_VALUES_PER_METRIC)).toThrow(/MẪU đường dẫn/);
  });

  it('trúng cache và trượt cache đếm riêng, không gộp thành tỉ lệ', () => {
    // Ghi sẵn tỉ lệ thì mất khả năng cộng dồn giữa nhiều tiến trình.
    const r = new MetricsRegistry();
    r.increment(METRIC.chartCacheHits, 'trúng');
    r.increment(METRIC.chartCacheHits, 'trúng');
    r.increment(METRIC.chartCacheMisses, 'trượt');

    expect(r.read(METRIC.chartCacheHits)).toBe(2);
    expect(r.read(METRIC.chartCacheMisses)).toBe(1);
  });

  it('kết xuất đúng định dạng Prometheus: có HELP, TYPE và nhãn trong ngoặc nhọn', () => {
    const r = new MetricsRegistry();
    r.setGauge(METRIC.trackedEpicsByStatus, 'Số Epic theo trạng thái', 7, { status: 'ACTIVE' });

    const text = r.render();
    expect(text).toContain(`# HELP ${METRIC.trackedEpicsByStatus} Số Epic theo trạng thái`);
    expect(text).toContain(`# TYPE ${METRIC.trackedEpicsByStatus} gauge`);
    expect(text).toContain(`${METRIC.trackedEpicsByStatus}{status="ACTIVE"} 7`);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('giá trị nhãn có dấu nháy được thoát đúng', () => {
    const r = new MetricsRegistry();
    r.increment('x_total', 'thử', { note: 'a"b' });
    expect(r.render()).toContain('note="a\\"b"');
  });
});

describe('lần vết bằng correlationId', () => {
  it('log của job dùng lại đúng correlationId được truyền vào', () => {
    // Đứt ở giữa thì không nối được một sự cố thành một câu chuyện (C-9).
    const logs: Record<string, unknown>[] = [];
    const log = vi.fn((e: Record<string, unknown>) => logs.push(e));

    const correlationId = 'req-abc-123';
    log({ event: 'job.start', correlationId });
    log({ event: 'jira.call', correlationId });
    log({ event: 'job.done', correlationId });

    expect(logs.every((l) => l['correlationId'] === correlationId)).toBe(true);
  });
});
