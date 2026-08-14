import { describe, it, expect } from 'vitest';
import type { TierSeries } from '@app/shared';
import { baseDrillPath, childrenOf, hasChildren } from './tier-drill.js';

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

describe('baseDrillPath — tự bỏ qua cấp chỉ có một nút', () => {
  it('≥2 nút tầng 1 (Epic 2 giai đoạn) ⇒ bắt đầu từ gốc, thấy cấp GĐ', () => {
    expect(baseDrillPath(TIERS)).toEqual([]);
  });

  it('1 nút tầng 1 có con (Epic 1 giai đoạn, catch-all GD1) ⇒ nhảy thẳng vào nút đó', () => {
    const oneStage = [
      node(['GD1']),
      node(['GD1', 'DESIGN']),
      node(['GD1', 'DEV']),
    ];
    expect(baseDrillPath(oneStage)).toEqual(['GD1']);
  });

  it('tụt qua NHIỀU cấp đơn độc liên tiếp, dừng ở cấp có ≥2 nút', () => {
    const deep = [
      node(['GD1']),
      node(['GD1', 'STREAM']),
      node(['GD1', 'STREAM', 'DESIGN']),
      node(['GD1', 'STREAM', 'DEV']),
    ];
    expect(baseDrillPath(deep)).toEqual(['GD1', 'STREAM']);
  });

  it('dừng TRƯỚC nút lá đơn độc — vẫn còn một nút để vẽ biểu đồ', () => {
    const single = [node(['GD1']), node(['GD1', 'DESIGN'])];
    expect(baseDrillPath(single)).toEqual(['GD1']);
    expect(childrenOf(single, ['GD1']).map((s) => s.groupPath)).toEqual([['GD1', 'DESIGN']]);
  });

  it('chuỗi rỗng ⇒ gốc', () => {
    expect(baseDrillPath([])).toEqual([]);
  });
});
