import { describe, it, expect } from 'vitest';
import {
  JiraClient,
  TokenBucketRateLimiter,
  InMemoryTokenBucketStore,
  type ResolvedFieldMapping,
} from '@app/jira';
import {
  fetchRootTree,
  toJqlTimestamp,
  PARENT_IN_CHUNK_SIZE,
} from './fetch-epic-tree.js';
import { FakeJira, type FakeIssue, type FakeJiraOptions } from '../test-fakes.js';

/**
 * Test cho vòng lặp frontier 1..N tầng (multi-tenant).
 *
 * Điểm sống còn nhất: với `depth = 2`, chuỗi JQL phát ra phải GIỐNG TỪNG BYTE
 * bản `fetchEpicTree` cũ (epic→task→subtask). Bộ so ở đây dùng một bản chép
 * nguyên văn cách bản cũ dựng JQL — đổi hành vi depth-2 là test đỏ ngay.
 */

const FIELDS: ResolvedFieldMapping = {
  wbsStartDate: 'customfield_10100',
  wbsEndDate: 'customfield_10101',
};

const SINCE = new Date('2026-03-08T09:55:00.000Z');

function makeClient(jira: FakeJira): JiraClient {
  return new JiraClient({
    credentials: {
      get: () => Promise.resolve({ baseUrl: 'https://x.atlassian.net', authHeader: 'Basic xxx' }),
    },
    rateLimiter: new TokenBucketRateLimiter({
      store: new InMemoryTokenBucketStore(() => Date.now()),
      ratePerSec: 100_000,
      burst: 100_000,
    }),
    fetchImpl: jira.fetchImpl,
    retry: { sleep: () => Promise.resolve() },
  });
}

function run(issues: FakeIssue[], args: { rootKey: string; depth: number; since: Date | null }, extra: Partial<FakeJiraOptions> = {}) {
  const jira = new FakeJira({ issues, ...extra });
  const client = makeClient(jira);
  return {
    jira,
    tree: fetchRootTree(client, { ...args, fields: FIELDS }),
  };
}

/** Cây depth 2 kinh điển: 1 Epic, 3 Task, 6 Sub-task. */
function depth2Tree(): FakeIssue[] {
  const issues: FakeIssue[] = [
    { id: '1000', key: 'PAY-100', type: 'EPIC', summary: 'Root' },
    { id: '1001', key: 'PAY-101', type: 'TASK', parent: 'PAY-100', summary: '[Phase] Design' },
    { id: '1002', key: 'PAY-102', type: 'TASK', parent: 'PAY-100', summary: '[Phase] Development' },
    { id: '1003', key: 'PAY-103', type: 'TASK', parent: 'PAY-100', summary: '[Phase] Test' },
  ];
  for (let i = 0; i < 6; i++) {
    issues.push({
      id: String(2000 + i),
      key: `PAY-${200 + i}`,
      type: 'SUBTASK',
      parent: ['PAY-101', 'PAY-102', 'PAY-103'][i % 3]!,
      summary: `Sub ${i}`,
    });
  }
  return issues;
}

/**
 * BẢN CHÉP NGUYÊN VĂN cách `fetchEpicTree` CŨ dựng JQL (trước multi-tenant) —
 * dùng làm "nhân chứng" cho phép so byte-for-byte, KHÔNG gọi mạng:
 *
 *   (1) `key = X OR parent = X`
 *   (2) `parent IN (taskKeys) [AND updated >= "…"]`   — chỉ khi có Task
 *   (3) `parent IN (taskKeys)`                        — chỉ khi tăng dần
 */
function legacyDepth2Jqls(epicKey: string, taskKeys: string[], since: Date | null): string[] {
  const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  const jqls = [`key = ${quote(epicKey)} OR parent = ${quote(epicKey)}`];
  if (taskKeys.length > 0) {
    jqls.push(
      `parent IN (${taskKeys.map(quote).join(',')})` +
        (since ? ` AND updated >= ${quote(toJqlTimestamp(since))}` : ''),
    );
    if (since !== null) jqls.push(`parent IN (${taskKeys.map(quote).join(',')})`);
  }
  return jqls;
}

describe('depth 2 — byte-identical với fetchEpicTree cũ', () => {
  const TASK_KEYS = ['PAY-101', 'PAY-102', 'PAY-103'];

  it('backfill (since = null): đúng 2 câu JQL, giống từng byte bản cũ', async () => {
    const { jira, tree } = run(depth2Tree(), { rootKey: 'PAY-100', depth: 2, since: null });
    const t = await tree;

    expect(jira.jqls).toEqual(legacyDepth2Jqls('PAY-100', TASK_KEYS, null));
    expect(jira.jqls).toEqual([
      'key = "PAY-100" OR parent = "PAY-100"',
      'parent IN ("PAY-101","PAY-102","PAY-103")',
    ]);
    expect(t.root?.key).toBe('PAY-100');
    expect(t.byTier[1]!.map((i) => i.key)).toEqual(TASK_KEYS);
    expect(t.byTier[2]).toHaveLength(6);
  });

  it('tăng dần: đúng 3 câu JQL (lọc updated ở lá + quét key), giống từng byte bản cũ', async () => {
    const { jira, tree } = run(depth2Tree(), { rootKey: 'PAY-100', depth: 2, since: SINCE });
    await tree;

    expect(jira.jqls).toEqual(legacyDepth2Jqls('PAY-100', TASK_KEYS, SINCE));
    expect(jira.jqls).toEqual([
      'key = "PAY-100" OR parent = "PAY-100"',
      'parent IN ("PAY-101","PAY-102","PAY-103") AND updated >= "2026-03-08 09:55"',
      'parent IN ("PAY-101","PAY-102","PAY-103")',
    ]);
  });

  it('không có Task nào: dừng ở 1 câu như bản cũ, không phát câu IN rỗng', async () => {
    const issues: FakeIssue[] = [{ id: '1000', key: 'PAY-100', type: 'EPIC', summary: 'Root' }];
    const { jira, tree } = run(issues, { rootKey: 'PAY-100', depth: 2, since: SINCE });
    const t = await tree;

    expect(jira.jqls).toEqual(legacyDepth2Jqls('PAY-100', [], SINCE));
    expect(t.byTier).toEqual([[t.root], [], []]);
  });

  it('liveKeys tăng dần: lá không đổi vẫn được coi là còn sống (quét key riêng)', async () => {
    const issues = depth2Tree();
    // Chỉ MỘT Sub-task đổi sau watermark.
    for (const i of issues) i.updated = '2026-01-01T00:00:00.000+0000';
    issues.find((i) => i.key === 'PAY-200')!.updated = '2026-03-09T00:00:00.000+0000';

    const t = await run(issues, { rootKey: 'PAY-100', depth: 2, since: SINCE }).tree;

    expect(t.byTier[2]!.map((i) => i.key)).toEqual(['PAY-200']); // chỉ tải lá vừa đổi
    for (const key of ['PAY-200', 'PAY-201', 'PAY-202', 'PAY-203', 'PAY-204', 'PAY-205']) {
      expect(t.liveKeys.has(key)).toBe(true); // nhưng KHÔNG lá nào bị coi là biến mất
    }
  });
});

describe('depth 1 — root + lá, không có tầng Task', () => {
  const FLAT: FakeIssue[] = [
    { id: '1000', key: 'PAY-100', type: 'EPIC', summary: 'Root phẳng' },
    { id: '2000', key: 'PAY-200', type: 'SUBTASK', parent: 'PAY-100', summary: 'Lá 1' },
    { id: '2001', key: 'PAY-201', type: 'SUBTASK', parent: 'PAY-100', summary: 'Lá 2' },
  ];

  it('backfill: root hỏi riêng, lá hỏi theo parent — 2 câu, không lọc updated', async () => {
    const { jira, tree } = run(FLAT, { rootKey: 'PAY-100', depth: 1, since: null });
    const t = await tree;

    expect(jira.jqls).toEqual(['key = "PAY-100"', 'parent IN ("PAY-100")']);
    expect(t.root?.key).toBe('PAY-100');
    expect(t.byTier[1]!.map((i) => i.key)).toEqual(['PAY-200', 'PAY-201']);
  });

  it('tăng dần: bộ lọc updated áp cho LÁ nhưng KHÔNG áp cho root', async () => {
    const issues = FLAT.map((i) => ({ ...i, updated: '2026-01-01T00:00:00.000+0000' }));
    issues[1]!.updated = '2026-03-09T00:00:00.000+0000';

    const { jira, tree } = run(issues, { rootKey: 'PAY-100', depth: 1, since: SINCE });
    const t = await tree;

    expect(jira.jqls).toEqual([
      // Root không đổi mà lọc `updated` ở câu này thì root biến mất — cấm.
      'key = "PAY-100"',
      'parent IN ("PAY-100") AND updated >= "2026-03-08 09:55"',
      'parent IN ("PAY-100")', // quét key để xoá mềm đúng
    ]);
    expect(t.root?.key).toBe('PAY-100'); // root cũ vẫn về đủ
    expect(t.byTier[1]!.map((i) => i.key)).toEqual(['PAY-200']);
    expect(t.liveKeys.has('PAY-201')).toBe(true);
  });
});

describe('depth 3 và 4 — tầng giữa', () => {
  function depth3Tree(): FakeIssue[] {
    return [
      { id: '1', key: 'PAY-1', type: 'EPIC', summary: 'Root' },
      { id: '2', key: 'PAY-2', type: 'MIDDLE', parent: 'PAY-1', summary: 'Giữa A' },
      { id: '3', key: 'PAY-3', type: 'MIDDLE', parent: 'PAY-1', summary: 'Giữa B' },
      { id: '4', key: 'PAY-4', type: 'TASK', parent: 'PAY-2', summary: '[Phase] Design' },
      { id: '5', key: 'PAY-5', type: 'TASK', parent: 'PAY-3', summary: '[Phase] Test' },
      { id: '6', key: 'PAY-6', type: 'SUBTASK', parent: 'PAY-4', summary: 'Lá 1' },
      { id: '7', key: 'PAY-7', type: 'SUBTASK', parent: 'PAY-5', summary: 'Lá 2' },
    ];
  }

  it('depth 3 tăng dần: tầng giữa KHÔNG bị lọc updated, chỉ lá bị', async () => {
    const issues = depth3Tree().map((i) => ({ ...i, updated: '2026-01-01T00:00:00.000+0000' }));
    const { jira, tree } = run(issues, { rootKey: 'PAY-1', depth: 3, since: SINCE });
    const t = await tree;

    expect(jira.jqls).toEqual([
      'key = "PAY-1" OR parent = "PAY-1"',
      'parent IN ("PAY-2","PAY-3")', // tầng giữa: CẤU TRÚC, không lọc
      'parent IN ("PAY-4","PAY-5") AND updated >= "2026-03-08 09:55"',
      'parent IN ("PAY-4","PAY-5")',
    ]);
    // Cấu trúc về đủ dù không gì đổi; lá bị lọc hết vì đều cũ hơn watermark.
    expect(t.byTier[1]!.map((i) => i.key)).toEqual(['PAY-2', 'PAY-3']);
    expect(t.byTier[2]!.map((i) => i.key)).toEqual(['PAY-4', 'PAY-5']);
    expect(t.byTier[3]).toEqual([]);
    // Nhưng liveKeys vẫn đủ cả cây nhờ lượt quét key.
    for (const k of ['PAY-1', 'PAY-2', 'PAY-3', 'PAY-4', 'PAY-5', 'PAY-6', 'PAY-7']) {
      expect(t.liveKeys.has(k)).toBe(true);
    }
  });

  it('depth 4 backfill: 4 câu, mỗi tầng một câu, đủ 5 tầng dữ liệu', async () => {
    const issues: FakeIssue[] = [
      { id: '1', key: 'PAY-1', type: 'EPIC', summary: 'Root' },
      { id: '2', key: 'PAY-2', type: 'MIDDLE', parent: 'PAY-1', summary: 'Giữa 1' },
      { id: '3', key: 'PAY-3', type: 'MIDDLE', parent: 'PAY-2', summary: 'Giữa 2' },
      { id: '4', key: 'PAY-4', type: 'TASK', parent: 'PAY-3', summary: '[Phase] Design' },
      { id: '5', key: 'PAY-5', type: 'SUBTASK', parent: 'PAY-4', summary: 'Lá' },
    ];
    const { jira, tree } = run(issues, { rootKey: 'PAY-1', depth: 4, since: null });
    const t = await tree;

    expect(jira.jqls).toEqual([
      'key = "PAY-1" OR parent = "PAY-1"',
      'parent IN ("PAY-2")',
      'parent IN ("PAY-3")',
      'parent IN ("PAY-4")',
    ]);
    expect(t.byTier.map((tier) => tier.map((i) => i.key))).toEqual([
      ['PAY-1'],
      ['PAY-2'],
      ['PAY-3'],
      ['PAY-4'],
      ['PAY-5'],
    ]);
  });
});

describe('tách lô IN theo PARENT_IN_CHUNK_SIZE', () => {
  it('frontier > 50 key: câu IN của tầng dưới bị tách lô, không câu nào quá 50 key', async () => {
    // 120 Task dưới root → tầng lá phải hỏi bằng 3 câu (50 + 50 + 20).
    const issues: FakeIssue[] = [{ id: '1000', key: 'PAY-100', type: 'EPIC', summary: 'Root' }];
    for (let i = 0; i < 120; i++) {
      issues.push({
        id: String(1100 + i),
        key: `PAY-T${i}`,
        type: 'TASK',
        parent: 'PAY-100',
        summary: `[Phase] P${i}`,
      });
      issues.push({
        id: String(3000 + i),
        key: `PAY-S${i}`,
        type: 'SUBTASK',
        parent: `PAY-T${i}`,
        summary: `Lá ${i}`,
      });
    }

    const { jira, tree } = run(issues, { rootKey: 'PAY-100', depth: 2, since: null });
    const t = await tree;

    const leafJqls = jira.jqls.slice(1);
    expect(leafJqls).toHaveLength(Math.ceil(120 / PARENT_IN_CHUNK_SIZE)); // 3 lô
    for (const jql of leafJqls) {
      const keyCount = [...jql.matchAll(/"PAY-T\d+"/g)].length;
      expect(keyCount).toBeGreaterThan(0);
      expect(keyCount).toBeLessThanOrEqual(PARENT_IN_CHUNK_SIZE);
    }
    // Không lá nào rơi rụng vì tách lô.
    expect(t.byTier[2]).toHaveLength(120);
    expect(t.liveKeys.size).toBe(1 + 120 + 120);
  });

  it('tăng dần với frontier > 50: lượt quét key cũng tách lô y hệt', async () => {
    const issues: FakeIssue[] = [{ id: '1000', key: 'PAY-100', type: 'EPIC', summary: 'Root' }];
    for (let i = 0; i < 60; i++) {
      issues.push({
        id: String(1100 + i),
        key: `PAY-T${i}`,
        type: 'TASK',
        parent: 'PAY-100',
        summary: `[Phase] P${i}`,
        updated: '2026-01-01T00:00:00.000+0000',
      });
    }

    const { jira, tree } = run(issues, { rootKey: 'PAY-100', depth: 2, since: SINCE });
    await tree;

    // 1 câu top + 2 lô lá có lọc + 2 lô quét key = 5.
    expect(jira.jqls).toHaveLength(5);
    expect(jira.jqls.filter((j) => j.includes('updated >='))).toHaveLength(2);
  });
});
