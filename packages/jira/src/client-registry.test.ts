import { describe, it, expect, vi } from 'vitest';
import {
  createJiraRegistry,
  JiraConnectionError,
  type JiraRegistryDeps,
  type ProjectJiraConnection,
} from './client-registry.js';
import { siteRateLimitKey, type RateLimiter } from './rate-limiter.js';
import {
  loadStatusIdMap,
  statusMapCacheKey,
  STATUS_MAP_CACHE_KEY,
  type StatusMapCache,
} from './status-map.js';
import type { JiraClient } from './client.js';

// ---------------------------------------------------------------------------
// Đồ giả dùng chung
// ---------------------------------------------------------------------------

/** Cache trong RAM — đủ cho test, không cần Redis. */
function makeCache(): StatusMapCache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
  };
}

/** Rate limiter cho qua tất — test song song không muốn bị giãn tốc độ. */
const passthroughLimiter = (): RateLimiter => ({ acquire: async () => {} });

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const FIELDS_CONFIG = {
  fieldMapping: { wbsStartDate: 'customfield_10100', wbsEndDate: 'customfield_10101' },
};

const JIRA_FIELDS = [
  { id: 'customfield_10100', name: 'WBS Start', custom: true, schema: { type: 'date' } },
  { id: 'customfield_10101', name: 'WBS End', custom: true, schema: { type: 'date' } },
];

const JIRA_STATUSES = [
  { id: '1', name: 'To Do', statusCategory: { key: 'new', name: 'To Do' } },
  { id: '3', name: 'Done', statusCategory: { key: 'done', name: 'Done' } },
];

/**
 * fetch giả trả lời `/field` và `/status`, đồng thời đếm request theo host và
 * đường dẫn để test soi được client gọi đi đâu.
 */
function makeFetch() {
  const calls: { host: string; path: string }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push({ host: url.host, path: url.pathname });
    if (url.pathname === '/rest/api/3/field') return jsonResponse(JIRA_FIELDS);
    if (url.pathname === '/rest/api/3/status') return jsonResponse(JIRA_STATUSES);
    return jsonResponse({ id: '1', key: 'X-1', fields: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeConnection(
  projectKey: string,
  overrides: Partial<ProjectJiraConnection> = {},
): ProjectJiraConnection {
  return {
    projectKey,
    baseUrl: 'https://one.atlassian.net',
    email: 'svc@example.com',
    apiTokenPlain: 'token-1',
    fieldsConfig: FIELDS_CONFIG,
    resolvedFields: null,
    ...overrides,
  };
}

function makeDeps(
  connections: Record<string, ProjectJiraConnection | null>,
  overrides: Partial<JiraRegistryDeps> = {},
): JiraRegistryDeps & { createRateLimiter: ReturnType<typeof vi.fn> } {
  // Không khai tham số vẫn nhận được đối số — mock ghi lại args để test soi host.
  const createRateLimiter = vi.fn(() => passthroughLimiter());
  return {
    loadConnection: async (key) => connections[key] ?? null,
    envFallback: null,
    statusCache: makeCache(),
    ...overrides,
    // Luôn là mock để test đếm được số lần tạo limiter theo host.
    createRateLimiter,
  };
}

// ---------------------------------------------------------------------------
// Chia sẻ tài nguyên theo SITE
// ---------------------------------------------------------------------------

describe('registry — chia tài nguyên theo site', () => {
  it('hai dự án cùng site dùng CHUNG một rate limiter — chỉ tạo một lần cho host', async () => {
    const { fetchImpl } = makeFetch();
    const deps = makeDeps(
      { AAA: makeConnection('AAA'), BBB: makeConnection('BBB', { apiTokenPlain: 'token-2' }) },
      { fetchImpl },
    );
    const registry = createJiraRegistry(deps);

    await registry.forProject('AAA');
    await registry.forProject('BBB');

    expect(deps.createRateLimiter).toHaveBeenCalledTimes(1);
    expect(deps.createRateLimiter).toHaveBeenCalledWith('one.atlassian.net');
  });

  it('hai site khác nhau thì mỗi site một rate limiter riêng', async () => {
    const { fetchImpl } = makeFetch();
    const deps = makeDeps(
      {
        AAA: makeConnection('AAA'),
        CCC: makeConnection('CCC', { baseUrl: 'https://two.atlassian.net' }),
      },
      { fetchImpl },
    );
    const registry = createJiraRegistry(deps);

    await registry.forProject('AAA');
    await registry.forProject('CCC');

    expect(deps.createRateLimiter).toHaveBeenCalledTimes(2);
    expect(deps.createRateLimiter).toHaveBeenNthCalledWith(1, 'one.atlassian.net');
    expect(deps.createRateLimiter).toHaveBeenNthCalledWith(2, 'two.atlassian.net');
  });

  it('trần song song là CỦA SITE: hai client cùng site không bao giờ vượt concurrencyPerSite', async () => {
    // Ánh xạ đã resolve sẵn để lúc dựng không tốn request /field nào.
    const resolved = { wbsStartDate: 'customfield_10100', wbsEndDate: 'customfield_10101' };

    let inFlight = 0;
    let maxInFlight = 0;
    const gates: Array<() => void> = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/rest/api/3/status') return jsonResponse(JIRA_STATUSES);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight--;
      return jsonResponse({ id: '1', key: 'X-1', fields: {} });
    }) as typeof fetch;

    const deps = makeDeps(
      {
        AAA: makeConnection('AAA', { resolvedFields: resolved }),
        BBB: makeConnection('BBB', { apiTokenPlain: 'token-2', resolvedFields: resolved }),
      },
      { fetchImpl, concurrencyPerSite: 2 },
    );
    const registry = createJiraRegistry(deps);

    const a = await registry.forProject('AAA');
    const b = await registry.forProject('BBB');
    expect(a.client).not.toBe(b.client); // client riêng, nhưng hạ tầng site chung

    // 6 request chia đều hai client. Nếu mỗi client tự giới hạn riêng thì sẽ có
    // 4 request bay cùng lúc (2 + 2) — chỉ trần CHUNG mới giữ được mức 2.
    const jobs = [
      ...[1, 2, 3].map((i) => a.client.request(`/rest/api/3/issue/A-${i}`)),
      ...[1, 2, 3].map((i) => b.client.request(`/rest/api/3/issue/B-${i}`)),
    ];

    await vi.waitFor(() => expect(gates.length).toBe(2));
    expect(inFlight).toBe(2);

    // Thả dần từng request — mỗi request xong mới có chỗ cho request kế tiếp.
    for (let released = 0; released < 6; released++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
      gates.shift()!();
    }
    await Promise.all(jobs);

    expect(maxInFlight).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cache theo dự án + fingerprint
// ---------------------------------------------------------------------------

describe('registry — cache và fingerprint', () => {
  it('kết nối không đổi thì trả đúng context đã cache, không dựng lại', async () => {
    const { fetchImpl, calls } = makeFetch();
    const deps = makeDeps({ AAA: makeConnection('AAA') }, { fetchImpl });
    const registry = createJiraRegistry(deps);

    const first = await registry.forProject('AAA');
    const fieldCallsAfterFirst = calls.filter((c) => c.path === '/rest/api/3/field').length;
    const second = await registry.forProject('AAA');

    expect(second).toBe(first);
    expect(second.client).toBe(first.client);
    // Không thêm request /field nào cho lần lấy thứ hai.
    expect(calls.filter((c) => c.path === '/rest/api/3/field')).toHaveLength(fieldCallsAfterFirst);
  });

  it('đổi token là đổi fingerprint → dựng lại client mới', async () => {
    const { fetchImpl } = makeFetch();
    let token = 'token-cũ';
    const deps = makeDeps({}, {
      fetchImpl,
      loadConnection: async (key) => makeConnection(key, { apiTokenPlain: token }),
    });
    const registry = createJiraRegistry(deps);

    const before = await registry.forProject('AAA');
    token = 'token-mới';
    const after = await registry.forProject('AAA');

    expect(after).not.toBe(before);
    expect(after.client).not.toBe(before.client);
  });

  it('invalidate() xoá cache — lần lấy sau dựng lại dù kết nối không đổi', async () => {
    const { fetchImpl } = makeFetch();
    const deps = makeDeps({ AAA: makeConnection('AAA') }, { fetchImpl });
    const registry = createJiraRegistry(deps);

    const before = await registry.forProject('AAA');
    registry.invalidate('AAA');
    const after = await registry.forProject('AAA');

    expect(after).not.toBe(before);
  });

  it('jiraResolvedJson hợp lệ thì dùng luôn, KHÔNG gọi /field', async () => {
    const { fetchImpl, calls } = makeFetch();
    const deps = makeDeps(
      {
        AAA: makeConnection('AAA', {
          resolvedFields: { wbsStartDate: 'customfield_10100', wbsEndDate: 'customfield_10101' },
        }),
      },
      { fetchImpl },
    );
    const registry = createJiraRegistry(deps);

    const ctx = await registry.forProject('AAA');

    expect(ctx.fields).toEqual({
      wbsStartDate: 'customfield_10100',
      wbsEndDate: 'customfield_10101',
    });
    expect(calls.filter((c) => c.path === '/rest/api/3/field')).toHaveLength(0);
  });

  it('jiraResolvedJson sai cấu trúc thì bỏ qua và resolve lại từ /field', async () => {
    const { fetchImpl, calls } = makeFetch();
    const deps = makeDeps(
      { AAA: makeConnection('AAA', { resolvedFields: { rác: true } }) },
      { fetchImpl },
    );
    const registry = createJiraRegistry(deps);

    const ctx = await registry.forProject('AAA');

    expect(ctx.fields.wbsStartDate).toBe('customfield_10100');
    expect(calls.filter((c) => c.path === '/rest/api/3/field')).toHaveLength(1);
  });

  it('status map cache theo khoá RIÊNG của dự án', async () => {
    const { fetchImpl } = makeFetch();
    const cache = makeCache();
    const deps = makeDeps({ AAA: makeConnection('AAA') }, { fetchImpl, statusCache: cache });
    const registry = createJiraRegistry(deps);

    const ctx = await registry.forProject('AAA');

    expect(ctx.statusIdMap.get('1')).toBe('new');
    expect(ctx.statusIdMap.get('3')).toBe('done');
    expect(cache.store.has('meta:statuscategory:AAA')).toBe(true);
    expect(cache.store.has('meta:statuscategory')).toBe(false); // không đụng khoá toàn cục
  });

  it('dựng thất bại thì KHÔNG găm lỗi vĩnh viễn — lần gọi sau thử lại', async () => {
    let fail = true;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (fail) return new Response('boom', { status: 400 }); // 400 không được retry
      const url = new URL(String(input));
      if (url.pathname === '/rest/api/3/field') return jsonResponse(JIRA_FIELDS);
      return jsonResponse(JIRA_STATUSES);
    }) as typeof fetch;
    const deps = makeDeps({ AAA: makeConnection('AAA') }, { fetchImpl });
    const registry = createJiraRegistry(deps);

    await expect(registry.forProject('AAA')).rejects.toThrow();
    fail = false;
    const ctx = await registry.forProject('AAA');
    expect(ctx.fields.wbsStartDate).toBe('customfield_10100');
  });
});

// ---------------------------------------------------------------------------
// Env fallback + lỗi cấu hình
// ---------------------------------------------------------------------------

describe('registry — env fallback và lỗi cấu hình', () => {
  it('không có bản ghi kết nối thì rơi về env — client gọi đúng site trong env', async () => {
    const { fetchImpl, calls } = makeFetch();
    const deps = makeDeps({}, {
      fetchImpl,
      envFallback: {
        baseUrl: 'https://legacy.atlassian.net',
        email: 'env@example.com',
        apiToken: 'env-token',
        fieldsConfig: FIELDS_CONFIG,
      },
    });
    const registry = createJiraRegistry(deps);

    const ctx = await registry.forProject('LEG');

    expect(ctx.connection.baseUrl).toBeNull(); // hàng vẫn là "chưa có kết nối riêng"
    expect(calls.every((c) => c.host === 'legacy.atlassian.net')).toBe(true);
    expect(deps.createRateLimiter).toHaveBeenCalledWith('legacy.atlassian.net');
  });

  it('kết nối toàn NULL cũng rơi về env như không có bản ghi', async () => {
    const { fetchImpl } = makeFetch();
    const deps = makeDeps(
      {
        LEG: makeConnection('LEG', {
          baseUrl: null,
          email: null,
          apiTokenPlain: null,
          fieldsConfig: null,
        }),
      },
      {
        fetchImpl,
        envFallback: {
          baseUrl: 'https://legacy.atlassian.net',
          email: 'env@example.com',
          apiToken: 'env-token',
          fieldsConfig: FIELDS_CONFIG,
        },
      },
    );
    const registry = createJiraRegistry(deps);

    const ctx = await registry.forProject('LEG');
    expect(ctx.fields.wbsEndDate).toBe('customfield_10101');
  });

  it('không có kết nối riêng VÀ không có env thì chặn với lỗi tiếng Việt rõ ràng', async () => {
    const deps = makeDeps({});
    const registry = createJiraRegistry(deps);

    await expect(registry.forProject('MO-COI')).rejects.toBeInstanceOf(JiraConnectionError);
    await expect(registry.forProject('MO-COI')).rejects.toThrow(/chưa cấu hình kết nối Jira/);
    await expect(registry.forProject('MO-COI')).rejects.toThrow(/MO-COI/);
  });

  it('kết nối cấu hình nửa vời (có baseUrl, thiếu token) bị chặn, KHÔNG trộn với env', async () => {
    const deps = makeDeps(
      { AAA: makeConnection('AAA', { apiTokenPlain: null }) },
      {
        envFallback: {
          baseUrl: 'https://legacy.atlassian.net',
          email: 'env@example.com',
          apiToken: 'env-token',
          fieldsConfig: FIELDS_CONFIG,
        },
      },
    );
    const registry = createJiraRegistry(deps);

    await expect(registry.forProject('AAA')).rejects.toThrow(/cấu hình THIẾU/);
  });

  it('thiếu field mapping (không có jiraFieldsJson lẫn env) thì chặn với lỗi rõ ràng', async () => {
    const { fetchImpl } = makeFetch();
    const deps = makeDeps({ AAA: makeConnection('AAA', { fieldsConfig: null }) }, { fetchImpl });
    const registry = createJiraRegistry(deps);

    await expect(registry.forProject('AAA')).rejects.toThrow(/field mapping/);
  });
});

// ---------------------------------------------------------------------------
// siteRateLimitKey
// ---------------------------------------------------------------------------

describe('siteRateLimitKey', () => {
  it('khoá theo host của site', () => {
    expect(siteRateLimitKey('https://acme.atlassian.net')).toBe(
      'ratelimit:jira:tokens:acme.atlassian.net',
    );
  });

  it('dấu gạch chéo cuối hay đường dẫn thừa không đổi khoá — cùng site là cùng bucket', () => {
    expect(siteRateLimitKey('https://acme.atlassian.net/')).toBe(
      siteRateLimitKey('https://acme.atlassian.net/jira'),
    );
  });
});

// ---------------------------------------------------------------------------
// loadStatusIdMap — tham số cacheKey
// ---------------------------------------------------------------------------

describe('loadStatusIdMap — khoá cache tuỳ chọn', () => {
  /** Client giả chỉ trả lời /status — đủ cho loadStatusIdMap. */
  const fakeClient = {
    request: async () => JIRA_STATUSES,
  } as unknown as JiraClient;

  it('mặc định vẫn dùng khoá toàn cục — caller cũ không đổi hành vi', async () => {
    const cache = makeCache();
    await loadStatusIdMap(fakeClient, cache);
    expect(cache.store.has(STATUS_MAP_CACHE_KEY)).toBe(true);
  });

  it('truyền cacheKey thì đọc/ghi đúng khoá đó', async () => {
    const cache = makeCache();
    const map = await loadStatusIdMap(fakeClient, cache, { cacheKey: statusMapCacheKey('AAA') });

    expect(map.get('1')).toBe('new');
    expect(cache.store.has('meta:statuscategory:AAA')).toBe(true);
    expect(cache.store.has(STATUS_MAP_CACHE_KEY)).toBe(false);

    // Lần hai đọc từ cache theo đúng khoá riêng, không gọi Jira nữa.
    const spy = vi.fn(async () => JIRA_STATUSES);
    const map2 = await loadStatusIdMap({ request: spy } as unknown as JiraClient, cache, {
      cacheKey: statusMapCacheKey('AAA'),
    });
    expect(map2.get('3')).toBe('done');
    expect(spy).not.toHaveBeenCalled();
  });

  it('statusMapCacheKey ghép đúng tiền tố toàn cục', () => {
    expect(statusMapCacheKey('PRJ')).toBe('meta:statuscategory:PRJ');
  });
});
