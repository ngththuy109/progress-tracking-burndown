import { describe, it, expect } from 'vitest';
import type { ConfigPayload, EffectiveConfig, GroupTier } from '@app/shared';
import { GroupKeyResolver } from './resolve-group-keys.js';

/**
 * `GroupKeyResolver` suy vectơ `group_path` của lá từ cấu hình tầng
 * (DYNAMIC-TIERS-DESIGN.md §5–6).
 *
 * BẤT BIẾN then chốt: config mặc định (vắng `tiers`) = một tầng PHASE/PARENT_TASK_TITLE,
 * lấy THẲNG `parentPhase` ⇒ `group_path = [phaseCode]` — đúng `phase_code` hôm nay.
 */

const mkConfig = (over: Partial<ConfigPayload> = {}): EffectiveConfig => ({
  fallbackScanFullTitle: true,
  titlePatterns: [],
  subtaskPatterns: [],
  phaseDefinitions: [{ phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 1 }],
  matchRules: [],
  signboardColumns: [],
  subPhaseOrders: [],
  ...over,
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
});

/** Tầng SELF_TITLE dựa quét từ khoá trên TOÀN tiêu đề lá (titlePatterns rỗng + fallback). */
const selfTier = (
  over: Partial<GroupTier> & Pick<GroupTier, 'tierOrder' | 'code' | 'role' | 'rules'>,
): GroupTier => ({
  labelVi: over.code,
  labelJa: null,
  sourceType: 'SELF_TITLE',
  sourceConfig: null,
  definitions: [],
  titlePatterns: [],
  displayOrder: 0,
  ...over,
});

describe('config mặc định — một tầng PHASE/PARENT_TASK_TITLE lấy thẳng parentPhase', () => {
  it('groupPath = [parentPhase], phaseCode = parentPhase (leafTitle bị bỏ qua)', () => {
    const resolver = new GroupKeyResolver(mkConfig());
    expect(resolver.resolve({ parentPhase: 'DESIGN', leafTitle: 'bất kỳ chữ gì' })).toEqual({
      groupPath: ['DESIGN'],
      phaseCode: 'DESIGN',
    });
  });

  it('parentPhase = UNCLASSIFIED giữ nguyên (không đoán bừa)', () => {
    const resolver = new GroupKeyResolver(mkConfig());
    expect(resolver.resolve({ parentPhase: 'UNCLASSIFIED', leafTitle: 'x' })).toEqual({
      groupPath: ['UNCLASSIFIED'],
      phaseCode: 'UNCLASSIFIED',
    });
  });
});

describe('tầng SELF_TITLE — bóc khoá từ CHÍNH tiêu đề lá (project 2 tầng §2.4)', () => {
  const config = mkConfig({
    tiers: [
      selfTier({
        tierOrder: 1,
        code: 'PHASE',
        role: 'PHASE',
        rules: [
          { keyword: 'design', matchMode: 'CONTAINS', groupCode: 'DESIGN', matchPriority: 10 },
          { keyword: 'dev', matchMode: 'CONTAINS', groupCode: 'DEV', matchPriority: 10 },
        ],
      }),
    ],
  });

  it('parse tiêu đề lá, KHÔNG dùng parentPhase', () => {
    const resolver = new GroupKeyResolver(config);
    expect(resolver.resolve({ parentPhase: 'BỎ_QUA', leafTitle: '[Design] Vẽ màn hình' })).toEqual({
      groupPath: ['DESIGN'],
      phaseCode: 'DESIGN',
    });
    expect(resolver.resolve({ parentPhase: 'BỎ_QUA', leafTitle: '[Dev] API giao dịch' })).toEqual({
      groupPath: ['DEV'],
      phaseCode: 'DEV',
    });
  });

  it('không khớp luật nào ⇒ UNCLASSIFIED', () => {
    const resolver = new GroupKeyResolver(config);
    expect(resolver.resolve({ parentPhase: 'x', leafTitle: 'không có từ khoá phase' }).phaseCode).toBe(
      'UNCLASSIFIED',
    );
  });
});

describe('nhiều tầng — phaseCode lấy đúng tầng role=PHASE (project phẳng §2.5)', () => {
  it('groupPath theo tierOrder; phaseCode = phần tử tầng Phase (không phải tầng 1)', () => {
    const config = mkConfig({
      tiers: [
        selfTier({
          tierOrder: 1,
          code: 'PROJECT',
          role: 'GROUP',
          rules: [
            { keyword: 'pay', matchMode: 'CONTAINS', groupCode: 'PAY', matchPriority: 10 },
            { keyword: 'ins', matchMode: 'CONTAINS', groupCode: 'INS', matchPriority: 10 },
          ],
        }),
        selfTier({
          tierOrder: 2,
          code: 'PHASE',
          role: 'PHASE',
          rules: [{ keyword: 'design', matchMode: 'CONTAINS', groupCode: 'DESIGN', matchPriority: 10 }],
        }),
      ],
    });
    const resolver = new GroupKeyResolver(config);
    expect(resolver.resolve({ parentPhase: 'x', leafTitle: '[PAY][Design] Thanh toán' })).toEqual({
      groupPath: ['PAY', 'DESIGN'],
      phaseCode: 'DESIGN',
    });
  });

  it('tôn trọng tierOrder kể cả khi khai lộn xộn', () => {
    const config = mkConfig({
      tiers: [
        selfTier({ tierOrder: 2, code: 'PHASE', role: 'PHASE', rules: [{ keyword: 'design', matchMode: 'CONTAINS', groupCode: 'DESIGN', matchPriority: 10 }] }),
        selfTier({ tierOrder: 1, code: 'PROJECT', role: 'GROUP', rules: [{ keyword: 'pay', matchMode: 'CONTAINS', groupCode: 'PAY', matchPriority: 10 }] }),
      ],
    });
    const resolver = new GroupKeyResolver(config);
    expect(resolver.resolve({ parentPhase: 'x', leafTitle: '[PAY][Design]' }).groupPath).toEqual(['PAY', 'DESIGN']);
  });
});

describe('nguồn khoá chưa hỗ trợ ở Vòng 2 — fail-fast', () => {
  it('LABEL / SUBTASK_TITLE_TOKEN / CUSTOM_FIELD ném lỗi rõ ràng', () => {
    const config = mkConfig({
      tiers: [
        {
          tierOrder: 1,
          code: 'TEAM',
          labelVi: 'Team',
          labelJa: null,
          role: 'PHASE',
          sourceType: 'LABEL',
          sourceConfig: null,
          definitions: [],
          rules: [],
          titlePatterns: [],
          displayOrder: 0,
        },
      ],
    });
    const resolver = new GroupKeyResolver(config);
    expect(() => resolver.resolve({ parentPhase: 'x', leafTitle: 'y' })).toThrow(/chưa hỗ trợ/);
  });
});
