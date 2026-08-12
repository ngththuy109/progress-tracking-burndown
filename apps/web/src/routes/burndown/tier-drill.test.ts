import { describe, it, expect } from 'vitest';
import type { TierSeries } from '@app/shared';
import { childrenOf, hasChildren } from './tier-drill.js';

const node = (groupPath: string[]): TierSeries => ({
  key: JSON.stringify(groupPath),
  label: groupPath[groupPath.length - 1] ?? '',
  colorHex: null,
  groupPath,
  tierOrder: groupPath.length,
  points: [],
});

// SA·(DESIGN,DEV) / SB·(DESIGN)
const TIERS = [
  node(['SA']),
  node(['SB']),
  node(['SA', 'DESIGN']),
  node(['SA', 'DEV']),
  node(['SB', 'DESIGN']),
];

describe('childrenOf', () => {
  it('gốc [] ⇒ các nút tầng 1', () => {
    expect(childrenOf(TIERS, []).map((s) => s.groupPath)).toEqual([['SA'], ['SB']]);
  });

  it('[SA] ⇒ con trực tiếp [SA,DESIGN], [SA,DEV] (không lấy nút SB)', () => {
    expect(childrenOf(TIERS, ['SA']).map((s) => s.groupPath)).toEqual([
      ['SA', 'DESIGN'],
      ['SA', 'DEV'],
    ]);
  });

  it('nút lá ⇒ không con', () => {
    expect(childrenOf(TIERS, ['SA', 'DESIGN'])).toEqual([]);
  });
});

describe('hasChildren', () => {
  it('nút còn con ▸', () => {
    expect(hasChildren(TIERS, ['SA'])).toBe(true);
  });
  it('nút lá không con', () => {
    expect(hasChildren(TIERS, ['SA', 'DESIGN'])).toBe(false);
  });
});
