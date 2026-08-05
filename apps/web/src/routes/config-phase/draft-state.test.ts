import { describe, expect, it } from 'vitest';
import type { EffectiveConfigResponse } from '@app/shared';
import {
  canMove,
  draftReducer,
  isDirty,
  loadDraft,
  moveItem,
  payloadToPreview,
  payloadToSave,
  phaseCodeOptions,
  type DraftAction,
  type DraftState,
} from './draft-state.js';

const GLOBAL_CONFIG: EffectiveConfigResponse = {
  fallbackScanFullTitle: true,
  titlePatterns: [
    { patternText: '[{name}]', sortOrder: 1 },
    { patternText: '【{name}】', sortOrder: 2 },
  ],
  subtaskPatterns: [{ patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 }],
  phaseDefinitions: [
    { phaseCode: 'DESIGN', labelVi: 'Thiết kế', labelJa: '設計', displayOrder: 1 },
    { phaseCode: 'DEV', labelVi: 'Phát triển', labelJa: '開発', displayOrder: 2 },
    { phaseCode: 'TEST', labelVi: 'Kiểm thử', labelJa: null, displayOrder: 3 },
  ],
  matchRules: [
    { keyword: 'Design Review', matchMode: 'CONTAINS', phaseCode: 'TEST', matchPriority: 10 },
    { keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
  ],
  signboardColumns: [],
  projectKey: null,
  globalVersion: 4,
  projectVersion: null,
  inherited: {
    titlePatterns: false,
    subtaskPatterns: false,
    phaseDefinitions: false,
    matchRules: false,
    signboardColumns: false,
  },
};

/** Cùng nội dung nhưng đang mở ở phạm vi project và mọi phần đều kế thừa. */
const PROJECT_CONFIG: EffectiveConfigResponse = {
  ...GLOBAL_CONFIG,
  projectKey: 'SHOP',
  projectVersion: null,
  inherited: {
    titlePatterns: true,
    subtaskPatterns: true,
    phaseDefinitions: true,
    matchRules: true,
    signboardColumns: true,
  },
};

function apply(state: DraftState, ...actions: readonly DraftAction[]): DraftState {
  return actions.reduce(draftReducer, state);
}

describe('moveItem / canMove', () => {
  it('đổi chỗ hai phần tử liền nhau', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
  });

  it('ra khỏi biên thì không đổi gì', () => {
    expect(canMove(3, 0, -1)).toBe(false);
    expect(canMove(3, 2, 1)).toBe(false);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });

  it('KHÔNG sửa mảng gốc', () => {
    const list = ['a', 'b'];
    moveItem(list, 0, 1);
    expect(list).toEqual(['a', 'b']);
  });
});

describe('chỉ báo chưa lưu', () => {
  it('vừa nạp xong thì chưa có gì chưa lưu', () => {
    expect(isDirty(loadDraft(GLOBAL_CONFIG))).toBe(false);
  });

  it('sửa trường bất kỳ thì hiện chỉ báo chưa lưu', () => {
    const cases: readonly DraftAction[] = [
      { type: 'SET_FALLBACK', value: false },
      { type: 'ADD_PATTERN', field: 'titlePatterns' },
      { type: 'UPDATE_PATTERN', field: 'titlePatterns', index: 0, patternText: 'x{name}' },
      { type: 'REMOVE_PATTERN', field: 'titlePatterns', index: 0 },
      { type: 'MOVE_PATTERN', field: 'titlePatterns', index: 0, delta: 1 },
      { type: 'ADD_PHASE' },
      { type: 'UPDATE_PHASE', index: 0, patch: { labelVi: 'Khác' } },
      { type: 'REMOVE_PHASE', index: 0 },
      { type: 'MOVE_PHASE', index: 0, delta: 1 },
      { type: 'ADD_RULE' },
      { type: 'UPDATE_RULE', index: 0, patch: { keyword: 'khác' } },
      { type: 'REMOVE_RULE', index: 0 },
    ];

    for (const action of cases) {
      expect(isDirty(apply(loadDraft(GLOBAL_CONFIG), action)), action.type).toBe(true);
    }
  });

  it('sửa rồi sửa ngược lại thì hết chưa lưu', () => {
    const state = apply(
      loadDraft(GLOBAL_CONFIG),
      { type: 'SET_FALLBACK', value: false },
      { type: 'SET_FALLBACK', value: true },
    );
    expect(isDirty(state)).toBe(false);
  });

  it('COMMIT xoá chỉ báo chưa lưu mà không đụng nội dung', () => {
    // Lưu xong mà vẫn dựng lại màn hình từ đầu thì mất vị trí cuộn, mất ô ghi
    // chú, và mất luôn thông báo "đã lưu thành v5" vừa hiện ra. COMMIT chỉ nói
    // "bản nháp giờ chính là bản trên máy chủ".
    const edited = apply(loadDraft(GLOBAL_CONFIG), { type: 'UPDATE_PHASE', index: 0, patch: { labelVi: 'Thiết kế mới' } });
    expect(isDirty(edited)).toBe(true);

    const committed = draftReducer(edited, { type: 'COMMIT' });
    expect(isDirty(committed)).toBe(false);
    expect(committed.draft.phaseDefinitions[0]?.labelVi).toBe('Thiết kế mới');
  });

  it('bấm Ghi đè KHÔNG tính là sửa nội dung', () => {
    // Ghi đè chỉ đổi cờ kế thừa. Nội dung vẫn y nguyên nên không có gì để lưu
    // cho tới khi PM thật sự sửa một dòng.
    const state = apply(loadDraft(PROJECT_CONFIG), { type: 'OVERRIDE_PART', part: 'matchRules' });
    expect(isDirty(state)).toBe(false);
    expect(state.inherited.matchRules).toBe(false);
  });
});

describe('đổi thứ tự khu Phase', () => {
  it('chỉ đổi display_order, KHÔNG đổi match_priority', () => {
    // PRD §2.2.3 tách bạch hai khái niệm. Gộp chúng lại là lỗi nghiệp vụ trực
    // tiếp: đổi thứ tự cột trên biểu đồ mà lại đổi luôn cách phân loại Task.
    const before = loadDraft(GLOBAL_CONFIG);
    const after = draftReducer(before, { type: 'MOVE_PHASE', index: 0, delta: 1 });

    expect(after.draft.phaseDefinitions.map((p) => p.phaseCode)).toEqual(['DEV', 'DESIGN', 'TEST']);
    expect(after.draft.phaseDefinitions.map((p) => p.displayOrder)).toEqual([1, 2, 3]);
    expect(after.draft.matchRules).toEqual(before.draft.matchRules);
  });

  it('đánh lại display_order liên tục 1..n sau khi xoá', () => {
    const after = draftReducer(loadDraft(GLOBAL_CONFIG), { type: 'REMOVE_PHASE', index: 1 });
    expect(after.draft.phaseDefinitions.map((p) => p.displayOrder)).toEqual([1, 2]);
  });

  it('đổi thứ tự mẫu tiêu đề đánh lại sort_order — thứ tự này quyết định mẫu nào thử trước', () => {
    const after = draftReducer(loadDraft(GLOBAL_CONFIG), {
      type: 'MOVE_PATTERN',
      field: 'titlePatterns',
      index: 0,
      delta: 1,
    });
    expect(after.draft.titlePatterns.map((p) => p.patternText)).toEqual(['【{name}】', '[{name}]']);
    expect(after.draft.titlePatterns.map((p) => p.sortOrder)).toEqual([1, 2]);
  });

  it('đổi thứ tự ở biên trả về đúng state cũ, không tạo thay đổi giả', () => {
    const before = loadDraft(GLOBAL_CONFIG);
    expect(draftReducer(before, { type: 'MOVE_PHASE', index: 0, delta: -1 })).toBe(before);
  });
});

describe('sửa nội dung', () => {
  it('ô tên tiếng Nhật để trống thì lưu null, không lưu chuỗi rỗng', () => {
    const after = draftReducer(loadDraft(GLOBAL_CONFIG), {
      type: 'UPDATE_PHASE',
      index: 0,
      patch: { labelJa: null },
    });
    expect(after.draft.phaseDefinitions[0]?.labelJa).toBeNull();
  });

  it('luật mới lấy sẵn Phase đầu danh sách để không tạo ra luật trỏ vào khoảng không', () => {
    const after = draftReducer(loadDraft(GLOBAL_CONFIG), { type: 'ADD_RULE', keyword: '結合テスト' });
    const added = after.draft.matchRules.at(-1);
    expect(added?.keyword).toBe('結合テスト');
    expect(added?.phaseCode).toBe('DESIGN');
    expect(added?.matchPriority).toBe(50);
  });

  it('sửa dòng không tồn tại thì không làm gì, không nổ', () => {
    const before = loadDraft(GLOBAL_CONFIG);
    expect(draftReducer(before, { type: 'UPDATE_RULE', index: 99, patch: { keyword: 'x' } })).toBe(before);
  });

  it('phaseCodeOptions bỏ qua Phase chưa đặt mã', () => {
    const after = draftReducer(loadDraft(GLOBAL_CONFIG), { type: 'ADD_PHASE' });
    expect(phaseCodeOptions(after)).toEqual(['DESIGN', 'DEV', 'TEST']);
  });
});

describe('kế thừa theo project', () => {
  it('bộ Mặc định không kế thừa của ai', () => {
    const state = loadDraft(GLOBAL_CONFIG);
    expect(Object.values(state.inherited).every((v) => v === false)).toBe(true);
  });

  it('ba phần kế thừa ĐỘC LẬP — ghi đè mẫu tiêu đề không đụng tới Phase và luật', () => {
    // PRD §2.2.6. Làm kiểu "tất cả hoặc không có gì" thì project chỉ muốn đổi
    // mẫu tiêu đề sẽ mất sạch danh sách Phase, và mọi Task rơi vào Chưa phân loại.
    const state = draftReducer(loadDraft(PROJECT_CONFIG), {
      type: 'OVERRIDE_PART',
      part: 'titlePatterns',
    });

    expect(state.inherited.titlePatterns).toBe(false);
    expect(state.inherited.phaseDefinitions).toBe(true);
    expect(state.inherited.matchRules).toBe(true);
  });

  it('phần vẫn kế thừa được gửi lên MẢNG RỖNG, không phải bản sao của bộ Mặc định', () => {
    // Đây là chỗ dễ sai nhất cả màn hình. Gửi bản sao thì project ĐÓNG BĂNG cấu
    // hình: sau này sửa bộ Mặc định, project không nhận thay đổi nữa mà nhìn màn
    // hình vẫn thấy y hệt. Không lỗi nào báo ra.
    const state = draftReducer(loadDraft(PROJECT_CONFIG), {
      type: 'OVERRIDE_PART',
      part: 'matchRules',
    });
    const payload = payloadToSave(state);

    expect(payload.matchRules).toHaveLength(2); // phần đã ghi đè: gửi nội dung thật
    expect(payload.titlePatterns).toEqual([]); // phần còn kế thừa: gửi rỗng
    expect(payload.phaseDefinitions).toEqual([]);
  });

  it('bộ Mặc định gửi nguyên nội dung, không cắt gì', () => {
    const payload = payloadToSave(loadDraft(GLOBAL_CONFIG));
    expect(payload.phaseDefinitions).toHaveLength(3);
    expect(payload.titlePatterns).toHaveLength(2);
  });

  it('Xem thử gửi cấu hình ĐẦY ĐỦ kể cả phần đang kế thừa', () => {
    // Gửi mảng rỗng thì bảng xem thử sẽ hiện mọi Task rơi vào "Chưa phân loại"
    // và PM tưởng mình vừa làm hỏng cấu hình.
    const state = loadDraft(PROJECT_CONFIG);
    const preview = payloadToPreview(state);

    expect(preview.phaseDefinitions).toHaveLength(3);
    expect(preview.matchRules).toHaveLength(2);
    expect(payloadToSave(state).phaseDefinitions).toEqual([]);
  });
});
