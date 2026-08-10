import { describe, it, expect } from 'vitest';
import { DEFAULT_HIERARCHY_PROFILE, type EffectiveConfig } from '@app/shared';
import type { JiraIssue, ResolvedFieldMapping } from '@app/jira';
import { buildRecords, type IssueRecord } from './persist-issues.js';
import type { IssueTree } from './fetch-epic-tree.js';

/**
 * Tập trung vào MỘT tính chất: trường bóc từ tiêu đề Sub-task PHẢI được cắt cho
 * vừa cột VARCHAR trước khi ghi. Không cắt thì một tiêu đề dài bất thường làm
 * `prisma.jiraIssue.upsert()` ném "value too long" và hỏng CẢ lượt đồng bộ Epic —
 * đúng lỗi hiện ra ở màn hình Epics (STATUS = ERROR).
 *
 * `FakeStore` trong test đồng bộ chỉ là Map, KHÔNG mô phỏng giới hạn độ dài của
 * Postgres — nên lỗi này lọt qua mọi test cũ. Ở đây kiểm thẳng `buildRecords`.
 */

const FIELDS: ResolvedFieldMapping = {
  wbsStartDate: 'customfield_10100',
  wbsEndDate: 'customfield_10101',
};

const CONFIG: EffectiveConfig = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[Phase] {name}', sortOrder: 1 }],
  subtaskPatterns: [
    { patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 },
  ],
  phaseDefinitions: [{ phaseCode: 'DEVELOPMENT', labelVi: 'Phát triển', displayOrder: 1 }],
  matchRules: [
    { keyword: 'Development', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 40 },
  ],
  signboardColumns: [{ taskCode: 'Create', labelVi: 'Tạo mới', displayOrder: 1 }],
  hierarchyProfile: DEFAULT_HIERARCHY_PROFILE,
  projectKey: null,
  globalVersion: 1,
  projectVersion: null,
  inherited: {
    titlePatterns: true,
    subtaskPatterns: true,
    phaseDefinitions: true,
    matchRules: true,
    signboardColumns: true,
    hierarchyProfile: true,
  },
};

function mkIssue(id: string, key: string, summary: string, parent?: string): JiraIssue {
  return {
    id,
    key,
    fields: {
      summary,
      status: { id: '1', statusCategory: { key: 'new' } },
      timeoriginalestimate: 3600,
      timeestimate: 3600,
      timespent: 0,
      created: '2026-03-01T00:00:00.000+0000',
      updated: '2026-03-01T00:00:00.000+0000',
      ...(parent !== undefined ? { parent: { key: parent } } : {}),
    },
  };
}

/** Dựng cây 1 Epic + 1 Task (Development) + các Sub-task truyền vào. */
function build(subtasks: JiraIssue[]) {
  const tree: IssueTree = {
    root: mkIssue('1000', 'PAY-100', 'Cổng thanh toán'),
    groupLevels: [[mkIssue('1001', 'PAY-101', '[Phase] Development', 'PAY-100')]],
    leaves: subtasks,
    liveKeys: new Set(['PAY-100', 'PAY-101', ...subtasks.map((s) => s.key)]),
  };
  return buildRecords({
    epicKey: 'PAY-100',
    tree,
    worklogsByIssue: new Map(),
    changelogByIssue: new Map(),
    config: CONFIG,
    fields: FIELDS,
  });
}

const bySub = (built: ReturnType<typeof build>, key: string): IssueRecord => {
  const rec = built.issues.find((i) => i.issueKey === key);
  if (!rec) throw new Error(`không tìm thấy Sub-task ${key}`);
  return rec;
};

const truncationWarnings = (built: ReturnType<typeof build>) =>
  built.warnings.filter((w) => w.code === 'FIELD_TRUNCATED');

describe('buildRecords — siết trường Sub-task cho vừa cột VARCHAR', () => {
  it('cắt sb_task_raw dài xuống 64 ký tự và ghi cảnh báo FIELD_TRUNCATED', () => {
    const longTask = 'X'.repeat(100); // {task} nuốt trọn đuôi tiêu đề → 100 > 64
    const built = build([
      mkIssue('2001', 'PAY-201', `[PAY][TeamA][Development][Login]_${longTask}`, 'PAY-101'),
    ]);

    const sub = bySub(built, 'PAY-201');
    expect([...(sub.sbTaskRaw ?? '')].length).toBe(64);
    expect(sub.sbTaskRaw).toBe('X'.repeat(64));

    const warns = truncationWarnings(built);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain('PAY-201');
    expect(warns[0]!.message).toContain('sb_task_raw');
  });

  it('cắt function_name và function_key dài xuống 128 ký tự', () => {
    const longFn = 'F'.repeat(140); // [{function}] nằm giữa hai ngoặc → 140 > 128
    const built = build([
      mkIssue('2002', 'PAY-202', `[PAY][TeamA][Development][${longFn}]_Create`, 'PAY-101'),
    ]);

    const sub = bySub(built, 'PAY-202');
    expect([...(sub.functionName ?? '')].length).toBe(128);
    // functionKey = normalize(functionName gốc) rồi mới cắt — cũng phải vừa 128.
    expect([...(sub.functionKey ?? '')].length).toBe(128);

    const warns = truncationWarnings(built);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain('function_name');
    expect(warns[0]!.message).toContain('function_key');
  });

  it('cắt theo CODE POINT, không xé đôi cặp surrogate', () => {
    // U+20BB7 (𠮷) là ký tự mặt phẳng bổ sung: 1 code point = 2 code unit UTF-16.
    // Cắt sai (theo code unit) sẽ để lại nửa surrogate mà Postgres từ chối mã hoá.
    const astral = '𠮷'.repeat(80); // 80 code point > 64
    const built = build([
      mkIssue('2003', 'PAY-203', `[PAY][TeamA][Development][Login]_${astral}`, 'PAY-101'),
    ]);

    const sub = bySub(built, 'PAY-203');
    expect([...(sub.sbTaskRaw ?? '')].length).toBe(64);
    expect(sub.sbTaskRaw).toBe('𠮷'.repeat(64));
    // Không còn code unit lẻ (lone surrogate) nào.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(sub.sbTaskRaw ?? '')).toBe(false);
  });

  it('để nguyên trường trong giới hạn và KHÔNG ghi cảnh báo cắt', () => {
    const built = build([
      mkIssue('2004', 'PAY-204', '[PAY][TeamA][Development][Login]_Create', 'PAY-101'),
    ]);

    const sub = bySub(built, 'PAY-204');
    expect(sub.sbTaskRaw).toBe('Create');
    expect(sub.functionName).toBe('Login');
    expect(sub.taskType).toBe('Create');
    expect(truncationWarnings(built)).toHaveLength(0);
  });

  it('cắt là phép tất định — chạy hai lần cho kết quả y hệt (C-6)', () => {
    const subs = [
      mkIssue('2005', 'PAY-205', `[PAY][TeamA][Development][Login]_${'X'.repeat(100)}`, 'PAY-101'),
    ];
    const a = build(subs);
    const b = build(subs);
    const stable = (r: unknown) =>
      JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    expect(stable(a.issues)).toBe(stable(b.issues));
  });
});

// ---------------------------------------------------------------------------
// Chiến lược Phase FIELD / FIXED và hàng/cột Signboard lấy từ field Jira —
// dành cho dự án không đặt tên ticket theo mẫu.
// ---------------------------------------------------------------------------

function buildWithProfile(
  profile: NonNullable<EffectiveConfig['hierarchyProfile']>,
  leaves: JiraIssue[],
) {
  const tree: IssueTree = {
    root: mkIssue('1000', 'OPS-1', 'Vận hành quý 2'),
    groupLevels: [],
    leaves,
    liveKeys: new Set(['OPS-1', ...leaves.map((s) => s.key)]),
  };
  return buildRecords({
    epicKey: 'OPS-1',
    tree,
    worklogsByIssue: new Map(),
    changelogByIssue: new Map(),
    config: { ...CONFIG, hierarchyProfile: profile },
    fields: FIELDS,
  });
}

const SB_TITLE = {
  row: { source: 'TITLE_SLOT', ref: 'function' },
  column: { source: 'TITLE_SLOT', ref: 'task' },
} as const;

describe('buildRecords — chiến lược Phase theo Hierarchy Profile', () => {
  it('FIELD: đọc components, giá trị đầu tiên khớp luật thắng', () => {
    const leaf = mkIssue('2001', 'OPS-10', 'Sửa dashboard', 'OPS-1');
    leaf.fields['components'] = [{ name: 'Nội bộ' }, { name: 'Development' }];

    const built = buildWithProfile(
      {
        levels: [{ role: 'ROOT' }, { role: 'LEAF' }],
        phaseSource: { type: 'FIELD', ref: 'components' },
        signboard: SB_TITLE,
      },
      [leaf],
    );

    const rec = bySub(built, 'OPS-10');
    expect(rec.phaseCode).toBe('DEVELOPMENT');
    expect(rec.rawPhaseLabel).toBe('Development');
    expect(rec.resolvedRole).toBe('LEAF');
  });

  it('FIELD: không giá trị nào khớp thì UNCLASSIFIED, giữ giá trị thô để gợi ý luật', () => {
    const leaf = mkIssue('2002', 'OPS-11', 'Việc lặt vặt', 'OPS-1');
    leaf.fields['components'] = [{ name: 'Backlog chung' }];

    const built = buildWithProfile(
      {
        levels: [{ role: 'ROOT' }, { role: 'LEAF' }],
        phaseSource: { type: 'FIELD', ref: 'components' },
        signboard: SB_TITLE,
      },
      [leaf],
    );

    const rec = bySub(built, 'OPS-11');
    expect(rec.phaseCode).toBe('UNCLASSIFIED');
    expect(rec.rawPhaseLabel).toBe('Backlog chung');
  });

  it('FIXED: mọi lá về cùng một Phase, tiêu đề không cần nói gì về Phase', () => {
    const built = buildWithProfile(
      {
        levels: [{ role: 'ROOT' }, { role: 'LEAF' }],
        phaseSource: { type: 'FIXED', ref: 'DEVELOPMENT' },
        signboard: SB_TITLE,
      },
      [mkIssue('2003', 'OPS-12', 'Bất kỳ tiêu đề nào', 'OPS-1')],
    );

    expect(bySub(built, 'OPS-12').phaseCode).toBe('DEVELOPMENT');
  });
});

describe('buildRecords — hàng/cột Signboard lấy từ field Jira', () => {
  it('row FIELD (components) + column FIELD (labels): không cần tiêu đề theo mẫu', () => {
    const leaf = mkIssue('2004', 'OPS-13', 'Tiêu đề tự do không theo mẫu', 'OPS-1');
    leaf.fields['components'] = [{ name: 'Login Form' }];
    leaf.fields['labels'] = ['Create'];

    const built = buildWithProfile(
      {
        levels: [{ role: 'ROOT' }, { role: 'LEAF' }],
        phaseSource: { type: 'FIXED', ref: 'DEVELOPMENT' },
        signboard: {
          row: { source: 'FIELD', ref: 'components' },
          column: { source: 'FIELD', ref: 'labels' },
        },
      },
      [leaf],
    );

    const rec = bySub(built, 'OPS-13');
    expect(rec.functionName).toBe('Login Form');
    expect(rec.functionKey).toBe('login form');
    expect(rec.taskType).toBe('Create'); // khớp CHÍNH XÁC cột đã khai
    expect(rec.sbParseStatus).toBe('OK');
  });

  it('label không khớp cột nào thì UNKNOWN_TASK_TYPE, giữ giá trị thô', () => {
    const leaf = mkIssue('2005', 'OPS-14', 'Tự do', 'OPS-1');
    leaf.fields['components'] = [{ name: 'Login' }];
    leaf.fields['labels'] = ['ReviewNoiBo'];

    const built = buildWithProfile(
      {
        levels: [{ role: 'ROOT' }, { role: 'LEAF' }],
        phaseSource: { type: 'FIXED', ref: 'DEVELOPMENT' },
        signboard: {
          row: { source: 'FIELD', ref: 'components' },
          column: { source: 'FIELD', ref: 'labels' },
        },
      },
      [leaf],
    );

    const rec = bySub(built, 'OPS-14');
    expect(rec.taskType).toBeNull();
    expect(rec.sbTaskRaw).toBe('ReviewNoiBo');
    expect(rec.sbParseStatus).toBe('UNKNOWN_TASK_TYPE');
  });

  it('thiếu field làm hàng thì UNPARSED — vẫn được ghi và cộng vào Burndown', () => {
    const leaf = mkIssue('2006', 'OPS-15', 'Không có component', 'OPS-1');

    const built = buildWithProfile(
      {
        levels: [{ role: 'ROOT' }, { role: 'LEAF' }],
        phaseSource: { type: 'FIXED', ref: 'DEVELOPMENT' },
        signboard: {
          row: { source: 'FIELD', ref: 'components' },
          column: { source: 'FIELD', ref: 'labels' },
        },
      },
      [leaf],
    );

    const rec = bySub(built, 'OPS-15');
    expect(rec.sbParseStatus).toBe('UNPARSED');
    expect(rec.phaseCode).toBe('DEVELOPMENT'); // Burndown vẫn có nó
  });
});
