import type { JiraClient } from './client.js';
import { getStatuses } from './endpoints.js';

/**
 * Bảng tra `status_id` → nhóm trạng thái.
 *
 * Cần thiết vì changelog của Jira ghi status ID dạng số, không ghi statusCategory
 * (PRD §2.3). Không có bảng này thì không dựng lại được trạng thái quá khứ.
 *
 * Cache 24 giờ ở Redis key `meta:statuscategory` (PRD §4.7). Ở đây chỉ định
 * nghĩa interface cache để engine và worker không phụ thuộc ioredis.
 */
export type StatusCategoryKey = 'new' | 'indeterminate' | 'done';

export interface StatusMapCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export const STATUS_MAP_CACHE_KEY = 'meta:statuscategory';
export const STATUS_MAP_TTL_SECONDS = 24 * 60 * 60;

/**
 * Khoá cache theo DỰ ÁN: `meta:statuscategory:<projectKey>`.
 *
 * Đa tenant thì status ID dạng số ĐỤNG NHAU giữa các site Jira — dùng chung một
 * khoá toàn cục sẽ cho dự án này đọc nhầm bảng tra của site khác. Khoá mặc định
 * (không hậu tố) vẫn giữ nguyên cho đường legacy đơn site.
 */
export function statusMapCacheKey(projectKey: string): string {
  return `${STATUS_MAP_CACHE_KEY}:${projectKey}`;
}

export interface StatusMapLoadOptions {
  /** Khoá cache tuỳ chọn — mặc định là khoá toàn cục `meta:statuscategory`. */
  readonly cacheKey?: string;
}

const VALID: readonly string[] = ['new', 'indeterminate', 'done'];

/**
 * Nạp bảng tra, ưu tiên cache.
 *
 * Gọi một lần lúc khởi động rồi truyền xuống engine qua tham số — engine KHÔNG
 * được import package này (ARCHITECTURE.md §2).
 */
export async function loadStatusIdMap(
  client: JiraClient,
  cache?: StatusMapCache,
  opts: StatusMapLoadOptions = {},
): Promise<Map<string, StatusCategoryKey>> {
  const cacheKey = opts.cacheKey ?? STATUS_MAP_CACHE_KEY;
  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as Record<string, string>;
      return toMap(parsed);
    }
  }

  const statuses = await getStatuses(client);
  const plain: Record<string, string> = {};
  for (const s of statuses) {
    plain[s.id] = s.statusCategory.key;
  }

  if (cache) {
    await cache.set(cacheKey, JSON.stringify(plain), STATUS_MAP_TTL_SECONDS);
  }

  return toMap(plain);
}

function toMap(plain: Record<string, string>): Map<string, StatusCategoryKey> {
  const map = new Map<string, StatusCategoryKey>();
  for (const [id, key] of Object.entries(plain)) {
    if (!VALID.includes(key)) {
      // Jira chỉ có 3 nhóm. Giá trị lạ nghĩa là phản hồi API đã đổi cấu trúc —
      // bỏ qua bản ghi đó thay vì đưa dữ liệu rác vào engine.
      continue;
    }
    map.set(id, key as StatusCategoryKey);
  }
  return map;
}
