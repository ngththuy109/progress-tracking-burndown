/**
 * Số đo dạng Prometheus — PRD §9.5.
 *
 * Đặt ở `packages/shared` vì CẢ API LẪN WORKER đều phát số đo, và tên số đo phải
 * khớp nhau tuyệt đối. Hai bên tự khai riêng thì sẽ có ngày `http_request_duration`
 * và `http_request_duration_seconds` cùng tồn tại, và biểu đồ giám sát thiếu một nửa.
 *
 * Cài đặt tối giản ngay trong dự án thay vì kéo thêm `prom-client`: định dạng
 * text của Prometheus rất đơn giản, còn thứ ta THẬT SỰ cần kiểm là **luật đặt
 * nhãn** — và luật đó thì thư viện nào cũng không kiểm hộ được.
 *
 * Đánh đổi: không có histogram theo phân vị dựng sẵn, phải tự khai mốc. Cần
 * thêm tính năng thì thay bằng `prom-client`; hình dạng API ở đây đã bám sát nó.
 */

export type MetricKind = 'counter' | 'gauge' | 'histogram';
export type Labels = Readonly<Record<string, string>>;

/**
 * Nhãn có SỐ GIÁ TRỊ HỮU HẠN thì mới được làm nhãn.
 *
 * Đây là luật quan trọng nhất của cả file. Đưa `epicKey` hay đường dẫn thật vào
 * nhãn sẽ sinh một chuỗi số đo riêng cho mỗi giá trị, và Prometheus nổ vì bùng
 * nổ nhãn — thường là vào đúng lúc hệ thống đang tải nặng.
 */
export const MAX_LABEL_VALUES_PER_METRIC = 200;

export class LabelExplosionError extends Error {
  constructor(name: string, count: number) {
    super(
      `Số đo "${name}" đã có ${count} tổ hợp nhãn, vượt ngưỡng ${MAX_LABEL_VALUES_PER_METRIC}. ` +
        'Gần như chắc chắn có nhãn mang giá trị tự do (mã Epic, đường dẫn thật, id). ' +
        'Đổi sang nhãn có số giá trị hữu hạn, ví dụ dùng MẪU đường dẫn thay cho đường dẫn thật.',
    );
    this.name = 'LabelExplosionError';
  }
}

interface Series {
  readonly labels: Labels;
  value: number;
  /** Chỉ histogram dùng: số lần quan sát và tổng. */
  count?: number;
  sum?: number;
  buckets?: Map<number, number>;
}

/** Mốc thời lượng, tính bằng giây. Đủ để đọc p95 của cả API lẫn job đêm. */
export const DEFAULT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 0.8, 1, 2, 5, 10, 30, 60, 300, 1800] as const;

export class MetricsRegistry {
  private readonly metrics = new Map<
    string,
    { kind: MetricKind; help: string; series: Map<string, Series> }
  >();

  private ensure(name: string, kind: MetricKind, help: string) {
    let m = this.metrics.get(name);
    if (m === undefined) {
      m = { kind, help, series: new Map() };
      this.metrics.set(name, m);
    }
    return m;
  }

  private seriesOf(name: string, kind: MetricKind, help: string, labels: Labels): Series {
    const m = this.ensure(name, kind, help);
    const key = serialize(labels);
    let s = m.series.get(key);
    if (s === undefined) {
      if (m.series.size >= MAX_LABEL_VALUES_PER_METRIC) {
        throw new LabelExplosionError(name, m.series.size);
      }
      s = { labels, value: 0 };
      if (kind === 'histogram') {
        s.count = 0;
        s.sum = 0;
        s.buckets = new Map(DEFAULT_BUCKETS.map((b) => [b, 0]));
      }
      m.series.set(key, s);
    }
    return s;
  }

  increment(name: string, help: string, labels: Labels = {}, by = 1): void {
    this.seriesOf(name, 'counter', help, labels).value += by;
  }

  setGauge(name: string, help: string, value: number, labels: Labels = {}): void {
    this.seriesOf(name, 'gauge', help, labels).value = value;
  }

  observe(name: string, help: string, seconds: number, labels: Labels = {}): void {
    const s = this.seriesOf(name, 'histogram', help, labels);
    s.count = (s.count ?? 0) + 1;
    s.sum = (s.sum ?? 0) + seconds;
    for (const bound of DEFAULT_BUCKETS) {
      if (seconds <= bound) s.buckets?.set(bound, (s.buckets.get(bound) ?? 0) + 1);
    }
  }

  /** Định dạng text của Prometheus. */
  render(): string {
    const lines: string[] = [];

    for (const [name, m] of this.metrics) {
      lines.push(`# HELP ${name} ${m.help}`);
      lines.push(`# TYPE ${name} ${m.kind}`);

      for (const s of m.series.values()) {
        if (m.kind === 'histogram') {
          for (const [bound, count] of s.buckets ?? []) {
            lines.push(`${name}_bucket${render({ ...s.labels, le: String(bound) })} ${count}`);
          }
          lines.push(`${name}_bucket${render({ ...s.labels, le: '+Inf' })} ${s.count ?? 0}`);
          lines.push(`${name}_sum${render(s.labels)} ${s.sum ?? 0}`);
          lines.push(`${name}_count${render(s.labels)} ${s.count ?? 0}`);
        } else {
          lines.push(`${name}${render(s.labels)} ${s.value}`);
        }
      }
    }

    return `${lines.join('\n')}\n`;
  }

  /** Chỉ dùng trong test. */
  read(name: string, labels: Labels = {}): number | null {
    return this.metrics.get(name)?.series.get(serialize(labels))?.value ?? null;
  }

  reset(): void {
    this.metrics.clear();
  }
}

function serialize(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ''}`)
    .join(',');
}

function render(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const body = keys.map((k) => `${k}="${escape(labels[k] ?? '')}"`).join(',');
  return `{${body}}`;
}

function escape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ---------------------------------------------------------------------------
// Tên số đo — khai một chỗ để API và worker không đặt lệch nhau
// ---------------------------------------------------------------------------

export const METRIC = {
  syncJobDuration: 'sync_job_duration_seconds',
  jiraRateLimitHits: 'jira_rate_limit_hits_total',
  jiraApiCalls: 'jira_api_calls_total',
  snapshotMissingDays: 'snapshot_missing_days',
  trackedEpicsByStatus: 'tracked_epics_by_status',
  httpRequestDuration: 'http_request_duration_seconds',
  chartCacheHits: 'chart_cache_hits_total',
  chartCacheMisses: 'chart_cache_misses_total',
} as const;

/** Số đo của job đồng bộ. Nhãn `run_type` và `status` đều có tập giá trị hữu hạn. */
export function recordSyncJob(
  registry: MetricsRegistry,
  args: { runType: string; status: 'SUCCESS' | 'FAILED'; durationSeconds: number },
): void {
  // CỐ Ý không gắn nhãn `epic_key`: 50 Epic × 2 trạng thái × 3 loại job là 300
  // chuỗi số đo, và con số đó chỉ có tăng khi thêm Epic.
  registry.observe(METRIC.syncJobDuration, 'Thời lượng job đồng bộ, tính bằng giây', args.durationSeconds, {
    run_type: args.runType,
    status: args.status,
  });
}
