import { describe, expect, it } from 'vitest';
import { deriveDefaultTiersFromPhase } from './group-config.js';

/**
 * `deriveDefaultTiersFromPhase` là cầu nối Vòng 1: mô hình 3 tầng hôm nay = cấu hình
 * có ĐÚNG một tầng nhóm (role=PHASE, source=PARENT_TASK_TITLE). Hàm thuần — test không
 * cần DB. Cùng nguồn dùng cho repository (mirror lúc lưu), migration (backfill), và seed.
 */
describe('deriveDefaultTiersFromPhase', () => {
  it('sinh đúng MỘT tầng Phase mirror từ phase config', () => {
    const tiers = deriveDefaultTiersFromPhase({
      titlePatterns: [{ patternText: '[Phase] {name}', sortOrder: 1 }],
      phaseDefinitions: [
        { phaseCode: 'DESIGN', labelVi: 'Thiết kế', labelJa: '設計', colorHex: '#123456', displayOrder: 1 },
        { phaseCode: 'DEV', labelVi: 'Phát triển', displayOrder: 2 },
      ],
      matchRules: [{ keyword: 'design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 10 }],
    });

    expect(tiers).toHaveLength(1);
    const tier = tiers[0]!;
    expect(tier).toMatchObject({
      tierOrder: 1,
      code: 'PHASE',
      role: 'PHASE',
      sourceType: 'PARENT_TASK_TITLE',
      displayOrder: 0,
    });
    // phase_definition → definitions (đổi phaseCode → groupCode); vắng label/màu → null.
    expect(tier.definitions).toEqual([
      { groupCode: 'DESIGN', labelVi: 'Thiết kế', labelJa: '設計', colorHex: '#123456', displayOrder: 1 },
      { groupCode: 'DEV', labelVi: 'Phát triển', labelJa: null, colorHex: null, displayOrder: 2 },
    ]);
    // phase_match_rule → rules (phaseCode → groupCode).
    expect(tier.rules).toEqual([
      { keyword: 'design', matchMode: 'CONTAINS', groupCode: 'DESIGN', matchPriority: 10 },
    ]);
    expect(tier.titlePatterns).toEqual([{ patternText: '[Phase] {name}', sortOrder: 1 }]);
  });

  it('config rỗng vẫn cho một tầng Phase (không có giá trị)', () => {
    const tiers = deriveDefaultTiersFromPhase({ titlePatterns: [], phaseDefinitions: [], matchRules: [] });
    expect(tiers).toHaveLength(1);
    expect(tiers[0]!.definitions).toEqual([]);
    expect(tiers[0]!.rules).toEqual([]);
    expect(tiers[0]!.titlePatterns).toEqual([]);
  });
});
