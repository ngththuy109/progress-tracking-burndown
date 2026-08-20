import { CHART_CACHE_TTL_SECONDS } from '@app/shared';

/**
 * Cache biểu đồ theo kiểu cache-aside — PRD §4.7.
 *
 * NGUYÊN TẮC: cache là TỐI ƯU, không phải điều kiện để chạy. Redis chết thì API
 * vẫn trả dữ liệu từ database và chỉ ghi một dòng cảnh báo. Coi Redis chết là
 * lỗi 500 sẽ biến một tối ưu thành phụ thuộc cứng.
 */

/** Phần `ioredis` mà cache cần. Hẹp lại để test không phải dựng Redis thật. */
export interface CacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', n: number): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Khoá cache PHẢI chứa cả khoảng thời gian.
 *
 * Thiếu phần đó thì đổi bộ lọc ngày sẽ nhận lại dữ liệu của khoảng cũ — số liệu
 * vẫn trông hợp lý, chỉ là của khoảng khác. Lỗi im lặng đúng nghĩa.
 */
export function chartCacheKey(epicKey: string, from: string, to: string, suffix = ''): string {
  return `chart:${epicKey}:${from}:${to}${suffix === '' ? '' : `:${suffix}`}`;
}

/** Mẫu xoá mọi cache của một Epic. */
export function chartCachePattern(epicKey: string): string {
  return `chart:${epicKey}:*`;
}

/** Số key mỗi vòng `SCAN`. Nhỏ quá thì nhiều vòng, lớn quá thì Redis khựng. */
export const SCAN_COUNT = 200;

export interface ChartCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  /** Xoá mọi cache của một Epic. Trả về số key đã xoá. */
  invalidateEpic(epicKey: string): Promise<number>;
}

export interface ChartCacheDeps {
  readonly redis: CacheRedis;
  readonly ttlSeconds?: number;
  readonly onWarning?: (code: string, detail: string) => void;
}

export function createChartCache(deps: ChartCacheDeps): ChartCache {
  const ttl = deps.ttlSeconds ?? CHART_CACHE_TTL_SECONDS;
  const warn = deps.onWarning ?? (() => undefined);

  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        const raw = await deps.redis.get(key);
        return raw === null ? null : (JSON.parse(raw) as T);
      } catch (err) {
        // Redis chết HOẶC dữ liệu cache hỏng đều lùi về đọc database.
        warn('CACHE_READ_FAILED', `Could not read the chart cache (${key}): ${String(err)}`);
        return null;
      }
    },

    async set(key: string, value: unknown): Promise<void> {
      try {
        await deps.redis.set(key, JSON.stringify(value), 'EX', ttl);
      } catch (err) {
        warn('CACHE_WRITE_FAILED', `Could not write the chart cache (${key}): ${String(err)}`);
      }
    },

    async invalidateEpic(epicKey: string): Promise<number> {
      const pattern = chartCachePattern(epicKey);
      let cursor = '0';
      let removed = 0;

      try {
        do {
          // DÙNG `SCAN`, KHÔNG DÙNG `KEYS`. Với vài chục nghìn key, một lệnh
          // `KEYS` khoá cả Redis vài trăm mili-giây — khoá luôn cả token bucket
          // giới hạn tốc độ Jira, nên một lần xoá cache có thể làm job đêm
          // dính 429.
          const [next, keys] = await deps.redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
          cursor = next;
          if (keys.length > 0) removed += await deps.redis.del(...keys);
        } while (cursor !== '0');
      } catch (err) {
        warn('CACHE_INVALIDATE_FAILED', `Could not invalidate the cache for ${epicKey}: ${String(err)}`);
      }

      return removed;
    },
  };
}
