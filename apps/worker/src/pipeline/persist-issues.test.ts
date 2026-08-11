import { describe, it, expect } from 'vitest';
import { UNCLASSIFIED_PHASE, type EffectiveConfig } from '@app/shared';
import type { JiraIssue, ResolvedFieldMapping } from '@app/jira';
import { buildRecords, tierRole, ISSUE_TYPE, type IssueRecord } from './persist-issues.js';
import type { RootTree } from './fetch-epic-tree.js';

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
  signboardColumns: [{ taskCode: 'Create', labelVi: 'Tạo mới', side: 'VN', displayOrder: 1 }],
  subPhaseOrders: [],
  projectKey: null,
  globalVersion: 1,
  projectVersion: null,
  inherited: {
    titlePatterns: true,
    subtaskPatterns: true,
    phaseDefinitions: true,
    matchRules: true,
    signboardColumns: true,
    subPhaseOrders: true,
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

/** Dựng cây theo tầng rồi chạy buildRecords với depth cho trước. */
function buildTree(byTier: JiraIssue[][], hierarchyDepth: number) {
  const tree: RootTree = {
    root: byTier[0]?.[0] ?? null,
    byTier,
    liveKeys: new Set(byTier.flat().map((i) => i.key)),
  };
  return buildRecords({
    epicKey: 'PAY-100',
    projectKey: 'PAY',
    hierarchyDepth,
    tree,
    worklogsByIssue: new Map(),
    changelogByIssue: new Map(),
    config: CONFIG,
    fields: FIELDS,
  });
}

/** Dựng cây 1 Epic + 1 Task (Development) + các Sub-task truyền vào (depth 2). */
function build(subtasks: JiraIssue[]) {
  return buildTree(
    [
      [mkIssue('1000', 'PAY-100', 'Cổng thanh toán')],
      [mkIssue('1001', 'PAY-101', '[Phase] Development', 'PAY-100')],
      subtasks,
    ],
    2,
  );
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
// Vai trò theo tầng (multi-tenant, depth 1..4)
// ---------------------------------------------------------------------------

describe('tierRole — vai trò gán theo VỊ TRÍ tầng', () => {
  it.each([
    // [depth, tierIndex, vai trò]
    [1, 0, 'EPIC'],
    [1, 1, 'SUBTASK'], // depth 1: KHÔNG có TASK
    [2, 0, 'EPIC'],
    [2, 1, 'TASK'],
    [2, 2, 'SUBTASK'],
    [3, 0, 'EPIC'],
    [3, 1, 'MIDDLE'],
    [3, 2, 'TASK'],
    [3, 3, 'SUBTASK'],
    [4, 0, 'EPIC'],
    [4, 1, 'MIDDLE'],
    [4, 2, 'MIDDLE'],
    [4, 3, 'TASK'],
    [4, 4, 'SUBTASK'],
  ])('depth %i, tầng %i → %s', (depth, tierIndex, role) => {
    expect(tierRole(tierIndex, depth)).toBe(role);
  });
});

describe('buildRecords — cây 1..4 tầng', () => {
  it('depth 2: mọi bản ghi mang projectKey và tierIndex đúng vị trí', () => {
    const built = build([
      mkIssue('2001', 'PAY-201', '[PAY][TeamA][Development][Login]_Create', 'PAY-101'),
    ]);

    const byKey = new Map(built.issues.map((i) => [i.issueKey, i]));
    expect(byKey.get('PAY-100')).toMatchObject({ projectKey: 'PAY', tierIndex: 0, issueType: 'EPIC' });
    expect(byKey.get('PAY-101')).toMatchObject({ projectKey: 'PAY', tierIndex: 1, issueType: 'TASK' });
    expect(byKey.get('PAY-201')).toMatchObject({ projectKey: 'PAY', tierIndex: 2, issueType: 'SUBTASK' });
  });

  it('depth 1: lá là SUBTASK, phaseCode suy từ CHÍNH tiêu đề lá qua TaskTitleParser', () => {
    const built = buildTree(
      [
        [mkIssue('1000', 'PAY-100', 'Root phẳng')],
        // Tiêu đề vừa chứa từ khoá phase ("Development") vừa đúng mẫu Sub-task.
        [mkIssue('2001', 'PAY-201', '[PAY][TeamA][Development][Login]_Create', 'PAY-100')],
      ],
      1,
    );

    const leaf = built.issues.find((i) => i.issueKey === 'PAY-201')!;
    expect(leaf.issueType).toBe(ISSUE_TYPE.SUBTASK);
    expect(leaf.tierIndex).toBe(1);
    // Không có tầng TASK → phase lấy từ tiêu đề lá.
    expect(leaf.phaseCode).toBe('DEVELOPMENT');
    // Mẫu Sub-task VẪN chạy trên lá như thường — Signboard cần các cột này.
    expect(leaf.taskType).toBe('Create');
    expect(leaf.functionName).toBe('Login');
    // Không có bản ghi TASK nào trong toàn bộ kết quả.
    expect(built.issues.some((i) => i.issueType === 'TASK')).toBe(false);
  });

  it('depth 1: tiêu đề lá không khớp gì → UNCLASSIFIED (fallback của @app/shared)', () => {
    const built = buildTree(
      [
        [mkIssue('1000', 'PAY-100', 'Root phẳng')],
        [mkIssue('2001', 'PAY-201', 'Họp review nội bộ', 'PAY-100')],
      ],
      1,
    );

    const leaf = built.issues.find((i) => i.issueKey === 'PAY-201')!;
    expect(leaf.phaseCode).toBe(UNCLASSIFIED_PHASE);
    // Vẫn được ghi đầy đủ để cộng dồn Burndown (E-27), chỉ không lên Signboard.
    expect(leaf.sbParseStatus).toBe('UNPARSED');
  });

  it('depth 3: tầng giữa là MIDDLE, KHÔNG mang phase/kết quả phân tách', () => {
    const built = buildTree(
      [
        [mkIssue('1000', 'PAY-100', 'Root')],
        [mkIssue('1100', 'PAY-110', 'Nhánh giữa', 'PAY-100')],
        [mkIssue('1200', 'PAY-120', '[Phase] Development', 'PAY-110')],
        [mkIssue('2001', 'PAY-201', '[PAY][TeamA][Development][Login]_Create', 'PAY-120')],
      ],
      3,
    );

    const middle = built.issues.find((i) => i.issueKey === 'PAY-110')!;
    expect(middle.issueType).toBe(ISSUE_TYPE.MIDDLE);
    expect(middle.tierIndex).toBe(1);
    expect(middle.phaseCode).toBeNull();
    expect(middle.rawPhaseLabel).toBeNull();
    expect(middle.sbParseStatus).toBe('UNPARSED');
    expect(middle.sbTaskRaw).toBeNull();

    // TASK là tầng lá-1 (tầng 2), và lá vẫn kế thừa phase từ nó.
    const task = built.issues.find((i) => i.issueKey === 'PAY-120')!;
    expect(task.issueType).toBe(ISSUE_TYPE.TASK);
    expect(task.tierIndex).toBe(2);
    expect(task.phaseCode).toBe('DEVELOPMENT');

    const leaf = built.issues.find((i) => i.issueKey === 'PAY-201')!;
    expect(leaf.issueType).toBe(ISSUE_TYPE.SUBTASK);
    expect(leaf.tierIndex).toBe(3);
    expect(leaf.phaseCode).toBe('DEVELOPMENT');
  });

  it('depth 4: hai tầng MIDDLE liên tiếp, vai trò còn lại không đổi', () => {
    const built = buildTree(
      [
        [mkIssue('1000', 'PAY-100', 'Root')],
        [mkIssue('1100', 'PAY-110', 'Giữa 1', 'PAY-100')],
        [mkIssue('1150', 'PAY-115', 'Giữa 2', 'PAY-110')],
        [mkIssue('1200', 'PAY-120', '[Phase] Development', 'PAY-115')],
        [mkIssue('2001', 'PAY-201', '[PAY][TeamA][Development][Login]_Create', 'PAY-120')],
      ],
      4,
    );

    const roles = new Map(built.issues.map((i) => [i.issueKey, `${i.tierIndex}:${i.issueType}`]));
    expect(roles.get('PAY-100')).toBe('0:EPIC');
    expect(roles.get('PAY-110')).toBe('1:MIDDLE');
    expect(roles.get('PAY-115')).toBe('2:MIDDLE');
    expect(roles.get('PAY-120')).toBe('3:TASK');
    expect(roles.get('PAY-201')).toBe('4:SUBTASK');
  });
});
