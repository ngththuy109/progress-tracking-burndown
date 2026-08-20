import type {
  GroupSourceType,
  GroupTier,
  GroupTierDefinition,
  GroupTierRule,
  GroupTierTitlePattern,
} from '@app/shared';

/**
 * Trạng thái nháp cho màn "Cấu trúc tầng" — thuần, KHÔNG React.
 *
 * Tách khỏi `config-phase/draft-state.ts`: tầng nhóm là chiều cấu hình riêng, nhồi
 * chung sẽ làm reducer Phase phình ra những action nó không bao giờ dùng. Màn tầng
 * chạy trên GLOBAL (single-tenant = một cấu hình), nên không có kế thừa để lo.
 *
 * Mọi thay đổi danh sách đều ĐÁNH SỐ LẠI (`tierOrder`/`displayOrder`/`sortOrder`) để
 * thứ tự luôn khớp vị trí hiển thị — không để lỗ hổng số thứ tự.
 */

export interface TierDraft {
  readonly tiers: readonly GroupTier[];
  /** Ảnh chụp lúc nạp, để biết "có thay đổi chưa lưu". */
  readonly base: readonly GroupTier[];
}

export type TierAction =
  | { type: 'ADD_TIER' }
  | { type: 'REMOVE_TIER'; index: number }
  | { type: 'MOVE_TIER'; index: number; delta: number }
  | {
      type: 'UPDATE_TIER';
      index: number;
      patch: Partial<Pick<GroupTier, 'code' | 'labelVi' | 'labelJa' | 'sourceType'>>;
    }
  | { type: 'SET_PHASE_TIER'; index: number }
  | { type: 'SET_SOURCE_CONFIG'; index: number; key: string; value: string }
  | { type: 'ADD_DEF'; tier: number }
  | { type: 'REMOVE_DEF'; tier: number; index: number }
  | { type: 'UPDATE_DEF'; tier: number; index: number; patch: Partial<GroupTierDefinition> }
  | { type: 'ADD_RULE'; tier: number }
  | { type: 'REMOVE_RULE'; tier: number; index: number }
  | { type: 'UPDATE_RULE'; tier: number; index: number; patch: Partial<GroupTierRule> }
  | { type: 'ADD_PATTERN'; tier: number }
  | { type: 'REMOVE_PATTERN'; tier: number; index: number }
  | { type: 'UPDATE_PATTERN'; tier: number; index: number; patch: Partial<GroupTierTitlePattern> }
  | { type: 'REPLACE_TIERS'; tiers: readonly GroupTier[] }
  | { type: 'COMMIT' };

// --- factory ---------------------------------------------------------------

export function newTier(role: GroupTier['role'] = 'GROUP'): GroupTier {
  return {
    tierOrder: 0,
    code: '',
    labelVi: '',
    labelJa: null,
    role,
    sourceType: 'PARENT_TASK_TITLE',
    sourceConfig: null,
    definitions: [],
    rules: [],
    titlePatterns: [],
    displayOrder: 0,
  };
}

const newDef = (): GroupTierDefinition => ({ groupCode: '', labelVi: '', labelJa: null, colorHex: null, displayOrder: 0 });
const newRule = (): GroupTierRule => ({ keyword: '', matchMode: 'CONTAINS', groupCode: '', matchPriority: 50 });
const newPattern = (): GroupTierTitlePattern => ({ patternText: '', sortOrder: 0 });

// --- tiện ích bất biến ------------------------------------------------------

const replaceAt = <T>(arr: readonly T[], i: number, fn: (v: T) => T): T[] =>
  arr.map((v, idx) => (idx === i ? fn(v) : v));
const removeAt = <T>(arr: readonly T[], i: number): T[] => arr.filter((_, idx) => idx !== i);
const move = <T>(arr: readonly T[], i: number, delta: number): T[] => {
  const j = i + delta;
  if (j < 0 || j >= arr.length) return [...arr];
  const copy = [...arr];
  const [it] = copy.splice(i, 1);
  copy.splice(j, 0, it!);
  return copy;
};

/** Đánh số lại tầng theo vị trí (tierOrder 1..n, displayOrder 0..n-1). */
const renumberTiers = (tiers: readonly GroupTier[]): GroupTier[] =>
  tiers.map((t, i) => ({ ...t, tierOrder: i + 1, displayOrder: i }));
const renumberDefs = (defs: readonly GroupTierDefinition[]): GroupTierDefinition[] =>
  defs.map((d, i) => ({ ...d, displayOrder: i + 1 }));
const renumberPatterns = (ps: readonly GroupTierTitlePattern[]): GroupTierTitlePattern[] =>
  ps.map((p, i) => ({ ...p, sortOrder: i + 1 }));

/** Sửa MỘT tầng qua callback rồi giữ nguyên phần còn lại. */
const editTier = (state: TierDraft, tier: number, fn: (t: GroupTier) => GroupTier): TierDraft => ({
  ...state,
  tiers: replaceAt(state.tiers, tier, fn),
});

export function loadTierDraft(tiers: readonly GroupTier[]): TierDraft {
  const normalized = renumberTiers(tiers);
  return { tiers: normalized, base: normalized };
}

export function isTierDirty(state: TierDraft): boolean {
  return JSON.stringify(state.tiers) !== JSON.stringify(state.base);
}

export function tierReducer(state: TierDraft, action: TierAction): TierDraft {
  switch (action.type) {
    case 'ADD_TIER':
      return { ...state, tiers: renumberTiers([...state.tiers, newTier()]) };
    case 'REMOVE_TIER':
      return { ...state, tiers: renumberTiers(removeAt(state.tiers, action.index)) };
    case 'MOVE_TIER':
      return { ...state, tiers: renumberTiers(move(state.tiers, action.index, action.delta)) };
    case 'UPDATE_TIER':
      return editTier(state, action.index, (t) => ({ ...t, ...action.patch }));
    case 'SET_PHASE_TIER':
      // Bất biến quyết định #3: ĐÚNG một tầng role=PHASE. Đặt tầng này PHASE, còn lại GROUP.
      return { ...state, tiers: state.tiers.map((t, i) => ({ ...t, role: i === action.index ? 'PHASE' : 'GROUP' })) };
    case 'SET_SOURCE_CONFIG':
      return editTier(state, action.index, (t) => {
        const next = { ...(t.sourceConfig ?? {}), [action.key]: action.value };
        // Ô rỗng ⇒ bỏ khoá; hết khoá ⇒ sourceConfig = null (không lưu object rỗng).
        if (action.value === '') delete next[action.key];
        return { ...t, sourceConfig: Object.keys(next).length === 0 ? null : next };
      });
    case 'ADD_DEF':
      return editTier(state, action.tier, (t) => ({ ...t, definitions: renumberDefs([...t.definitions, newDef()]) }));
    case 'REMOVE_DEF':
      return editTier(state, action.tier, (t) => ({ ...t, definitions: renumberDefs(removeAt(t.definitions, action.index)) }));
    case 'UPDATE_DEF':
      return editTier(state, action.tier, (t) => ({
        ...t,
        definitions: replaceAt(t.definitions, action.index, (d) => ({ ...d, ...action.patch })),
      }));
    case 'ADD_RULE':
      return editTier(state, action.tier, (t) => ({ ...t, rules: [...t.rules, newRule()] }));
    case 'REMOVE_RULE':
      return editTier(state, action.tier, (t) => ({ ...t, rules: removeAt(t.rules, action.index) }));
    case 'UPDATE_RULE':
      return editTier(state, action.tier, (t) => ({
        ...t,
        rules: replaceAt(t.rules, action.index, (r) => ({ ...r, ...action.patch })),
      }));
    case 'ADD_PATTERN':
      return editTier(state, action.tier, (t) => ({ ...t, titlePatterns: renumberPatterns([...t.titlePatterns, newPattern()]) }));
    case 'REMOVE_PATTERN':
      return editTier(state, action.tier, (t) => ({ ...t, titlePatterns: renumberPatterns(removeAt(t.titlePatterns, action.index)) }));
    case 'UPDATE_PATTERN':
      return editTier(state, action.tier, (t) => ({
        ...t,
        titlePatterns: replaceAt(t.titlePatterns, action.index, (p) => ({ ...p, ...action.patch })),
      }));
    case 'REPLACE_TIERS':
      // Áp preset "kiểu cấu hình" (3 tầng / 2 tầng / phẳng) — thay cả danh sách.
      return { ...state, tiers: renumberTiers(action.tiers) };
    case 'COMMIT':
      return { ...state, base: state.tiers };
    default:
      return state;
  }
}

/** Số tầng đang được đánh dấu là Phase — 1 là hợp lệ (bất biến quyết định #3). */
export function phaseTierCount(state: TierDraft): number {
  return state.tiers.filter((t) => t.role === 'PHASE').length;
}

/**
 * Ba "kiểu cấu hình" dựng sẵn (demo đã chốt) — điểm khởi đầu, sửa tiếp được.
 * "3 tầng" = mô hình mặc định (một tầng Phase từ Task cha); "2 tầng"/"phẳng" bóc
 * khoá từ CHÍNH tiêu đề ticket (SELF_TITLE) — DYNAMIC-TIERS-DESIGN.md §2.4–2.5.
 */
export const TIER_PRESETS: readonly {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly build: () => GroupTier[];
}[] = [
  {
    id: 'THREE',
    label: '3-level (Epic → Phase → Sub-task)',
    hint: 'Default: one Phase tier, key parsed from the parent Task title.',
    build: () => [{ ...newTier('PHASE'), code: 'PHASE', labelVi: 'Phase', sourceType: 'PARENT_TASK_TITLE' }],
  },
  {
    id: 'TWO',
    label: '2-level (Task → Sub-task)',
    hint: 'Tasks act as the Project; Phase is parsed from the Sub-task’s OWN title.',
    build: () => [{ ...newTier('PHASE'), code: 'PHASE', labelVi: 'Phase', sourceType: 'SELF_TITLE' }],
  },
  {
    id: 'FLAT',
    label: 'Flat (one basket of Tasks)',
    hint: 'No hierarchy: Project / Phase / Sub-phase are all parsed from the ticket title.',
    build: () => [
      { ...newTier('GROUP'), code: 'PROJECT', labelVi: 'Project', sourceType: 'SELF_TITLE' },
      { ...newTier('PHASE'), code: 'PHASE', labelVi: 'Phase', sourceType: 'SELF_TITLE' },
      { ...newTier('GROUP'), code: 'SUBPHASE', labelVi: 'Sub-phase', sourceType: 'SELF_TITLE' },
    ],
  },
];

/** Nguồn khoá cần tham số phụ (sourceConfig) — quyết định ô nhập nào hiện ra. */
export function sourceNeedsToken(source: GroupSourceType): boolean {
  return source === 'SUBTASK_TITLE_TOKEN';
}
export function sourceNeedsLabelPrefix(source: GroupSourceType): boolean {
  return source === 'LABEL';
}
