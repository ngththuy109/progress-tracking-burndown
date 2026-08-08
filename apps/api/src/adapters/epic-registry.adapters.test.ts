import { describe, it, expect } from 'vitest';
import { BasicAuthProvider, JiraClient, type ResolvedFieldMapping } from '@app/jira';
import { createJiraEpicPort } from './epic-registry.adapters.js';

/**
 * Bug "check keys → INTERNAL_ERROR".
 *
 * Jira Cloud trả HTTP 400 cho JQL `key IN (...)` NGAY KHI một key trong danh
 * sách không tồn tại / không đọc được ("An issue with key 'X' does not exist for
 * field 'issueKey'."). PM dán key sai là ca thường gặp nhất khi kiểm tra, nên
 * không chịu được lỗi này thì cả lượt kiểm 500 — đúng như bug đang gặp.
 *
 * Test dùng `JiraClient` thật với `fetchImpl` giả mô phỏng đúng hành vi đó, đi
 * qua CHÍNH adapter production `createJiraEpicPort` (fake port trong
 * epics.routes.test.ts không chạm tới đường này).
 */

const CREDS = {
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'svc@example.com',
  JIRA_API_TOKEN: 'secret-token',
} as unknown as NodeJS.ProcessEnv;

const FIELDS: ResolvedFieldMapping = {
  wbsStartDate: 'customfield_10015',
  wbsEndDate: 'customfield_10016',
  warnings: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Issue mà tài khoản dịch vụ ĐỌC ĐƯỢC (JQL trả về, GET issue → 200). */
const VISIBLE: Record<string, unknown> = {
  'PAY-100': {
    id: '10000',
    key: 'PAY-100',
    fields: { summary: 'Cổng thanh toán', issuetype: { name: 'Epic' }, project: { key: 'PAY' } },
  },
  'PAY-7': {
    id: '10007',
    key: 'PAY-7',
    fields: { summary: 'Một Task', issuetype: { name: 'Task' }, project: { key: 'PAY' } },
  },
};

/** Con trực tiếp cho các câu `parent IN (...)`. */
const CHILDREN: Record<string, unknown[]> = {
  'PAY-100': [
    { id: '10101', key: 'PAY-101', fields: { parent: { key: 'PAY-100' }, issuetype: { name: 'Task' } } },
  ],
  'PAY-101': [
    {
      id: '10131',
      key: 'PAY-131',
      fields: {
        parent: { key: 'PAY-101' },
        timeoriginalestimate: 3600,
        customfield_10015: '2026-01-01',
        customfield_10016: '2026-01-02',
      },
    },
  ],
};

/** Key tồn tại nhưng KHÔNG có quyền đọc — GET issue → 403. */
const NO_PERMISSION = new Set(['HR-1']);

function quotedKeys(jql: string): string[] {
  return [...jql.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

interface Counters {
  search: number;
  getIssue: number;
}

/**
 * `fetch` giả mô phỏng đúng hành vi Jira Cloud gây bug:
 *   - `key IN (...)` mà có bất kỳ key nào không đọc được → 400.
 *   - GET issue → 200 (đọc được) / 403 (thiếu quyền) / 404 (không có).
 */
function fakeFetch(c: Counters): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;

    if (method === 'POST' && path === '/rest/api/3/search/jql') {
      c.search++;
      const jql = (JSON.parse(String(init?.body ?? '{}')) as { jql: string }).jql;

      if (jql.startsWith('key IN')) {
        const keys = quotedKeys(jql);
        const bad = keys.find((k) => !(k in VISIBLE));
        if (bad !== undefined) {
          // Enhanced search VẪN trả 400 khi tham chiếu key không tồn tại.
          return json(
            { errorMessages: [`An issue with key '${bad}' does not exist for field 'issueKey'.`], errors: {} },
            400,
          );
        }
        const issues = keys.map((k) => VISIBLE[k]);
        return json({ issues, isLast: true });
      }

      if (jql.startsWith('parent IN')) {
        const issues = quotedKeys(jql).flatMap((p) => CHILDREN[p] ?? []);
        return json({ issues, isLast: true });
      }

      return json({ issues: [], isLast: true });
    }

    if (method === 'GET' && path.startsWith('/rest/api/3/issue/')) {
      c.getIssue++;
      const key = decodeURIComponent(path.slice('/rest/api/3/issue/'.length));
      if (NO_PERMISSION.has(key)) return json({ errorMessages: ['No permission'] }, 403);
      if (key in VISIBLE) return json(VISIBLE[key]);
      return json({ errorMessages: [`Issue does not exist for key '${key}'.`] }, 404);
    }

    throw new Error(`fetch giả gặp lời gọi ngoài dự kiến: ${method} ${path}`);
  }) as unknown as typeof fetch;
}

function makePort(c: Counters = { search: 0, getIssue: 0 }) {
  const client = new JiraClient({
    credentials: new BasicAuthProvider(CREDS),
    fetchImpl: fakeFetch(c),
    retry: { sleep: async () => {}, random: () => 0 },
  });
  return { port: createJiraEpicPort(client, FIELDS), counters: c };
}

describe('createJiraEpicPort.lookup — chịu được key không tồn tại', () => {
  it('một key sai KHÔNG làm sập cả lượt kiểm, mà trả NOT_FOUND từng dòng', async () => {
    const { port } = makePort();
    const out = await port.lookup(['abc-1000']);
    expect(out.get('abc-1000')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('key hợp lệ dán cạnh key sai vẫn được tra đúng metadata', async () => {
    const { port } = makePort();
    const out = await port.lookup(['PAY-100', 'abc-1000']);

    const pay = out.get('PAY-100');
    expect(pay?.ok).toBe(true);
    if (pay?.ok) {
      expect(pay.meta.issueType).toBe('EPIC');
      expect(pay.meta.displayName).toBe('Cổng thanh toán');
      expect(pay.meta.phaseCount).toBe(1);
      expect(pay.meta.subtaskCount).toBe(1);
    }
    expect(out.get('abc-1000')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('key tồn tại nhưng thiếu quyền → NO_PERMISSION, không phải 500', async () => {
    const { port } = makePort();
    const out = await port.lookup(['HR-1']);
    expect(out.get('HR-1')).toEqual({ ok: false, reason: 'NO_PERMISSION' });
  });

  it('mọi key hợp lệ thì vẫn đi đường JQL gộp, không tra lẻ từng key', async () => {
    const { port, counters } = makePort();
    const out = await port.lookup(['PAY-100']);
    expect(out.get('PAY-100')?.ok).toBe(true);
    // Đường nhanh còn nguyên: không rơi vào tra lẻ GET /issue.
    expect(counters.getIssue).toBe(0);
  });
});
