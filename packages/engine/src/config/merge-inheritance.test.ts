import { describe, it, expect } from 'vitest';
import type { ConfigPayload } from '@app/shared';
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
  signboardColumns: [{ taskCode: 'Create', labelVi: 'Tạo mới', side: 'VN', displayOrder: 1 }],
  subPhaseOrders: [],
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
      subPhaseOrders: true,
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
          { taskCode: 'Create', labelVi: 'Tạo mới', side: 'VN', displayOrder: 1 },
          { taskCode: 'Create', labelVi: 'Tạo lại', side: 'VN', displayOrder: 2 },
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'DUPLICATE_TASK_CODE')).toBe(true);
  });

  it('chặn lưu khi một Sub-phase khai hai lần cho cùng Phase — kể cả khác hoa/thường', () => {
    // `FUT_TC` và `fut_tc` chuẩn hoá về cùng khoá (E-31) — hai dòng là mơ hồ.
    const issues = validateConfigPayload(
      withRules({
        subPhaseOrders: [
          { phaseCode: 'DESIGN', subPhaseCode: 'FUT_TC', displayOrder: 1 },
          { phaseCode: 'design', subPhaseCode: 'fut_tc', displayOrder: 2 },
        ],
      }),
    );
    const dup = issues.find((i) => i.code === 'DUPLICATE_SUB_PHASE');
    expect(dup).toBeDefined();
    expect(dup?.path).toBe('subPhaseOrders[1].subPhaseCode');
    expect(hasBlockingError(issues)).toBe(true);
  });

  it('Sub-phase trỏ tới Phase không có trong danh sách chỉ CẢNH BÁO, vẫn cho lưu', () => {
    const issues = validateConfigPayload(
      withRules({
        subPhaseOrders: [{ phaseCode: 'MIGRATION', subPhaseCode: 'round1', displayOrder: 1 }],
      }),
    );
    const warn = issues.find((i) => i.code === 'SUB_PHASE_UNKNOWN_PHASE');
    expect(warn?.level).toBe('WARNING');
    expect(hasBlockingError(issues)).toBe(false);
  });

  it('cùng mã Sub-phase ở HAI Phase khác nhau là hợp lệ, không phải trùng', () => {
    const issues = validateConfigPayload(
      withRules({
        subPhaseOrders: [
          { phaseCode: 'DESIGN', subPhaseCode: 'round1', displayOrder: 1 },
          { phaseCode: 'DEV', subPhaseCode: 'round1', displayOrder: 1 },
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'DUPLICATE_SUB_PHASE')).toBe(false);
  });
});

describe('tầng nhóm (dynamic tiers) — kế thừa + hợp lệ', () => {
  const phaseTier = (over: Partial<import('@app/shared').GroupTier> = {}): import('@app/shared').GroupTier => ({
    tierOrder: 1,
    code: 'PHASE',
    labelVi: 'Phase',
    labelJa: null,
    role: 'PHASE',
    sourceType: 'PARENT_TASK_TITLE',
    sourceConfig: null,
    definitions: [{ groupCode: 'DESIGN', labelVi: 'Thiết kế', labelJa: null, colorHex: null, displayOrder: 1 }],
    rules: [{ keyword: 'design', matchMode: 'CONTAINS', groupCode: 'DESIGN', matchPriority: 10 }],
    titlePatterns: [],
    displayOrder: 0,
    ...over,
  });

  it('mergeInheritance mang theo tiers của GLOBAL khi project không khai', () => {
    const tiers = [phaseTier()];
    const eff = mergeInheritance({ ...GLOBAL, tiers }, null, V);
    expect(eff.tiers).toEqual(tiers);
  });

  it('project khai tiers thì thắng GLOBAL', () => {
    const gTiers = [phaseTier({ code: 'PHASE_G' })];
    const pTiers = [phaseTier({ code: 'PHASE_P' })];
    const eff = mergeInheritance(
      { ...GLOBAL, tiers: gTiers },
      { projectKey: 'SHOP', tiers: pTiers },
      { globalVersion: 3, projectVersion: 1 },
    );
    expect(eff.tiers).toEqual(pTiers);
  });

  it('cả hai đều không có tiers ⇒ KHÔNG có khoá tiers (không trả [] rỗng)', () => {
    const eff = mergeInheritance(GLOBAL, null, V);
    expect('tiers' in eff).toBe(false);
  });

  it('payload không khai tiers ⇒ validate bỏ qua luật tầng (mirror luôn hợp lệ)', () => {
    const issues = validateConfigPayload(GLOBAL);
    expect(issues.some((i) => i.code.startsWith('NO_PHASE_TIER') || i.code === 'MULTIPLE_PHASE_TIERS')).toBe(false);
  });

  it('ERROR khi KHÔNG có tầng role=PHASE', () => {
    const issues = validateConfigPayload({ ...GLOBAL, tiers: [phaseTier({ role: 'GROUP' })] });
    const e = issues.find((i) => i.code === 'NO_PHASE_TIER');
    expect(e?.level).toBe('ERROR');
    expect(hasBlockingError(issues)).toBe(true);
  });

  it('ERROR khi có HAI tầng role=PHASE', () => {
    const issues = validateConfigPayload({
      ...GLOBAL,
      tiers: [phaseTier({ tierOrder: 1, code: 'A' }), phaseTier({ tierOrder: 2, code: 'B' })],
    });
    expect(issues.find((i) => i.code === 'MULTIPLE_PHASE_TIERS')?.level).toBe('ERROR');
  });

  it('ERROR khi trùng mã tầng hoặc trùng tierOrder', () => {
    const dupCode = validateConfigPayload({
      ...GLOBAL,
      tiers: [phaseTier({ tierOrder: 1, code: 'X', role: 'PHASE' }), phaseTier({ tierOrder: 2, code: 'X', role: 'GROUP' })],
    });
    expect(dupCode.some((i) => i.code === 'DUPLICATE_TIER_CODE')).toBe(true);

    const dupOrder = validateConfigPayload({
      ...GLOBAL,
      tiers: [phaseTier({ tierOrder: 1, code: 'X', role: 'PHASE' }), phaseTier({ tierOrder: 1, code: 'Y', role: 'GROUP' })],
    });
    expect(dupOrder.some((i) => i.code === 'DUPLICATE_TIER_ORDER')).toBe(true);
  });

  it('WARNING (không chặn) khi luật trỏ vào group không khai', () => {
    const issues = validateConfigPayload({
      ...GLOBAL,
      tiers: [phaseTier({ rules: [{ keyword: 'x', matchMode: 'CONTAINS', groupCode: 'GHOST', matchPriority: 10 }] })],
    });
    const w = issues.find((i) => i.code === 'ORPHAN_GROUP_CODE');
    expect(w?.level).toBe('WARNING');
    expect(hasBlockingError(issues)).toBe(false);
  });
});
