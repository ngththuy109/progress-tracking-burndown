import { describe, expect, it } from 'vitest';
import {
  draftError,
  draftToPayload,
  EMPTY_DRAFT,
  RESYNC_MODES,
  type ResyncDraft,
} from './resync-modes.js';

const draft = (over: Partial<ResyncDraft> = {}): ResyncDraft => ({ ...EMPTY_DRAFT, ...over });

describe('ba mức đồng bộ lại', () => {
  it('có đúng ba mức, khớp bảng trong runbook', () => {
    expect(RESYNC_MODES.map((m) => m.mode)).toEqual(['QUICK', 'FULL', 'RANGE']);
  });

  it('mức rẻ đứng trước mức đắt', () => {
    // Người đọc từ trên xuống phải gặp mức đủ dùng trước khi gặp mức tốn kém.
    expect(RESYNC_MODES[0]?.mode).toBe('QUICK');
    expect(RESYNC_MODES.at(-1)?.mode).toBe('RANGE');
  });

  it('mỗi mức có câu mô tả đủ để chọn mà không cần mở runbook', () => {
    for (const m of RESYNC_MODES) {
      expect(m.detail.length).toBeGreaterThan(40);
    }
  });

  it('mức Toàn bộ nói rõ cái giá của nó', () => {
    const full = RESYNC_MODES.find((m) => m.mode === 'FULL');
    expect(full?.detail).toContain('shared Jira rate limit');
  });
});

describe('mức mặc định', () => {
  it('mặc định là mức RẺ NHẤT, không phải Toàn bộ', () => {
    // Mặc định "Toàn bộ" thì người vội bấm Enter sẽ vô tình ngốn hạn mức gọi
    // Jira của cả hệ thống (R-04).
    expect(EMPTY_DRAFT.mode).toBe('QUICK');
    expect(draftToPayload(EMPTY_DRAFT)).toEqual({ from: null, to: null, full: false });
  });
});

describe('thân yêu cầu gửi lên API', () => {
  it('Nhanh gửi full = false, không kèm ngày', () => {
    expect(draftToPayload(draft({ mode: 'QUICK' }))).toEqual({ from: null, to: null, full: false });
  });

  it('Toàn bộ gửi full = true', () => {
    expect(draftToPayload(draft({ mode: 'FULL' }))).toEqual({ from: null, to: null, full: true });
  });

  it('Dải ngày gửi hai đầu và KHÔNG kèm full', () => {
    // Kèm `full` sẽ bắt hệ thống đọc lại toàn bộ Jira một cách thừa thãi trong
    // khi dải ngày đã nói rõ cần dựng lại khoảng nào.
    expect(draftToPayload(draft({ mode: 'RANGE', from: '2026-03-01', to: '2026-03-11' }))).toEqual({
      from: '2026-03-01',
      to: '2026-03-11',
      full: false,
    });
  });

  it('ngày đã gõ KHÔNG rò sang mức khác', () => {
    // Người dùng chọn Dải ngày, gõ ngày, rồi đổi ý sang Toàn bộ. Ngày cũ còn nằm
    // trong state — gửi kèm sẽ ra một dải ngày mà họ không hề chọn.
    const changedMind = draft({ mode: 'FULL', from: '2026-03-01', to: '2026-03-11' });
    expect(draftToPayload(changedMind)).toEqual({ from: null, to: null, full: true });
  });
});

describe('chặn trước khi gửi', () => {
  it('mức Nhanh và Toàn bộ luôn gửi được', () => {
    expect(draftError(draft({ mode: 'QUICK' }))).toBeNull();
    expect(draftError(draft({ mode: 'FULL' }))).toBeNull();
  });

  it('Dải ngày thiếu một đầu thì không gửi được', () => {
    expect(draftError(draft({ mode: 'RANGE', from: '2026-03-01' }))).toContain('both a start and an end date');
    expect(draftError(draft({ mode: 'RANGE', to: '2026-03-11' }))).toContain('both a start and an end date');
    expect(draftError(draft({ mode: 'RANGE' }))).not.toBeNull();
  });

  it('dải ngày ngược bị chặn, KHÔNG tự đảo hai đầu', () => {
    // Đảo ngầm sẽ giấu mất chuyện người dùng chọn nhầm.
    const err = draftError(draft({ mode: 'RANGE', from: '2026-03-11', to: '2026-03-01' }));
    expect(err).toContain('2026-03-11');
    expect(err).toContain('2026-03-01');
  });

  it('hai đầu bằng nhau là hợp lệ — dựng lại đúng một ngày', () => {
    expect(draftError(draft({ mode: 'RANGE', from: '2026-03-11', to: '2026-03-11' }))).toBeNull();
  });

  it('thông báo lỗi là câu hoàn chỉnh, không phải mã lỗi', () => {
    const err = draftError(draft({ mode: 'RANGE' }));
    expect(err).toMatch(/[a-zà-ỹ]\s/i);
    expect(err).not.toMatch(/^[A-Z_]+$/);
  });
});
