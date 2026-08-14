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

describe('tầng SUBTASK_TITLE_TOKEN — bóc token trong tiêu đề Sub-task', () => {
  const config = mkConfig({
    subtaskPatterns: [{ patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 }],
    tiers: [
      {
        tierOrder: 1,
        code: 'TEAM',
        labelVi: 'Team',
        labelJa: null,
        role: 'PHASE',
        sourceType: 'SUBTASK_TITLE_TOKEN',
        sourceConfig: { token: 'team' },
        definitions: [],
        rules: [],
        titlePatterns: [],
        displayOrder: 0,
      },
    ],
  });

  it('lấy đúng token {team} từ tiêu đề lá', () => {
    const resolver = new GroupKeyResolver(config);
    expect(resolver.resolve({ parentPhase: 'x', leafTitle: '[PAY][TeamA][Design][Login]_Create' })).toEqual({
      groupPath: ['TeamA'],
      phaseCode: 'TeamA',
    });
  });

  it('tiêu đề không khớp mẫu ⇒ token rỗng ⇒ UNCLASSIFIED', () => {
    const resolver = new GroupKeyResolver(config);
    expect(resolver.resolve({ parentPhase: 'x', leafTitle: 'tiêu đề trần' }).phaseCode).toBe('UNCLASSIFIED');
  });

  it('token không hợp lệ ⇒ ném lỗi rõ ràng', () => {
    const bad = mkConfig({
      subtaskPatterns: [{ patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 }],
      tiers: [
        { tierOrder: 1, code: 'X', labelVi: 'X', labelJa: null, role: 'PHASE', sourceType: 'SUBTASK_TITLE_TOKEN', sourceConfig: { token: 'bogus' }, definitions: [], rules: [], titlePatterns: [], displayOrder: 0 },
      ],
    });
    const resolver = new GroupKeyResolver(bad);
    expect(() => resolver.resolve({ parentPhase: 'x', leafTitle: '[PAY][TeamA][Design][Login]_Create' })).toThrow(/không hợp lệ/);
  });
});

describe('tầng LABEL — bóc khoá từ nhãn Jira theo tiền tố', () => {
  const labelTier = (prefix: string | null) =>
    mkConfig({
      tiers: [
        { tierOrder: 1, code: 'TEAM', labelVi: 'Team', labelJa: null, role: 'PHASE', sourceType: 'LABEL', sourceConfig: prefix === null ? null : { prefix }, definitions: [], rules: [], titlePatterns: [], displayOrder: 0 },
      ],
    });

  it('nhãn khớp tiền tố ⇒ cắt tiền tố làm khoá', () => {
    const resolver = new GroupKeyResolver(labelTier('team:'));
    expect(resolver.resolve({ parentPhase: 'x', leafTitle: 'y', leafLabels: ['urgent', 'team:alpha'] })).toEqual({
      groupPath: ['alpha'],
      phaseCode: 'alpha',
    });
  });

  it('không nhãn nào khớp / không có nhãn ⇒ UNCLASSIFIED', () => {
    const resolver = new GroupKeyResolver(labelTier('team:'));
    expect(resolver.resolve({ parentPhase: 'x', leafTitle: 'y', leafLabels: ['urgent'] }).phaseCode).toBe('UNCLASSIFIED');
    expect(resolver.resolve({ parentPhase: 'x', leafTitle: 'y' }).phaseCode).toBe('UNCLASSIFIED');
  });

  it('không khai tiền tố ⇒ lấy nhãn đầu tiên nguyên vẹn', () => {
    const resolver = new GroupKeyResolver(labelTier(null));
    expect(resolver.resolve({ parentPhase: 'x', leafTitle: 'y', leafLabels: ['alpha', 'beta'] }).phaseCode).toBe('alpha');
  });
});

describe('tầng GROUP nguồn PARENT_TASK_TITLE — bóc chiều RIÊNG từ title Task cha', () => {
  /** Kịch bản "giai đoạn": title Task dạng `[{epic}][{team}]TênPhase`, team ánh xạ GĐ. */
  const stageConfig = mkConfig({
    tiers: [
      {
        tierOrder: 1,
        code: 'GIAI_DOAN',
        labelVi: 'Giai đoạn',
        labelJa: null,
        role: 'GROUP',
        sourceType: 'PARENT_TASK_TITLE',
        sourceConfig: null,
        definitions: [],
        rules: [
          { keyword: 'offshore_P1', matchMode: 'CONTAINS', groupCode: 'GD1', matchPriority: 10 },
          { keyword: 'offshore_P2', matchMode: 'CONTAINS', groupCode: 'GD2', matchPriority: 10 },
          // Catch-all: mọi title có "[" — Epic 1 giai đoạn rơi hết về GD1.
          { keyword: '[', matchMode: 'CONTAINS', groupCode: 'GD1', matchPriority: 90 },
        ],
        titlePatterns: [],
        displayOrder: 0,
      },
      {
        tierOrder: 2,
        code: 'PHASE',
        labelVi: 'Phase',
        labelJa: null,
        role: 'PHASE',
        sourceType: 'PARENT_TASK_TITLE',
        sourceConfig: null,
        definitions: [],
        // Tầng ✦PHASE có luật riêng CŨNG bị bỏ qua — phaseCode phải đúng bằng kết
        // quả cấu hình Phase (parentPhase), nếu không Signboard/per_phase lệch nhau.
        rules: [{ keyword: 'BẪY', matchMode: 'CONTAINS', groupCode: 'SAI', matchPriority: 1 }],
        titlePatterns: [],
        displayOrder: 1,
      },
    ],
  });

  it('ánh xạ team → GĐ từ title cha; tầng ✦PHASE vẫn lấy parentPhase', () => {
    const resolver = new GroupKeyResolver(stageConfig);
    expect(
      resolver.resolve({
        parentPhase: 'DESIGN',
        parentTaskTitle: '[PAY][offshore_P1]Design',
        leafTitle: '[PAY][TeamA][Design][Login]_Create',
      }),
    ).toEqual({ groupPath: ['GD1', 'DESIGN'], phaseCode: 'DESIGN' });
    expect(
      resolver.resolve({
        parentPhase: 'DEV',
        parentTaskTitle: '[PAY][offshore_P2]Development',
        leafTitle: 'x',
      }),
    ).toEqual({ groupPath: ['GD2', 'DEV'], phaseCode: 'DEV' });
  });

  it('team không thuộc ánh xạ nào ⇒ rơi catch-all (Epic 1 giai đoạn về GD1, chạy như cũ)', () => {
    const resolver = new GroupKeyResolver(stageConfig);
    expect(
      resolver.resolve({ parentPhase: 'DESIGN', parentTaskTitle: '[CRM][onsite]Design', leafTitle: 'x' }),
    ).toEqual({ groupPath: ['GD1', 'DESIGN'], phaseCode: 'DESIGN' });
  });

  it('mẫu tiêu đề riêng của tầng bóc đúng ngoặc 2 rồi mới áp luật', () => {
    const withPattern = mkConfig({
      tiers: [
        {
          ...stageConfig.tiers![0]!,
          titlePatterns: [{ patternText: '[{project}][{name}]{task}', sortOrder: 1 }],
          rules: [
            { keyword: 'offshore_P1', matchMode: 'CONTAINS', groupCode: 'GD1', matchPriority: 10 },
          ],
        },
        stageConfig.tiers![1]!,
      ],
    });
    const resolver = new GroupKeyResolver(withPattern);
    expect(
      resolver.resolve({ parentPhase: 'DESIGN', parentTaskTitle: '[PAY][offshore_P1]Design', leafTitle: 'x' })
        .groupPath,
    ).toEqual(['GD1', 'DESIGN']);
    // Bóc trúng "offshore_P9" (không khớp luật, KHÔNG có fallback trên chuỗi đã bóc
    // ra được vì extracted ăn trước) ⇒ UNCLASSIFIED — thấy được, không đoán bừa.
    expect(
      resolver.resolve({ parentPhase: 'DESIGN', parentTaskTitle: '[PAY][offshore_P9]Design', leafTitle: 'x' })
        .groupPath[0],
    ).toBe('UNCLASSIFIED');
  });

  it('lá không có Task cha (mồ côi / QUERY) ⇒ tầng GĐ UNCLASSIFIED', () => {
    const resolver = new GroupKeyResolver(stageConfig);
    expect(
      resolver.resolve({ parentPhase: 'UNCLASSIFIED', leafTitle: 'x' }).groupPath[0],
    ).toBe('UNCLASSIFIED');
    expect(
      resolver.resolve({ parentPhase: 'UNCLASSIFIED', parentTaskTitle: null, leafTitle: 'x' }).groupPath[0],
    ).toBe('UNCLASSIFIED');
  });
});

describe('nguồn khoá chưa hỗ trợ — fail-fast', () => {
  it('CUSTOM_FIELD (để v2) ném lỗi rõ ràng', () => {
    const config = mkConfig({
      tiers: [
        {
          tierOrder: 1,
          code: 'TEAM',
          labelVi: 'Team',
          labelJa: null,
          role: 'PHASE',
          sourceType: 'CUSTOM_FIELD',
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
