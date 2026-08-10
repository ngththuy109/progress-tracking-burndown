import { describe, it, expect } from 'vitest';
import { DEFAULT_HIERARCHY_PROFILE, type ConfigPayload, type HierarchyProfile } from '@app/shared';
import {
  mergeInheritance,
  validateConfigPayload,
  hasBlockingError,
  MAX_REGEX_LENGTH,
} from './merge-inheritance.js';

const GLOBAL: ConfigPayload = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[Phase] {name}', sortOrder: 1 }],
  subtaskPatterns: [
    { patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 },
  ],
  phaseDefinitions: [
    { phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 1 },
    { phaseCode: 'DEVELOPMENT', labelVi: 'Phát triển', displayOrder: 2 },
  ],
  matchRules: [
    { keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
    { keyword: '設計', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
  ],
  signboardColumns: [{ taskCode: 'Create', labelVi: 'Tạo mới', displayOrder: 1 }],
};

const V = { globalVersion: 3, projectVersion: null };

describe('kế thừa cấu hình theo project', () => {
  it('project không khai gì thì kế thừa toàn bộ, mọi phần inherited = true', () => {
    const eff = mergeInheritance(GLOBAL, null, V);

    expect(eff.titlePatterns).toEqual(GLOBAL.titlePatterns);
    expect(eff.phaseDefinitions).toEqual(GLOBAL.phaseDefinitions);
    expect(eff.matchRules).toEqual(GLOBAL.matchRules);
    expect(eff.inherited).toEqual({
      titlePatterns: true,
      subtaskPatterns: true,
      phaseDefinitions: true,
      matchRules: true,
      signboardColumns: true,
      hierarchyProfile: true,
    });
  });

  it('project ghi đè mẫu tiêu đề thì Phase và từ khoá VẪN kế thừa', () => {
    // Đây là ca then chốt: ba phần kế thừa độc lập nhau. Làm kiểu "tất cả hoặc
    // không có gì" thì project mất sạch danh sách Phase → mọi Task UNCLASSIFIED.
    const eff = mergeInheritance(
      GLOBAL,
      { projectKey: 'SHOP', titlePatterns: [{ patternText: '【{name}】', sortOrder: 1 }] },
      { globalVersion: 3, projectVersion: 1 },
    );

    expect(eff.titlePatterns).toEqual([{ patternText: '【{name}】', sortOrder: 1 }]);
    expect(eff.inherited.titlePatterns).toBe(false);

    expect(eff.phaseDefinitions).toEqual(GLOBAL.phaseDefinitions);
    expect(eff.inherited.phaseDefinitions).toBe(true);

    expect(eff.matchRules).toEqual(GLOBAL.matchRules);
    expect(eff.inherited.matchRules).toBe(true);
  });

  it('project ghi đè từ khoá thì mẫu tiêu đề và Phase VẪN kế thừa', () => {
    const eff = mergeInheritance(
      GLOBAL,
      {
        projectKey: 'CRM',
        matchRules: [
          { keyword: 'Migration', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 50 },
        ],
      },
      { globalVersion: 3, projectVersion: 2 },
    );

    expect(eff.matchRules).toHaveLength(1);
    expect(eff.inherited.matchRules).toBe(false);
    expect(eff.inherited.titlePatterns).toBe(true);
    expect(eff.inherited.phaseDefinitions).toBe(true);
  });

  it('mảng rỗng của project được coi là KHÔNG khai, vẫn kế thừa', () => {
    // Nếu coi mảng rỗng là "đã ghi đè" thì project lỡ xoá hết luật sẽ mất luôn
    // cả bộ Mặc định — không có đường quay lại ngoài việc khai lại từ đầu.
    const eff = mergeInheritance(GLOBAL, { projectKey: 'X', matchRules: [] }, V);
    expect(eff.matchRules).toEqual(GLOBAL.matchRules);
    expect(eff.inherited.matchRules).toBe(true);
  });

  it('cờ fallbackScanFullTitle của project thắng khi được khai', () => {
    const eff = mergeInheritance(
      GLOBAL,
      { projectKey: 'X', fallbackScanFullTitle: false },
      V,
    );
    expect(eff.fallbackScanFullTitle).toBe(false);
  });

  it('giữ nguyên số version của cả hai bộ để UI hiển thị', () => {
    const eff = mergeInheritance(GLOBAL, { projectKey: 'SHOP' }, {
      globalVersion: 3,
      projectVersion: 7,
    });
    expect(eff.globalVersion).toBe(3);
    expect(eff.projectVersion).toBe(7);
    expect(eff.projectKey).toBe('SHOP');
  });
});

describe('kiểm tra hợp lệ trước khi lưu', () => {
  const withRules = (over: Partial<ConfigPayload>): ConfigPayload => ({ ...GLOBAL, ...over });

  it('cấu hình mặc định là hợp lệ, không có lỗi chặn', () => {
    const issues = validateConfigPayload(GLOBAL);
    expect(hasBlockingError(issues)).toBe(false);
  });

  it('chặn lưu khi không có Phase nào', () => {
    const issues = validateConfigPayload(withRules({ phaseDefinitions: [], matchRules: [] }));
    expect(issues.some((i) => i.code === 'NO_PHASE_DEFINED')).toBe(true);
    expect(hasBlockingError(issues)).toBe(true);
  });

  it('chặn lưu khi mã Phase bị trùng', () => {
    const issues = validateConfigPayload(
      withRules({
        phaseDefinitions: [
          { phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 1 },
          { phaseCode: 'DESIGN', labelVi: 'Thiết kế 2', displayOrder: 2 },
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'DUPLICATE_PHASE_CODE')).toBe(true);
  });

  it('chặn lưu khi luật khớp trỏ tới Phase không tồn tại', () => {
    const issues = validateConfigPayload(
      withRules({
        matchRules: [
          { keyword: 'X', matchMode: 'CONTAINS', phaseCode: 'MIGRATION', matchPriority: 50 },
        ],
      }),
    );
    const orphan = issues.find((i) => i.code === 'ORPHAN_PHASE_CODE');
    expect(orphan).toBeDefined();
    // Lỗi phải neo vào đúng dòng luật để UI hiện tại chỗ, không phải banner chung
    expect(orphan?.path).toBe('matchRules[0].phaseCode');
  });

  it('chặn lưu khi mẫu tiêu đề Task thiếu ô {name}', () => {
    const issues = validateConfigPayload(
      withRules({ titlePatterns: [{ patternText: '[Phase] abc', sortOrder: 1 }] }),
    );
    expect(issues.some((i) => i.code === 'PATTERN_MISSING_SLOT')).toBe(true);
  });

  it('chặn lưu khi mẫu tiêu đề Sub-task thiếu ô {function} hoặc {task}', () => {
    const issues = validateConfigPayload(
      withRules({ subtaskPatterns: [{ patternText: '[{project}]_{task}', sortOrder: 1 }] }),
    );
    expect(issues.filter((i) => i.code === 'PATTERN_MISSING_SLOT')).toHaveLength(1);
  });

  it('chặn lưu khi regex dài quá 200 ký tự', () => {
    const issues = validateConfigPayload(
      withRules({
        matchRules: [
          {
            keyword: 'a'.repeat(MAX_REGEX_LENGTH + 1),
            matchMode: 'REGEX',
            phaseCode: 'DESIGN',
            matchPriority: 50,
          },
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'REGEX_TOO_LONG')).toBe(true);
  });

  it('chặn lưu khi regex không biên dịch được', () => {
    const issues = validateConfigPayload(
      withRules({
        matchRules: [
          { keyword: '([unclosed', matchMode: 'REGEX', phaseCode: 'DESIGN', matchPriority: 50 },
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'REGEX_INVALID')).toBe(true);
  });

  it('từ khoá dài nhưng chế độ CONTAINS thì KHÔNG bị giới hạn 200 ký tự', () => {
    const issues = validateConfigPayload(
      withRules({
        matchRules: [
          {
            keyword: 'a'.repeat(300),
            matchMode: 'CONTAINS',
            phaseCode: 'DESIGN',
            matchPriority: 50,
          },
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'REGEX_TOO_LONG')).toBe(false);
  });

  it('CẢNH BÁO (không chặn) khi một từ khoá trỏ về 2 Phase khác nhau', () => {
    const issues = validateConfigPayload(
      withRules({
        matchRules: [
          { keyword: 'Test', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
          { keyword: 'test', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 50 },
        ],
      }),
    );
    const w = issues.find((i) => i.code === 'AMBIGUOUS_PHASE_RULE');
    expect(w?.level).toBe('WARNING');
    expect(hasBlockingError(issues)).toBe(false);
  });

  it('chặn lưu khi mã cột Signboard bị trùng', () => {
    const issues = validateConfigPayload(
      withRules({
        signboardColumns: [
          { taskCode: 'Create', labelVi: 'Tạo mới', displayOrder: 1 },
          { taskCode: 'Create', labelVi: 'Tạo lại', displayOrder: 2 },
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'DUPLICATE_TASK_CODE')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hierarchy Profile — cấu trúc dự án linh hoạt
// ---------------------------------------------------------------------------

const TWO_TIER: HierarchyProfile = {
  levels: [{ role: 'ROOT' }, { role: 'LEAF' }],
  phaseSource: { type: 'SELF_TITLE_SLOT', ref: 'phase' },
  signboard: {
    row: { source: 'TITLE_SLOT', ref: 'function' },
    column: { source: 'TITLE_SLOT', ref: 'task' },
  },
};

describe('kế thừa Hierarchy Profile', () => {
  it('không ai khai thì dùng profile mặc định 3 tầng, inherited = true', () => {
    const eff = mergeInheritance(GLOBAL, null, V);
    expect(eff.hierarchyProfile).toEqual(DEFAULT_HIERARCHY_PROFILE);
    expect(eff.inherited.hierarchyProfile).toBe(true);
  });

  it('bộ Mặc định khai thì project kế thừa profile đó', () => {
    const eff = mergeInheritance(
      { ...GLOBAL, hierarchyProfile: TWO_TIER },
      { projectKey: 'SHOP' },
      { globalVersion: 3, projectVersion: 1 },
    );
    expect(eff.hierarchyProfile).toEqual(TWO_TIER);
    expect(eff.inherited.hierarchyProfile).toBe(true);
  });

  it('project khai thì profile của project thắng, inherited = false', () => {
    const eff = mergeInheritance(
      GLOBAL,
      { projectKey: 'SHOP', hierarchyProfile: TWO_TIER },
      { globalVersion: 3, projectVersion: 1 },
    );
    expect(eff.hierarchyProfile).toEqual(TWO_TIER);
    expect(eff.inherited.hierarchyProfile).toBe(false);
  });
});

describe('kiểm tra hợp lệ Hierarchy Profile', () => {
  const withProfile = (profile: HierarchyProfile): ConfigPayload => ({
    ...GLOBAL,
    hierarchyProfile: profile,
  });

  it('profile 2 tầng + SELF_TITLE_SLOT hợp lệ', () => {
    const issues = validateConfigPayload(withProfile(TWO_TIER));
    expect(hasBlockingError(issues)).toBe(false);
  });

  it('vai lệch vị trí (đầu không phải ROOT) bị chặn', () => {
    const issues = validateConfigPayload(
      withProfile({ ...TWO_TIER, levels: [{ role: 'LEAF' }, { role: 'ROOT' }] }),
    );
    const err = issues.filter((i) => i.code === 'HIERARCHY_ROLE_MISMATCH');
    expect(err.length).toBeGreaterThan(0);
    expect(err[0]?.path).toBe('hierarchyProfile.levels[0].role');
  });

  it('GROUP_TITLE với cây 2 tầng bị chặn — không có tầng GROUP để đọc', () => {
    const issues = validateConfigPayload(
      withProfile({ ...TWO_TIER, phaseSource: { type: 'GROUP_TITLE' } }),
    );
    expect(issues.some((i) => i.code === 'PHASE_SOURCE_NEEDS_GROUP')).toBe(true);
  });

  it('SELF_TITLE_SLOT với tên ô lạ bị chặn', () => {
    const issues = validateConfigPayload(
      withProfile({ ...TWO_TIER, phaseSource: { type: 'SELF_TITLE_SLOT', ref: 'sprint' } }),
    );
    expect(issues.some((i) => i.code === 'PHASE_SLOT_UNKNOWN')).toBe(true);
  });

  it('SELF_TITLE_SLOT cảnh báo khi mẫu Sub-task không chứa ô đó', () => {
    const issues = validateConfigPayload({
      ...GLOBAL,
      subtaskPatterns: [{ patternText: '[{function}]_{task}', sortOrder: 1 }],
      hierarchyProfile: TWO_TIER,
    });
    const w = issues.find((i) => i.code === 'PHASE_SLOT_NOT_IN_PATTERN');
    expect(w?.level).toBe('WARNING');
    expect(hasBlockingError(issues)).toBe(false);
  });

  it('FIELD thiếu tên field bị chặn', () => {
    const issues = validateConfigPayload(
      withProfile({ ...TWO_TIER, phaseSource: { type: 'FIELD' } }),
    );
    expect(issues.some((i) => i.code === 'PHASE_FIELD_REQUIRED')).toBe(true);
  });

  it('FIXED trỏ tới Phase không có trong danh sách bị chặn', () => {
    const issues = validateConfigPayload(
      withProfile({ ...TWO_TIER, phaseSource: { type: 'FIXED', ref: 'MIGRATION' } }),
    );
    expect(issues.some((i) => i.code === 'PHASE_FIXED_CODE_UNDEFINED')).toBe(true);
  });

  it('FIXED trỏ tới Phase có thật thì hợp lệ', () => {
    const issues = validateConfigPayload(
      withProfile({ ...TWO_TIER, phaseSource: { type: 'FIXED', ref: 'DESIGN' } }),
    );
    expect(hasBlockingError(issues)).toBe(false);
  });

  it('GROUP_TITLE với groupLevel ra ngoài dải tầng GROUP bị chặn', () => {
    const issues = validateConfigPayload(
      withProfile({
        levels: [{ role: 'ROOT' }, { role: 'GROUP' }, { role: 'LEAF' }],
        phaseSource: { type: 'GROUP_TITLE', groupLevel: 2 },
        signboard: TWO_TIER.signboard,
      }),
    );
    expect(issues.some((i) => i.code === 'PHASE_GROUP_LEVEL_OUT_OF_RANGE')).toBe(true);
  });

  it('hàng Signboard trỏ tới ô tiêu đề lạ bị chặn', () => {
    const issues = validateConfigPayload(
      withProfile({
        ...TWO_TIER,
        signboard: {
          row: { source: 'TITLE_SLOT', ref: 'assignee' },
          column: { source: 'TITLE_SLOT', ref: 'task' },
        },
      }),
    );
    const err = issues.find((i) => i.code === 'SB_DIMENSION_SLOT_UNKNOWN');
    expect(err?.path).toBe('hierarchyProfile.signboard.row.ref');
  });

  it('hàng/cột Signboard lấy từ FIELD thì không cần là ô tiêu đề', () => {
    const issues = validateConfigPayload(
      withProfile({
        ...TWO_TIER,
        signboard: {
          row: { source: 'FIELD', ref: 'components' },
          column: { source: 'FIELD', ref: 'labels' },
        },
      }),
    );
    expect(hasBlockingError(issues)).toBe(false);
  });
});
