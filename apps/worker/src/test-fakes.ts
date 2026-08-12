import type { TrackedEpicStatus } from '@app/shared';
import type {
  ChangelogWritePort,
  DirtyEpicQueuePort,
  EpicStatePort,
  IssueWritePort,
  SyncRunPort,
  WorklogWritePort,
} from './jobs/sync-epic.job.js';
import type {
  ChangelogRecord,
  IssueRecord,
  WorklogRecord,
} from './pipeline/persist-issues.js';

/**
 * Jira giả ở tầng `fetch`, KHÔNG phải ở tầng client.
 *
 * Quan trọng: giả ở đây thì `JiraClient` thật vẫn chạy — giới hạn tốc độ, chặn
 * song song 8, thử lại, và hai bộ đếm `apiCallsMade` / `rateLimitHits` đều là
 * đồ thật. Giả ở tầng client sẽ bỏ qua đúng những thứ mà test 2 và test 15 cần
 * kiểm chứng.
 */

export interface FakeIssue {
  id: string;
  key: string;
  type: 'EPIC' | 'TASK' | 'SUBTASK';
  parent?: string;
  summary: string;
  statusId?: string;
  statusCategory?: 'new' | 'indeterminate' | 'done';
  originalEstimate?: number;
  remainingEstimate?: number;
  timeSpent?: number;
  created?: string;
  updated?: string;
  wbsStart?: string | null;
  wbsEnd?: string | null;
}

export interface FakeWorklog {
  id: string;
  issueId: string;
  issueKey: string;
  seconds: number;
  started: string;
  created: string;
  updated?: string;
}

export interface FakeChangelog {
  issueKey: string;
  historyId: string;
  created: string;
  items: { field: string; from?: string | null; to?: string | null }[];
}

export interface FakeJiraOptions {
  issues: FakeIssue[];
  worklogs?: FakeWorklog[];
  changelog?: FakeChangelog[];
  deletedWorklogIds?: number[];
  wbsStartField?: string;
  wbsEndField?: string;
  /** Số lần đầu tiên trả 429 để kiểm chứng bộ đếm `rateLimitHits`. */
  rateLimitFirstNCalls?: number;
  /** Mọi lời gọi đều hỏng — dùng cho ca "Jira lỗi liên tục". */
  failEverything?: boolean;
}

export class FakeJira {
  /** Mọi JQL đã nhận, theo thứ tự. Dùng để khẳng định "đúng 2 lần search". */
  readonly jqls: string[] = [];
  readonly paths: string[] = [];

  /** Số request đồng thời cao nhất từng đạt tới. */
  maxConcurrent = 0;
  private inFlight = 0;
  private rateLimitBudget: number;

  constructor(private readonly opts: FakeJiraOptions) {
    this.rateLimitBudget = opts.rateLimitFirstNCalls ?? 0;
  }

  get searchCount(): number {
    return this.jqls.length;
  }

  /** Cắm vào `JiraClientOptions.fetchImpl`. */
  readonly fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      // Nhường một nhịp event loop để nhiều request thật sự chồng lấn nhau —
      // không có chỗ này thì `maxConcurrent` luôn bằng 1 và test song song
      // trở thành vô nghĩa.
      await new Promise((r) => setImmediate(r));
      return this.handle(String(url), init);
    } finally {
      this.inFlight -= 1;
    }
  };

  private handle(url: string, init?: RequestInit): Response {
    const u = new URL(url);
    this.paths.push(u.pathname);

    if (this.opts.failEverything) return json({ message: 'Jira sập' }, 500);

    if (this.rateLimitBudget > 0) {
      this.rateLimitBudget -= 1;
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
    }

    if (u.pathname === '/rest/api/3/search/jql') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { jql: string };
      this.jqls.push(body.jql);
      const issues = this.resolveJql(body.jql).map((i) => this.toJiraIssue(i));
      // Enhanced search: một trang, không còn nextPageToken → searchIssues dừng.
      return json({ issues, isLast: true });
    }

    const worklogMatch = /^\/rest\/api\/3\/issue\/([^/]+)\/worklog$/.exec(u.pathname);
    if (worklogMatch) {
      const key = decodeURIComponent(worklogMatch[1]!);
      const worklogs = (this.opts.worklogs ?? [])
        .filter((w) => w.issueKey === key)
        .map((w) => this.toJiraWorklog(w));
      return json({ worklogs, startAt: 0, maxResults: 100, total: worklogs.length });
    }

    const changelogMatch = /^\/rest\/api\/3\/issue\/([^/]+)\/changelog$/.exec(u.pathname);
    if (changelogMatch) {
      const key = decodeURIComponent(changelogMatch[1]!);
      const values = (this.opts.changelog ?? [])
        .filter((c) => c.issueKey === key)
        .map((c) => ({
          id: c.historyId,
          created: c.created,
          items: c.items.map((i) => ({ field: i.field, from: i.from ?? null, to: i.to ?? null })),
        }));
      return json({ values, startAt: 0, maxResults: 100, total: values.length, isLast: true });
    }

    if (u.pathname === '/rest/api/3/worklog/updated') {
      return json({
        values: (this.opts.worklogs ?? []).map((w) => ({
          worklogId: Number(w.id),
          updatedTime: Date.parse(w.updated ?? w.created),
        })),
        lastPage: true,
      });
    }

    if (u.pathname === '/rest/api/3/worklog/deleted') {
      return json({
        values: (this.opts.deletedWorklogIds ?? []).map((id) => ({ worklogId: id, updatedTime: 0 })),
        lastPage: true,
      });
    }

    if (u.pathname === '/rest/api/3/worklog/list') {
      const ids = new Set((JSON.parse(String(init?.body ?? '{}')) as { ids: number[] }).ids);
      return json(
        (this.opts.worklogs ?? [])
          .filter((w) => ids.has(Number(w.id)))
          .map((w) => this.toJiraWorklog(w)),
      );
    }

    return json({ message: `Đường dẫn chưa hỗ trợ: ${u.pathname}` }, 404);
  }

  /** Bộ suy diễn JQL đủ dùng: `key = X`, `parent = X`, `parent IN (...)`, `updated >= "..."`. */
  private resolveJql(jql: string): FakeIssue[] {
    const keyEq = [...jql.matchAll(/key = "([^"]+)"/g)].map((m) => m[1]!);
    const parentEq = [...jql.matchAll(/parent = "([^"]+)"/g)].map((m) => m[1]!);
    const parentIn = /parent IN \(([^)]*)\)/.exec(jql);
    const parents = new Set([
      ...parentEq,
      ...(parentIn ? [...parentIn[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : []),
    ]);
    const keys = new Set(keyEq);

    const updatedSince = /updated >= "([^"]+)"/.exec(jql);
    const sinceMs = updatedSince ? Date.parse(`${updatedSince[1]!.replace(' ', 'T')}:00Z`) : null;

    return this.opts.issues.filter((i) => {
      if (!keys.has(i.key) && !(i.parent !== undefined && parents.has(i.parent))) return false;
      if (sinceMs !== null && Date.parse(i.updated ?? '2020-01-01T00:00:00.000Z') < sinceMs) {
        return false;
      }
      return true;
    });
  }

  private toJiraIssue(i: FakeIssue): Record<string, unknown> {
    return {
      id: i.id,
      key: i.key,
      fields: {
        summary: i.summary,
        issuetype: { name: i.type },
        ...(i.parent !== undefined ? { parent: { key: i.parent } } : {}),
        status: {
          id: i.statusId ?? '1',
          statusCategory: { key: i.statusCategory ?? 'new' },
        },
        timeoriginalestimate: i.originalEstimate ?? null,
        timeestimate: i.remainingEstimate ?? null,
        timespent: i.timeSpent ?? null,
        created: i.created ?? '2026-03-01T00:00:00.000+0000',
        updated: i.updated ?? '2026-03-01T00:00:00.000+0000',
        [this.opts.wbsStartField ?? 'customfield_10100']: i.wbsStart ?? null,
        [this.opts.wbsEndField ?? 'customfield_10101']: i.wbsEnd ?? null,
      },
    };
  }

  private toJiraWorklog(w: FakeWorklog): Record<string, unknown> {
    return {
      id: w.id,
      issueId: w.issueId,
      author: { accountId: 'acc-1' },
      timeSpentSeconds: w.seconds,
      started: w.started,
      created: w.created,
      updated: w.updated ?? w.created,
    };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Kho dữ liệu trong bộ nhớ
// ---------------------------------------------------------------------------

/**
 * Bắt chước đúng ngữ nghĩa UPSERT của bảng thật.
 *
 * Nhờ vậy test "chạy hai lần cho kết quả byte-for-byte giống nhau" mới có ý
 * nghĩa: nếu kho này chỉ push vào mảng thì chạy hai lần luôn ra dữ liệu gấp
 * đôi, và test sẽ bắt được lỗi không có thật.
 */
export class FakeStore implements SyncRunPort, EpicStatePort, DirtyEpicQueuePort {
  // Ba cổng ghi (issue / worklog / changelog) cùng có phương thức tên
  // `upsertMany` nên không khai `implements` cả ba trên một lớp được. `portsOf`
  // ở cuối file nối chúng lại — và vẫn được kiểu kiểm tra đầy đủ nhờ `satisfies`.
  readonly issues = new Map<string, IssueRecord & { removedAt: Date | null }>();
  readonly worklogRows = new Map<string, WorklogRecord>();
  readonly changelogRows = new Map<string, ChangelogRecord>();
  readonly runs: Array<{
    id: number;
    epicKey: string;
    runType: string;
    status: string;
    apiCalls?: number;
    rateLimitHits?: number;
    issuesRead?: number;
    worklogsRead?: number;
    errorMessage?: string | null;
    errorStep?: string | null;
    errorDetail?: string | null;
  }> = [];
  readonly dirty = new Set<string>();
  readonly epicState = new Map<string, { status: TrackedEpicStatus; lastSyncedAt: Date | null; lastError: string | null }>();

  private nextRunId = 1;

  // --- issues ---
  upsertMany(rows: readonly IssueRecord[]): Promise<void> {
    for (const r of rows) {
      // Issue xuất hiện lại phải được bỏ cờ đã-gỡ, nếu không nó bị coi là biến
      // mất vĩnh viễn.
      this.issues.set(r.issueKey, { ...r, removedAt: null });
    }
    return Promise.resolve();
  }

  markRemoved(epicKey: string, liveKeys: ReadonlySet<string>, at: Date): Promise<number> {
    let n = 0;
    for (const [key, row] of this.issues) {
      if (row.epicKey !== epicKey || row.removedAt !== null || liveKeys.has(key)) continue;
      row.removedAt = at;
      n += 1;
    }
    return Promise.resolve(n);
  }

  knownIdToKey(epicKey: string): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    for (const r of this.issues.values()) {
      if (r.epicKey === epicKey) out.set(String(r.issueId), r.issueKey);
    }
    return Promise.resolve(out);
  }

  // --- worklog ---
  upsertManyWorklogs(rows: readonly WorklogRecord[]): Promise<void> {
    for (const r of rows) this.worklogRows.set(String(r.worklogId), r);
    return Promise.resolve();
  }

  markDeleted(worklogIds: readonly bigint[]): Promise<number> {
    let n = 0;
    for (const id of worklogIds) {
      const row = this.worklogRows.get(String(id));
      if (row && !row.isDeleted) {
        // Đặt cờ, KHÔNG xoá dòng (E-17)
        this.worklogRows.set(String(id), { ...row, isDeleted: true });
        n += 1;
      }
    }
    return Promise.resolve(n);
  }

  markDeletedMissing(epicKey: string, liveWorklogIds: ReadonlySet<bigint>): Promise<number> {
    let n = 0;
    for (const [key, row] of this.worklogRows) {
      // Đặt cờ cho worklog của Epic không còn trong tập sống — KHÔNG xoá dòng (E-17).
      if (row.epicKey !== epicKey || row.isDeleted || liveWorklogIds.has(row.worklogId)) continue;
      this.worklogRows.set(key, { ...row, isDeleted: true });
      n += 1;
    }
    return Promise.resolve(n);
  }

  // --- changelog ---
  upsertManyChangelog(rows: readonly ChangelogRecord[]): Promise<void> {
    for (const r of rows) {
      this.changelogRows.set(`${r.issueKey}|${r.jiraHistoryId}|${r.fieldName}`, r);
    }
    return Promise.resolve();
  }

  // --- sync_run ---
  start(args: { epicKey: string; runType: string }): Promise<number> {
    const id = this.nextRunId++;
    this.runs.push({ id, epicKey: args.epicKey, runType: args.runType, status: 'RUNNING' });
    return Promise.resolve(id);
  }

  finish(args: {
    id: number;
    status: 'SUCCESS' | 'FAILED';
    apiCalls: number;
    rateLimitHits: number;
    issuesRead: number;
    worklogsRead: number;
    errorMessage: string | null;
    errorStep?: string | null;
    errorDetail?: string | null;
  }): Promise<void> {
    const run = this.runs.find((r) => r.id === args.id);
    if (run) Object.assign(run, args);
    return Promise.resolve();
  }

  // --- tracked_epic ---
  read(epicKey: string): Promise<{ status: TrackedEpicStatus; lastSyncedAt: Date | null } | null> {
    const s = this.epicState.get(epicKey);
    return Promise.resolve(s ? { status: s.status, lastSyncedAt: s.lastSyncedAt } : null);
  }

  setStatus(epicKey: string, status: TrackedEpicStatus, lastError: string | null): Promise<void> {
    const s = this.epicState.get(epicKey);
    if (s) {
      s.status = status;
      s.lastError = lastError;
    }
    return Promise.resolve();
  }

  setSynced(epicKey: string, at: Date): Promise<void> {
    const s = this.epicState.get(epicKey);
    if (s) s.lastSyncedAt = at;
    return Promise.resolve();
  }

  // --- dirty:epics ---
  add(epicKeys: readonly string[]): Promise<void> {
    for (const k of epicKeys) this.dirty.add(k);
    return Promise.resolve();
  }

  /** Ảnh chụp ổn định để so hai lần chạy có giống nhau từng byte không. */
  snapshot(): string {
    const stable = (v: unknown): unknown =>
      typeof v === 'bigint' ? `${v}n` : v instanceof Date ? v.toISOString() : v;
    return JSON.stringify(
      {
        issues: [...this.issues.entries()].sort(byKey),
        worklogs: [...this.worklogRows.entries()].sort(byKey),
        changelog: [...this.changelogRows.entries()].sort(byKey),
      },
      (_k, v) => stable(v),
    );
  }
}

function byKey(a: [string, unknown], b: [string, unknown]): number {
  return a[0].localeCompare(b[0]);
}

/** Nối `FakeStore` vào các cổng riêng biệt mà job cần. */
export function portsOf(store: FakeStore) {
  return {
    issues: {
      upsertMany: (r: readonly IssueRecord[]) => store.upsertMany(r),
      markRemoved: (e: string, l: ReadonlySet<string>, at: Date) => store.markRemoved(e, l, at),
      knownIdToKey: (e: string) => store.knownIdToKey(e),
    } satisfies IssueWritePort,
    worklogs: {
      upsertMany: (r: readonly WorklogRecord[]) => store.upsertManyWorklogs(r),
      markDeleted: (ids: readonly bigint[]) => store.markDeleted(ids),
      markDeletedMissing: (e: string, ids: ReadonlySet<bigint>) => store.markDeletedMissing(e, ids),
    } satisfies WorklogWritePort,
    changelog: {
      upsertMany: (r: readonly ChangelogRecord[]) => store.upsertManyChangelog(r),
    } satisfies ChangelogWritePort,
    syncRuns: store satisfies SyncRunPort,
    epics: store satisfies EpicStatePort,
    dirty: store satisfies DirtyEpicQueuePort,
  };
}
