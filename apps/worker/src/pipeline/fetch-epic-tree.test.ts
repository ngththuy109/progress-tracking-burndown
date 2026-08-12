import { describe, it, expect } from 'vitest';
import {
  JiraClient,
  TokenBucketRateLimiter,
  InMemoryTokenBucketStore,
  type ResolvedFieldMapping,
} from '@app/jira';
import type { TrackedScope } from '@app/shared';
import { fetchEpicTree } from './fetch-epic-tree.js';
import { FakeJira, type FakeIssue } from '../test-fakes.js';

/**
 * `fetchEpicTree` với hai kiểu scope (DYNAMIC-TIERS-DESIGN §6):
 *   CONTAINER (mặc định) — cây Epic→Task→Sub-task như cũ, KHÔNG đổi.
 *   QUERY — lá = ticket khớp JQL, đặt ở `subtasks`; epic=null, tasks=[].
 */

const FIELDS: ResolvedFieldMapping = {
  wbsStartDate: 'customfield_10100',
  wbsEndDate: 'customfield_10101',
};

function client(jira: FakeJira): JiraClient {
  return new JiraClient({
    credentials: {
      get: () => Promise.resolve({ baseUrl: 'https://x.atlassian.net', authHeader: 'Basic x' }),
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

describe('fetchEpicTree — scope CONTAINER (mặc định, không đổi)', () => {
  it('cây 3 tầng: Epic + Task + Sub-task', async () => {
    const issues: FakeIssue[] = [
      { id: '1', key: 'E-1', type: 'EPIC', summary: 'Epic' },
      { id: '2', key: 'T-1', type: 'TASK', parent: 'E-1', summary: '[Phase] Dev' },
      { id: '3', key: 'S-1', type: 'SUBTASK', parent: 'T-1', summary: 'sub', originalEstimate: 3600 },
    ];
    const tree = await fetchEpicTree(client(new FakeJira({ issues })), {
      epicKey: 'E-1',
      fields: FIELDS,
      since: null,
    });
    expect(tree.epic?.key).toBe('E-1');
    expect(tree.tasks.map((t) => t.key)).toEqual(['T-1']);
    expect(tree.subtasks.map((s) => s.key)).toEqual(['S-1']);
  });
});

describe('fetchEpicTree — scope QUERY (project phẳng §2.5)', () => {
  const scope: TrackedScope = { scopeType: 'QUERY', scopeJql: 'parent = "FLAT-ROOT"', leafIssueTypes: [] };

  it('lá = ticket khớp JQL, đặt ở subtasks; epic=null, tasks=[]', async () => {
    const issues: FakeIssue[] = [
      { id: '10', key: 'F-1', type: 'TASK', parent: 'FLAT-ROOT', summary: '[PAY][x][Design][y]_Create', originalEstimate: 3600 },
      { id: '11', key: 'F-2', type: 'TASK', parent: 'FLAT-ROOT', summary: '[PAY][x][Dev][y]_Create', originalEstimate: 3600 },
      { id: '12', key: 'OTHER', type: 'TASK', parent: 'ELSEWHERE', summary: 'ngoài scope' },
    ];
    const tree = await fetchEpicTree(client(new FakeJira({ issues })), {
      epicKey: 'FLAT-SCOPE',
      fields: FIELDS,
      since: null,
      scope,
    });

    expect(tree.epic).toBeNull();
    expect(tree.tasks).toEqual([]);
    expect(tree.subtasks.map((s) => s.key).sort()).toEqual(['F-1', 'F-2']);
    expect([...tree.liveKeys].sort()).toEqual(['F-1', 'F-2']);
  });

  it('JQL rỗng ⇒ scope trống, KHÔNG quét cả Jira', async () => {
    const tree = await fetchEpicTree(client(new FakeJira({ issues: [] })), {
      epicKey: 'X',
      fields: FIELDS,
      since: null,
      scope: { scopeType: 'QUERY', scopeJql: '', leafIssueTypes: [] },
    });
    expect(tree.subtasks).toEqual([]);
    expect(tree.liveKeys.size).toBe(0);
  });
});
