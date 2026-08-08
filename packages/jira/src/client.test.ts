import { describe, it, expect, vi } from 'vitest';
import { BasicAuthProvider, MissingCredentialError, redactHeaders } from './credentials.js';
import { InMemoryTokenBucketStore, TokenBucketRateLimiter } from './rate-limiter.js';
import { withRetry, JiraHttpError, parseRetryAfter, backoffDelayMs } from './retry.js';
import { JiraClient } from './client.js';
import { searchIssues, getUpdatedWorklogIds } from './endpoints.js';

const CREDS = {
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'svc@example.com',
  JIRA_API_TOKEN: 'secret-token-123',
};

/** Client dùng credential giả và bộ đếm thời gian giả — không gọi mạng, không chờ thật. */
function makeClient(
  fetchImpl: typeof fetch,
  extra: { sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
) {
  return new JiraClient({
    credentials: new BasicAuthProvider(CREDS as unknown as NodeJS.ProcessEnv),
    fetchImpl,
    retry: {
      sleep: extra.sleep ?? (async () => {}),
      random: extra.random ?? (() => 0.5),
    },
  });
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('xác thực', () => {
  it('thiếu biến môi trường JIRA_API_TOKEN thì chặn khởi động và báo rõ tên biến', async () => {
    const p = new BasicAuthProvider({
      JIRA_BASE_URL: CREDS.JIRA_BASE_URL,
      JIRA_EMAIL: CREDS.JIRA_EMAIL,
    } as unknown as NodeJS.ProcessEnv);

    await expect(p.get()).rejects.toBeInstanceOf(MissingCredentialError);
    await expect(p.get()).rejects.toThrow(/JIRA_API_TOKEN/);
  });

  it('biến rỗng cũng bị coi là thiếu, không tạo header rác', async () => {
    const p = new BasicAuthProvider({ ...CREDS, JIRA_API_TOKEN: '   ' } as never);
    await expect(p.get()).rejects.toThrow(/JIRA_API_TOKEN/);
  });

  it('log không bao giờ chứa token', () => {
    const redacted = redactHeaders({
      Authorization: 'Basic c2VjcmV0LXRva2VuLTEyMw==',
      Accept: 'application/json',
    });
    expect(JSON.stringify(redacted)).not.toContain('c2VjcmV0');
    expect(redacted['Authorization']).toBe('***');
    expect(redacted['Accept']).toBe('application/json');
  });
});

describe('thử lại khi Jira lỗi', () => {
  it('gặp 429 có Retry-After thì chờ đúng số giây Jira yêu cầu, không dùng công thức lùi', async () => {
    const waits: number[] = [];
    let calls = 0;

    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '7' } });
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await client.request('/rest/api/3/status');

    expect(waits).toEqual([7000]); // KHÔNG phải 1000 của công thức lùi
  });

  it('gặp 429 không có Retry-After thì lùi theo 1s, 2s, 4s, 8s, 16s', () => {
    const noJitter = () => 0;
    expect([0, 1, 2, 3, 4].map((a) => backoffDelayMs(a, noJitter))).toEqual([
      1000, 2000, 4000, 8000, 16000,
    ]);
  });

  it('mỗi lần lùi đều cộng nhiễu ngẫu nhiên nên hai lần chạy khác nhau', () => {
    const a = backoffDelayMs(0, () => 0.1);
    const b = backoffDelayMs(0, () => 0.9);
    expect(a).not.toBe(b);
    expect(b - a).toBeGreaterThan(0);
  });

  it('gặp 404 thì KHÔNG thử lại — chỉ đúng một request được gửi', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('/rest/api/3/issue/NOPE-1')).rejects.toBeInstanceOf(JiraHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gặp 401 thì KHÔNG thử lại — token sai thì thử 5 lần vẫn sai', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('/rest/api/3/status')).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gặp 500 thì thử lại tối đa 5 lần rồi ném lỗi', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('/rest/api/3/status')).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(6); // 1 lần đầu + 5 lần thử lại
  });

  it('đếm đúng số lần bị 429 để ghi vào sync_run', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls <= 2) return new Response('', { status: 429 });
      return jsonResponse({ ok: true });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.request('/rest/api/3/status');

    expect(client.rateLimitHits).toBe(2);
    expect(client.apiCallsMade).toBe(3);
  });

  it('Retry-After dạng HTTP date được đọc đúng', () => {
    const now = Date.parse('2026-03-10T00:00:00Z');
    const ms = parseRetryAfter('Tue, 10 Mar 2026 00:00:30 GMT', now);
    expect(ms).toBe(30_000);
  });

  it('không thử lại lỗi không phải HTTP (ví dụ mất mạng)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      withRetry(fetchImpl as never, { sleep: async () => {} }),
    ).rejects.toThrow('ECONNRESET');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('giới hạn tốc độ', () => {
  it('token bucket chặn ở 40 request/giây', async () => {
    let now = 0;
    const store = new InMemoryTokenBucketStore(() => now);
    const limiter = new TokenBucketRateLimiter({
      store,
      ratePerSec: 40,
      burst: 40,
      sleep: async (ms) => {
        now += ms;
      },
    });

    for (let i = 0; i < 100; i++) await limiter.acquire();

    // 40 token đầu lấy ngay, 60 cái còn lại phải chờ ≈ 60/40 = 1.5 giây
    expect(now).toBeGreaterThanOrEqual(1400);
  });

  it('token bucket dùng CHUNG giữa hai client — giới hạn là toàn hệ thống', async () => {
    let now = 0;
    const store = new InMemoryTokenBucketStore(() => now);
    const mk = () =>
      new TokenBucketRateLimiter({
        store,
        ratePerSec: 10,
        burst: 10,
        sleep: async (ms) => {
          now += ms;
        },
      });

    const a = mk();
    const b = mk();
    for (let i = 0; i < 5; i++) await a.acquire();
    for (let i = 0; i < 5; i++) await b.acquire();

    // 10 token dùng hết bởi CẢ HAI client cộng lại
    await b.acquire();
    expect(now).toBeGreaterThan(0);
  });
});

describe('phân trang', () => {
  it('gộp đủ 250 issue từ 3 trang bằng nextPageToken', async () => {
    const mkIssues = (n: number, off: number) =>
      Array.from({ length: n }, (_, i) => ({ id: String(off + i), key: `X-${off + i}`, fields: {} }));

    const sentTokens: (string | undefined)[] = [];
    const paths: string[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      call++;
      paths.push(new URL(String(url)).pathname);
      const body = JSON.parse(String(init?.body ?? '{}')) as { nextPageToken?: string };
      sentTokens.push(body.nextPageToken);
      // Enhanced search phân trang bằng token, không phải startAt/total.
      if (call === 1) return jsonResponse({ issues: mkIssues(100, 0), nextPageToken: 'tok-1' });
      if (call === 2) return jsonResponse({ issues: mkIssues(100, 100), nextPageToken: 'tok-2' });
      return jsonResponse({ issues: mkIssues(50, 200), isLast: true });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const issues = await searchIssues(client, { jql: 'parent = X-1', fields: ['summary'] });

    expect(issues).toHaveLength(250);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Đúng endpoint mới, và token được truyền tiếp từ trang thứ hai.
    expect(paths).toEqual(['/rest/api/3/search/jql', '/rest/api/3/search/jql', '/rest/api/3/search/jql']);
    expect(sentTokens).toEqual([undefined, 'tok-1', 'tok-2']);
  });

  it('không lặp vô hạn khi Jira trả nextPageToken không tiến', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ issues: [{ id: '1', key: 'X-1', fields: {} }], nextPageToken: 'stuck' }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const issues = await searchIssues(client, { jql: 'parent = X-1', fields: ['summary'] });
    // Trang đầu gửi token=undefined, trang hai gửi 'stuck' rồi nhận lại 'stuck' → dừng.
    expect(issues).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('worklog/updated phân trang theo since, dừng khi lastPage', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      call++;
      const since = new URL(String(url)).searchParams.get('since');
      if (call === 1) {
        expect(since).toBe('1000');
        return jsonResponse({
          values: [{ worklogId: 1, updatedTime: 2000 }],
          lastPage: false,
        });
      }
      expect(since).toBe('2000'); // dùng mốc thời gian, KHÔNG dùng startAt
      return jsonResponse({ values: [{ worklogId: 2, updatedTime: 3000 }], lastPage: true });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const ids = await getUpdatedWorklogIds(client, 1000);

    expect(ids).toEqual([1, 2]);
  });

  it('worklog/updated không lặp vô hạn khi Jira trả mốc không tiến', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ values: [{ worklogId: 1, updatedTime: 1000 }], lastPage: false }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const ids = await getUpdatedWorklogIds(client, 1000);
    expect(ids).toEqual([1]);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // dừng lại, không quay vòng
  });
});

describe('bắt buộc truyền fields', () => {
  it('searchIssues gửi đúng danh sách fields lên Jira', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return jsonResponse({ issues: [], total: 0 });
    });

    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await searchIssues(client, {
      jql: 'parent = X-1',
      fields: ['summary', 'status', 'customfield_10100'],
    });

    expect(sentBody['fields']).toEqual(['summary', 'status', 'customfield_10100']);
  });
});
