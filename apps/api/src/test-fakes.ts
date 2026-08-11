import type {
  ConfigPayload,
  ConfigSet,
  ConfigVersion,
  MissingDateRow,
  TrackedEpicStatus,
  TrackedEpicSummary,
  UnmatchedLabel,
} from '@app/shared';
import type {
  DirtyEpicQueue,
  IssueReadPort,
  PhaseConfigStore,
} from './services/phase-config.service.js';
import type {
  BackfillQueue,
  EpicPatchData,
  InsertEpicRow,
  JiraEpicMeta,
  JiraEpicPort,
  JiraLookupResult,
  TrackedEpicStore,
} from './services/epic-registry.service.js';
import type { PreviewTask } from './services/config-preview.service.js';

/**
 * Bộ giả lập trong bộ nhớ cho các cổng của tầng API.
 *
 * Tồn tại để test tầng API chạy được mà KHÔNG cần PostgreSQL hay Redis. Không
 * phải để tránh test thật — repository thật đã có test riêng ở `packages/db`,
 * còn ở đây thứ cần kiểm chứng là LUỒNG ĐIỀU PHỐI: gọi đúng thứ tự, không ghi
 * khi chỉ được đọc, chặn đúng người không có quyền.
 *
 * `FakeConfigStore` cố tình ĐẾM số lần ghi. Đó là cách duy nhất khẳng định được
 * "xem thử không ghi gì vào database" — lỗi nặng nhất có thể mắc ở T-09.
 */
export class FakeConfigStore implements PhaseConfigStore {
  /** Số lần các cổng GHI bị gọi. Xem thử phải giữ nguyên con số này. */
  writeCount = 0;

  private readonly sets: ConfigSet[] = [];

  constructor(seed: Array<{ scope: 'GLOBAL' | 'PROJECT'; projectKey: string | null; payload: ConfigPayload; note?: string }>) {
    for (const s of seed) {
      this.sets.push(this.build(s.scope, s.projectKey, s.payload, 'seed', s.note ?? null));
    }
  }

  private build(
    scope: 'GLOBAL' | 'PROJECT',
    projectKey: string | null,
    payload: ConfigPayload,
    createdBy: string,
    note: string | null,
  ): ConfigSet {
    const version =
      Math.max(
        0,
        ...this.sets.filter((s) => s.scope === scope && s.projectKey === projectKey).map((s) => s.version),
      ) + 1;

    for (const s of this.sets) {
      if (s.scope === scope && s.projectKey === projectKey) {
        (s as { isActive: boolean }).isActive = false;
      }
    }

    return {
      // Nội dung TRƯỚC, metadata SAU. Đảo lại thì một `ConfigSet` truyền vào
      // chỗ `payload` sẽ mang theo `version`/`isActive` cũ và ghi đè bản mới —
      // đúng cái bẫy làm rollback trả về số version cũ.
      ...payload,
      id: this.sets.length + 1,
      scope,
      projectKey,
      version,
      isActive: true,
      createdBy,
      // Mốc cố định: engine và test không được đọc đồng hồ (C-12).
      createdAt: `2026-08-0${Math.min(9, version)}T00:00:00.000Z`,
      note,
    };
  }

  findActive(scope: 'GLOBAL' | 'PROJECT', projectKey: string | null): Promise<ConfigSet | null> {
    return Promise.resolve(
      this.sets.find((s) => s.scope === scope && s.projectKey === projectKey && s.isActive) ?? null,
    );
  }

  save(args: {
    scope: 'GLOBAL' | 'PROJECT';
    projectKey: string | null;
    payload: ConfigPayload;
    createdBy: string;
    note: string | null;
  }): Promise<{ version: number; id: number }> {
    this.writeCount += 1;
    const created = this.build(args.scope, args.projectKey, args.payload, args.createdBy, args.note);
    this.sets.push(created);
    return Promise.resolve({ version: created.version, id: created.id });
  }

  async rollback(args: {
    scope: 'GLOBAL' | 'PROJECT';
    projectKey: string | null;
    version: number;
    createdBy: string;
  }): Promise<{ version: number; id: number }> {
    const old = this.sets.find(
      (s) => s.scope === args.scope && s.projectKey === args.projectKey && s.version === args.version,
    );
    if (!old) throw new Error(`Không tìm thấy version ${args.version}.`);

    // Quay lại = TẠO VERSION MỚI có nội dung cũ. Không sửa lịch sử.
    // Bóc riêng phần NỘI DUNG, không truyền cả bản ghi cũ kèm metadata của nó.
    return this.save({
      scope: args.scope,
      projectKey: args.projectKey,
      payload: {
        fallbackScanFullTitle: old.fallbackScanFullTitle,
        titlePatterns: old.titlePatterns,
        subtaskPatterns: old.subtaskPatterns,
        phaseDefinitions: old.phaseDefinitions,
        matchRules: old.matchRules,
        signboardColumns: old.signboardColumns,
        subPhaseOrders: old.subPhaseOrders,
      },
      createdBy: args.createdBy,
      note: `Quay lại nội dung của version ${args.version}`,
    });
  }

  listVersions(
    scope: 'GLOBAL' | 'PROJECT',
    projectKey: string | null,
  ): Promise<readonly ConfigVersion[]> {
    return Promise.resolve(
      this.sets
        .filter((s) => s.scope === scope && s.projectKey === projectKey)
        .sort((a, b) => b.version - a.version)
        .map((s) => ({
          version: s.version,
          isActive: s.isActive,
          createdBy: s.createdBy,
          createdAt: s.createdAt,
          note: s.note,
        })),
    );
  }
}

export class FakeIssueRead implements IssueReadPort {
  constructor(
    private readonly tasks: readonly PreviewTask[] = [],
    private readonly unmatched: readonly UnmatchedLabel[] = [],
    private readonly epicKeys: readonly string[] = [],
  ) {}

  listPhaseTasks(): Promise<readonly PreviewTask[]> {
    return Promise.resolve(this.tasks);
  }

  listUnmatchedLabels(): Promise<readonly UnmatchedLabel[]> {
    return Promise.resolve(this.unmatched);
  }

  listTrackedEpicKeys(): Promise<readonly string[]> {
    return Promise.resolve(this.epicKeys);
  }
}

// ---------------------------------------------------------------------------
// Sổ đăng ký Epic (T-10)
// ---------------------------------------------------------------------------

export interface FakeEpicRow {
  epicKey: string;
  status: TrackedEpicStatus;
  projectKey: string;
  displayName: string;
  timezone: string;
  calendarId: string;
  note: string | null;
  subtaskCount?: number;
  missingWbsDateCount?: number;
  /** Dữ liệu lịch sử giả, để kiểm chứng `purge=false` KHÔNG xoá gì. */
  historyRows?: number;
}

export class FakeTrackedEpicStore implements TrackedEpicStore {
  readonly rows = new Map<string, FakeEpicRow>();
  /** Dữ liệu lịch sử tách riêng: `purge=false` phải giữ nguyên phần này. */
  readonly history = new Map<string, number>();
  readonly missingDates = new Map<string, MissingDateRow[]>();

  constructor(seed: readonly FakeEpicRow[] = []) {
    for (const r of seed) {
      this.rows.set(r.epicKey, { ...r });
      this.history.set(r.epicKey, r.historyRows ?? 0);
    }
  }

  findStatus(epicKey: string): Promise<TrackedEpicStatus | null> {
    return Promise.resolve(this.rows.get(epicKey)?.status ?? null);
  }

  existingKeys(keys: readonly string[]): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(keys.filter((k) => this.rows.has(k))));
  }

  insertIfAbsent(rows: readonly InsertEpicRow[]): Promise<readonly string[]> {
    const added: string[] = [];
    for (const r of rows) {
      if (this.rows.has(r.epicKey)) continue; // C-6: bỏ qua, không ném lỗi trùng
      this.rows.set(r.epicKey, {
        epicKey: r.epicKey,
        status: 'PENDING',
        projectKey: r.projectKey,
        displayName: r.displayName,
        timezone: r.timezone,
        calendarId: r.calendarId,
        note: r.note,
      });
      added.push(r.epicKey);
    }
    return Promise.resolve(added);
  }

  update(epicKey: string, data: EpicPatchData): Promise<void> {
    const row = this.rows.get(epicKey);
    if (row) Object.assign(row, data);
    return Promise.resolve();
  }

  remove(epicKey: string, purge: boolean): Promise<void> {
    this.rows.delete(epicKey);
    if (purge) this.history.delete(epicKey);
    return Promise.resolve();
  }

  listWithHealth(projectKey: string | null): Promise<readonly TrackedEpicSummary[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => projectKey === null || r.projectKey === projectKey)
        .map((r) => ({
          epicKey: r.epicKey,
          displayName: r.displayName,
          projectKey: r.projectKey,
          status: r.status,
          timezone: r.timezone,
          calendarId: r.calendarId,
          lastSyncedAt: null,
          lastError: null,
          note: r.note,
          dataHealth: {
            phaseCount: 0,
            subtaskCount: r.subtaskCount ?? 0,
            totalEstimateHours: 0,
            missingWbsDateCount: r.missingWbsDateCount ?? 0,
            unclassifiedTaskCount: 0,
          },
        })),
    );
  }

  listMissingDates(epicKey: string): Promise<readonly MissingDateRow[]> {
    return Promise.resolve(this.missingDates.get(epicKey) ?? []);
  }

  /** Chỉ dùng trong test: Epic nào job đêm sẽ chạy. */
  listActive(): string[] {
    return [...this.rows.values()]
      .filter((r) => r.status === 'ACTIVE')
      .map((r) => r.epicKey)
      .sort();
  }
}

export class FakeJiraEpicPort implements JiraEpicPort {
  constructor(private readonly known: ReadonlyMap<string, JiraLookupResult>) {}

  lookup(keys: readonly string[]): Promise<ReadonlyMap<string, JiraLookupResult>> {
    const out = new Map<string, JiraLookupResult>();
    for (const k of keys) {
      out.set(k, this.known.get(k) ?? { ok: false, reason: 'NOT_FOUND' });
    }
    return Promise.resolve(out);
  }

  browse(
    _projectKey: string,
    page: { startAt: number; maxResults: number },
  ): Promise<{ items: readonly { key: string; displayName: string }[]; total: number }> {
    const all = [...this.known.entries()]
      .filter(([, v]) => v.ok && v.meta.issueType === 'EPIC')
      .map(([key, v]) => ({ key, displayName: v.ok ? v.meta.displayName : '' }));
    return Promise.resolve({
      items: all.slice(page.startAt, page.startAt + page.maxResults),
      total: all.length,
    });
  }
}

export class FakeBackfillQueue implements BackfillQueue {
  readonly enqueued: string[] = [];

  enqueue(epicKeys: readonly string[]): Promise<void> {
    this.enqueued.push(...epicKeys);
    return Promise.resolve();
  }
}

/** Dựng nhanh một kết quả tra Jira hợp lệ. */
export function jiraEpic(
  key: string,
  over: Partial<JiraEpicMeta> = {},
): JiraLookupResult {
  return {
    ok: true,
    meta: {
      key,
      issueId: 1000n,
      displayName: `Epic ${key}`,
      projectKey: key.split('-')[0] ?? 'PAY',
      issueType: 'EPIC',
      phaseCount: 3,
      subtaskCount: 25,
      totalEstimateSeconds: 200 * 3600,
      missingWbsDateCount: 0,
      ...over,
    },
  };
}

export class FakeDirtyQueue implements DirtyEpicQueue {
  /** Tập hợp, không phải mảng — Redis `SADD` cũng khử trùng lặp. */
  readonly members = new Set<string>();

  add(epicKeys: readonly string[]): Promise<void> {
    for (const k of epicKeys) this.members.add(k);
    return Promise.resolve();
  }
}
