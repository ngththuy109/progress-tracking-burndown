import { describe, it, expect } from 'vitest';
import type { GroupTier } from '@app/shared';
import {
  isTierDirty,
  loadTierDraft,
  newTier,
  phaseTierCount,
  tierReducer,
  type TierDraft,
} from './tier-draft.js';

const phaseTier = (over: Partial<GroupTier> = {}): GroupTier => ({
  ...newTier('PHASE'),
  code: 'PHASE',
  labelVi: 'Phase',
  ...over,
});

const load = (tiers: GroupTier[]): TierDraft => loadTierDraft(tiers);

describe('tierReducer — danh sách tầng', () => {
  it('ADD/REMOVE/MOVE đánh số lại tierOrder + displayOrder theo vị trí', () => {
    let s = load([phaseTier()]);
    s = tierReducer(s, { type: 'ADD_TIER' });
    expect(s.tiers.map((t) => t.tierOrder)).toEqual([1, 2]);
    expect(s.tiers.map((t) => t.displayOrder)).toEqual([0, 1]);

    s = tierReducer(s, { type: 'MOVE_TIER', index: 0, delta: 1 });
    expect(s.tiers[0]!.code).toBe(''); // tầng GROUP mới lên đầu
    expect(s.tiers.map((t) => t.tierOrder)).toEqual([1, 2]);

    s = tierReducer(s, { type: 'REMOVE_TIER', index: 0 });
    expect(s.tiers).toHaveLength(1);
    expect(s.tiers[0]!.tierOrder).toBe(1);
  });

  it('SET_PHASE_TIER giữ ĐÚNG một tầng role=PHASE', () => {
    let s = load([phaseTier({ code: 'A' }), { ...newTier('GROUP'), code: 'B' }]);
    expect(phaseTierCount(s)).toBe(1);
    s = tierReducer(s, { type: 'SET_PHASE_TIER', index: 1 });
    expect(phaseTierCount(s)).toBe(1);
    expect(s.tiers[0]!.role).toBe('GROUP');
    expect(s.tiers[1]!.role).toBe('PHASE');
  });

  it('SET_SOURCE_CONFIG đặt rồi xoá khoá; hết khoá ⇒ sourceConfig null', () => {
    let s = load([phaseTier({ sourceType: 'SUBTASK_TITLE_TOKEN' })]);
    s = tierReducer(s, { type: 'SET_SOURCE_CONFIG', index: 0, key: 'token', value: 'team' });
    expect(s.tiers[0]!.sourceConfig).toEqual({ token: 'team' });
    s = tierReducer(s, { type: 'SET_SOURCE_CONFIG', index: 0, key: 'token', value: '' });
    expect(s.tiers[0]!.sourceConfig).toBeNull();
  });
});

describe('tierReducer — con của tầng (definitions/rules/patterns)', () => {
  it('ADD_DEF/UPDATE_DEF và đánh số displayOrder', () => {
    let s = load([phaseTier()]);
    s = tierReducer(s, { type: 'ADD_DEF', tier: 0 });
    s = tierReducer(s, { type: 'ADD_DEF', tier: 0 });
    expect(s.tiers[0]!.definitions.map((d) => d.displayOrder)).toEqual([1, 2]);
    s = tierReducer(s, { type: 'UPDATE_DEF', tier: 0, index: 0, patch: { groupCode: 'DESIGN' } });
    expect(s.tiers[0]!.definitions[0]!.groupCode).toBe('DESIGN');
  });

  it('ADD_RULE/UPDATE_RULE giữ matchPriority người dùng đặt', () => {
    let s = load([phaseTier()]);
    s = tierReducer(s, { type: 'ADD_RULE', tier: 0 });
    s = tierReducer(s, { type: 'UPDATE_RULE', tier: 0, index: 0, patch: { keyword: 'design', groupCode: 'DESIGN', matchPriority: 10 } });
    expect(s.tiers[0]!.rules[0]).toMatchObject({ keyword: 'design', groupCode: 'DESIGN', matchPriority: 10 });
  });

  it('UPDATE_RULE đổi được matchMode (mặc định CONTAINS → REGEX, siết ^…$)', () => {
    let s = load([phaseTier()]);
    s = tierReducer(s, { type: 'ADD_RULE', tier: 0 });
    expect(s.tiers[0]!.rules[0]!.matchMode).toBe('CONTAINS');
    s = tierReducer(s, { type: 'UPDATE_RULE', tier: 0, index: 0, patch: { keyword: '^offshore_P1$', matchMode: 'REGEX' } });
    expect(s.tiers[0]!.rules[0]).toMatchObject({ keyword: '^offshore_P1$', matchMode: 'REGEX' });
  });
});

describe('trạng thái nháp', () => {
  it('isTierDirty false lúc nạp, true sau khi sửa, false lại sau COMMIT', () => {
    let s = load([phaseTier()]);
    expect(isTierDirty(s)).toBe(false);
    s = tierReducer(s, { type: 'ADD_TIER' });
    expect(isTierDirty(s)).toBe(true);
    s = tierReducer(s, { type: 'COMMIT' });
    expect(isTierDirty(s)).toBe(false);
  });
});
