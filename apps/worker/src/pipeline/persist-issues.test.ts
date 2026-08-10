import { describe, it, expect } from 'vitest';
import type { EffectiveConfig } from '@app/shared';
import type { JiraIssue, ResolvedFieldMapping } from '@app/jira';
import { buildRecords, type IssueRecord } from './persist-issues.js';
import type { EpicTree } from './fetch-epic-tree.js';

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
  projectKey: null,
  globalVersion: 1,
  projectVersion: null,
  inherited: {
    titlePatterns: true,
    subtaskPatterns: true,
    phaseDefinitions: true,
    matchRules: true,
    signboardColumns: true,
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
  const tree: EpicTree = {
    epic: mkIssue('1000', 'PAY-100', 'Cổng thanh toán'),
    tasks: [mkIssue('1001', 'PAY-101', '[Phase] Development', 'PAY-100')],
    subtasks,
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
