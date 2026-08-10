import {
  INHERITABLE_PARTS,
  type ConfigPayload,
  type EffectiveConfigResponse,
  type InheritablePartKey,
  type MatchRule,
  type PhaseDefinition,
  type SignboardColumn,
  type SubPhaseOrder,
  type TitlePattern,
} from '@app/shared';

/**
 * Trạng thái nháp của màn hình cấu hình — HÀM THUẦN, không đụng React.
 *
 * Tách hẳn ra khỏi component vì đây là chỗ dễ sai nhất của cả màn hình, và test
 * nó không cần dựng DOM. Ba thứ phải đúng tuyệt đối:
 *
 *   1. Sửa gì cũng chỉ đổi state cục bộ. Gọi API mỗi lần gõ phím thì màn hình
 *      giật và máy chủ hứng vài trăm request cho một lần sửa.
 *   2. Kéo đổi thứ tự ở khu Phase chỉ đụng `displayOrder`, TUYỆT ĐỐI không đụng
 *      `matchPriority` — PRD §2.2.3 dành hẳn một mục để tách bạch hai khái niệm.
 *   3. Phần vẫn kế thừa phải gửi lên MẢNG RỖNG, không phải bản sao của bộ Mặc
 *      định (xem `payloadToSave`).
 */

export type PatternField = 'titlePatterns' | 'subtaskPatterns';

export interface DraftState {
  readonly projectKey: string | null;
  /** Bản đang lưu trên máy chủ, để biết đã sửa gì. */
  readonly base: ConfigPayload;
  readonly draft: ConfigPayload;
  /** Phần nào đang lấy từ bộ Mặc định (chỉ có nghĩa khi `projectKey` khác null). */
  readonly inherited: Readonly<Record<InheritablePartKey, boolean>>;
}

export type DraftAction =
  | { readonly type: 'LOAD'; readonly config: EffectiveConfigResponse }
  | { readonly type: 'SET_FALLBACK'; readonly value: boolean }
  | { readonly type: 'ADD_PATTERN'; readonly field: PatternField }
  | {
      readonly type: 'UPDATE_PATTERN';
      readonly field: PatternField;
      readonly index: number;
      readonly patternText: string;
    }
  | { readonly type: 'REMOVE_PATTERN'; readonly field: PatternField; readonly index: number }
  | {
      readonly type: 'MOVE_PATTERN';
      readonly field: PatternField;
      readonly index: number;
      readonly delta: -1 | 1;
    }
  | { readonly type: 'ADD_PHASE' }
  | { readonly type: 'UPDATE_PHASE'; readonly index: number; readonly patch: Partial<PhaseDefinition> }
  | { readonly type: 'REMOVE_PHASE'; readonly index: number }
  | { readonly type: 'MOVE_PHASE'; readonly index: number; readonly delta: -1 | 1 }
  | { readonly type: 'ADD_RULE'; readonly keyword?: string }
  | { readonly type: 'UPDATE_RULE'; readonly index: number; readonly patch: Partial<MatchRule> }
  | { readonly type: 'REMOVE_RULE'; readonly index: number }
  | { readonly type: 'ADD_COLUMN'; readonly taskCode?: string }
  | { readonly type: 'UPDATE_COLUMN'; readonly index: number; readonly patch: Partial<SignboardColumn> }
  | { readonly type: 'REMOVE_COLUMN'; readonly index: number }
  | { readonly type: 'MOVE_COLUMN'; readonly index: number; readonly delta: -1 | 1 }
  /** Thêm cả một nhóm thứ tự Sub-phase cho một Phase (dùng cho cả prefill). */
  | {
      readonly type: 'ADD_SUB_PHASE_GROUP';
      readonly phaseCode: string;
      readonly subPhaseCodes: readonly string[];
    }
  | { readonly type: 'ADD_SUB_PHASE'; readonly phaseCode: string }
  | { readonly type: 'UPDATE_SUB_PHASE'; readonly index: number; readonly subPhaseCode: string }
  /** Đổi mã Phase của CẢ nhóm — mã Phase là khoá nhóm, không sửa từng dòng được. */
  | { readonly type: 'RENAME_SUB_PHASE_GROUP'; readonly phaseCode: string; readonly value: string }
  /** Đổi chỗ trong PHẠM VI nhóm cùng Phase — không nhảy sang nhóm khác. */
  | { readonly type: 'MOVE_SUB_PHASE'; readonly index: number; readonly delta: -1 | 1 }
  | { readonly type: 'REMOVE_SUB_PHASE'; readonly index: number }
  | { readonly type: 'OVERRIDE_PART'; readonly part: InheritablePartKey }
  /** Lưu thành công: bản nháp giờ CHÍNH LÀ bản đang có trên máy chủ. */
  | { readonly type: 'COMMIT' };

// ---------------------------------------------------------------------------
// Khởi tạo
// ---------------------------------------------------------------------------

const EMPTY_PAYLOAD: ConfigPayload = {
  fallbackScanFullTitle: true,
  titlePatterns: [],
  subtaskPatterns: [],
  phaseDefinitions: [],
  matchRules: [],
  signboardColumns: [],
  subPhaseOrders: [],
};

export const EMPTY_DRAFT: DraftState = {
  projectKey: null,
  base: EMPTY_PAYLOAD,
  draft: EMPTY_PAYLOAD,
  inherited: {
    titlePatterns: false,
    subtaskPatterns: false,
    phaseDefinitions: false,
    matchRules: false,
    signboardColumns: false,
    subPhaseOrders: false,
  },
};

function payloadOf(config: EffectiveConfigResponse): ConfigPayload {
  return {
    fallbackScanFullTitle: config.fallbackScanFullTitle,
    titlePatterns: config.titlePatterns,
    subtaskPatterns: config.subtaskPatterns,
    phaseDefinitions: config.phaseDefinitions,
    matchRules: config.matchRules,
    signboardColumns: config.signboardColumns,
    subPhaseOrders: config.subPhaseOrders,
  };
}

export function loadDraft(config: EffectiveConfigResponse): DraftState {
  const payload = payloadOf(config);
  return {
    projectKey: config.projectKey,
    base: payload,
    draft: payload,
    // Bộ Mặc định không kế thừa của ai — mọi phần đều là của chính nó.
    inherited: config.projectKey === null ? EMPTY_DRAFT.inherited : config.inherited,
  };
}

// ---------------------------------------------------------------------------
// Thao tác trên mảng
// ---------------------------------------------------------------------------

/** Có đổi chỗ được không. Tách riêng để reducer biết khi nào nên trả về state cũ. */
export function canMove(length: number, index: number, delta: -1 | 1): boolean {
  const target = index + delta;
  return index >= 0 && index < length && target >= 0 && target < length;
}

/** Đổi chỗ hai phần tử. Ra khỏi biên thì trả về bản sao y nguyên. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const next = [...list];
  if (!canMove(list.length, index, delta)) return next;
  const target = index + delta;
  const a = next[index] as T;
  const b = next[target] as T;
  next[index] = b;
  next[target] = a;
  return next;
}

function replaceAt<T>(list: readonly T[], index: number, value: T): T[] {
  return list.map((item, i) => (i === index ? value : item));
}

function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/** Đánh số lại 1..n theo đúng thứ tự đang hiện trên màn hình. */
function renumber<T extends { readonly sortOrder?: number; readonly displayOrder?: number }>(
  list: readonly T[],
  key: 'sortOrder' | 'displayOrder',
): T[] {
  return list.map((item, i) => ({ ...item, [key]: i + 1 }));
}

/**
 * Đánh số lại `displayOrder` 1..n TRONG TỪNG NHÓM cùng `phaseCode`.
 *
 * Khác `renumber`: thứ tự Sub-phase chỉ có nghĩa trong phạm vi một Phase; đánh
 * số xuyên nhóm thì Phase thứ hai bắt đầu từ giữa chừng và số hiện ra vô nghĩa.
 */
function renumberSubPhases(list: readonly SubPhaseOrder[]): SubPhaseOrder[] {
  const counters = new Map<string, number>();
  return list.map((row) => {
    const next = (counters.get(row.phaseCode) ?? 0) + 1;
    counters.set(row.phaseCode, next);
    return { ...row, displayOrder: next };
  });
}

/** Vị trí (trong mảng PHẲNG) của dòng liền kề CÙNG NHÓM, hoặc `null` nếu ở biên. */
function adjacentInGroup(
  list: readonly SubPhaseOrder[],
  index: number,
  delta: -1 | 1,
): number | null {
  const row = list[index];
  if (row === undefined) return null;
  for (let i = index + delta; i >= 0 && i < list.length; i += delta) {
    if (list[i]?.phaseCode === row.phaseCode) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  const edit = (patch: Partial<ConfigPayload>): DraftState => ({
    ...state,
    draft: { ...state.draft, ...patch },
  });

  switch (action.type) {
    case 'LOAD':
      return loadDraft(action.config);

    case 'SET_FALLBACK':
      return edit({ fallbackScanFullTitle: action.value });

    case 'ADD_PATTERN': {
      const list = state.draft[action.field];
      const added: TitlePattern = { patternText: '', sortOrder: list.length + 1 };
      return edit({ [action.field]: [...list, added] });
    }

    case 'UPDATE_PATTERN': {
      const list = state.draft[action.field];
      const current = list[action.index];
      if (current === undefined) return state;
      return edit({
        [action.field]: replaceAt(list, action.index, { ...current, patternText: action.patternText }),
      });
    }

    case 'REMOVE_PATTERN':
      return edit({
        [action.field]: renumber(removeAt(state.draft[action.field], action.index), 'sortOrder'),
      });

    case 'MOVE_PATTERN': {
      const list = state.draft[action.field];
      if (!canMove(list.length, action.index, action.delta)) return state;
      return edit({ [action.field]: renumber(moveItem(list, action.index, action.delta), 'sortOrder') });
    }

    case 'ADD_PHASE': {
      const added: PhaseDefinition = {
        phaseCode: '',
        labelVi: '',
        displayOrder: state.draft.phaseDefinitions.length + 1,
      };
      return edit({ phaseDefinitions: [...state.draft.phaseDefinitions, added] });
    }

    case 'UPDATE_PHASE': {
      const current = state.draft.phaseDefinitions[action.index];
      if (current === undefined) return state;
      return edit({
        phaseDefinitions: replaceAt(state.draft.phaseDefinitions, action.index, {
          ...current,
          ...action.patch,
        }),
      });
    }

    case 'REMOVE_PHASE':
      return edit({
        phaseDefinitions: renumber(
          removeAt(state.draft.phaseDefinitions, action.index),
          'displayOrder',
        ),
      });

    case 'MOVE_PHASE': {
      const list = state.draft.phaseDefinitions;
      if (!canMove(list.length, action.index, action.delta)) return state;
      // CHỈ đánh lại `displayOrder`. `matchRules` không bị đụng tới một chút nào:
      // thứ tự hiển thị trên biểu đồ và ưu tiên khi khớp là hai thứ khác nhau.
      return edit({ phaseDefinitions: renumber(moveItem(list, action.index, action.delta), 'displayOrder') });
    }

    case 'ADD_RULE': {
      const added: MatchRule = {
        keyword: action.keyword ?? '',
        matchMode: 'CONTAINS',
        phaseCode: state.draft.phaseDefinitions[0]?.phaseCode ?? '',
        matchPriority: 50,
      };
      return edit({ matchRules: [...state.draft.matchRules, added] });
    }

    case 'UPDATE_RULE': {
      const current = state.draft.matchRules[action.index];
      if (current === undefined) return state;
      return edit({
        matchRules: replaceAt(state.draft.matchRules, action.index, { ...current, ...action.patch }),
      });
    }

    case 'REMOVE_RULE':
      return edit({ matchRules: removeAt(state.draft.matchRules, action.index) });

    case 'ADD_COLUMN': {
      const added: SignboardColumn = {
        taskCode: action.taskCode ?? '',
        labelVi: action.taskCode ?? '',
        displayOrder: state.draft.signboardColumns.length + 1,
      };
      return edit({ signboardColumns: [...state.draft.signboardColumns, added] });
    }

    case 'UPDATE_COLUMN': {
      const current = state.draft.signboardColumns[action.index];
      if (current === undefined) return state;
      return edit({
        signboardColumns: replaceAt(state.draft.signboardColumns, action.index, {
          ...current,
          ...action.patch,
        }),
      });
    }

    case 'REMOVE_COLUMN':
      return edit({
        signboardColumns: renumber(
          removeAt(state.draft.signboardColumns, action.index),
          'displayOrder',
        ),
      });

    case 'MOVE_COLUMN': {
      const list = state.draft.signboardColumns;
      if (!canMove(list.length, action.index, action.delta)) return state;
      // Thứ tự cột Signboard là THỨ TỰ HIỆN trên bảng — cùng bản chất với
      // `displayOrder` của Phase, không liên quan gì tới `matchPriority`.
      return edit({
        signboardColumns: renumber(moveItem(list, action.index, action.delta), 'displayOrder'),
      });
    }

    case 'ADD_SUB_PHASE_GROUP': {
      const added = action.subPhaseCodes.map((code, i) => ({
        phaseCode: action.phaseCode,
        subPhaseCode: code,
        displayOrder: i + 1,
      }));
      return edit({
        subPhaseOrders: renumberSubPhases([...state.draft.subPhaseOrders, ...added]),
      });
    }

    case 'ADD_SUB_PHASE': {
      const list = state.draft.subPhaseOrders;
      // Chèn NGAY SAU dòng cuối của nhóm để các dòng cùng Phase đứng liền nhau;
      // nhóm chưa có dòng nào thì thêm vào cuối danh sách.
      let insertAt = list.length;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.phaseCode === action.phaseCode) {
          insertAt = i + 1;
          break;
        }
      }
      const next = [...list];
      next.splice(insertAt, 0, { phaseCode: action.phaseCode, subPhaseCode: '', displayOrder: 0 });
      return edit({ subPhaseOrders: renumberSubPhases(next) });
    }

    case 'UPDATE_SUB_PHASE': {
      const current = state.draft.subPhaseOrders[action.index];
      if (current === undefined) return state;
      return edit({
        subPhaseOrders: replaceAt(state.draft.subPhaseOrders, action.index, {
          ...current,
          subPhaseCode: action.subPhaseCode,
        }),
      });
    }

    case 'RENAME_SUB_PHASE_GROUP':
      return edit({
        subPhaseOrders: state.draft.subPhaseOrders.map((row) =>
          row.phaseCode === action.phaseCode ? { ...row, phaseCode: action.value } : row,
        ),
      });

    case 'MOVE_SUB_PHASE': {
      const list = state.draft.subPhaseOrders;
      const target = adjacentInGroup(list, action.index, action.delta);
      if (target === null) return state;
      const next = [...list];
      const a = next[action.index] as SubPhaseOrder;
      next[action.index] = next[target] as SubPhaseOrder;
      next[target] = a;
      return edit({ subPhaseOrders: renumberSubPhases(next) });
    }

    case 'REMOVE_SUB_PHASE':
      return edit({
        subPhaseOrders: renumberSubPhases(removeAt(state.draft.subPhaseOrders, action.index)),
      });

    case 'OVERRIDE_PART':
      // Chỉ đổi cờ kế thừa. Nội dung giữ nguyên bản đang thấy, để PM sửa tiếp
      // từ đó chứ không phải bắt đầu lại từ danh sách trống.
      return { ...state, inherited: { ...state.inherited, [action.part]: false } };

    case 'COMMIT':
      // CỐ Ý không dựng lại màn hình từ đầu sau khi lưu. Dựng lại thì mất vị trí
      // cuộn, mất ô ghi chú, và mất luôn thông báo "đã lưu thành v5" — chính
      // thông báo vừa hiện ra một phần nghìn giây trước đó.
      return { ...state, base: state.draft };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Dẫn xuất
// ---------------------------------------------------------------------------

/** Có gì chưa lưu không. So sâu vì mọi thao tác đều tạo object mới. */
export function isDirty(state: DraftState): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(state.base);
}

/**
 * Nội dung gửi lên khi bấm Lưu.
 *
 * ĐIỂM DỄ SAI NHẤT CỦA CẢ MÀN HÌNH: phần vẫn đang kế thừa phải gửi **mảng
 * rỗng**, không phải bản sao của bộ Mặc định.
 *
 * Lý do: máy chủ coi mảng rỗng là "chưa ghi đè, cứ kế thừa tiếp" (`pick()` ở
 * `merge-inheritance.ts`). Gửi bản sao thì project **đóng băng** cấu hình tại
 * thời điểm đó — sau này sửa bộ Mặc định, project không nhận thay đổi nữa, mà
 * nhìn màn hình vẫn thấy y hệt như cũ. Không có lỗi nào báo ra, và phải mất
 * hàng tuần mới có người nhận ra vì sao project đó "không chịu cập nhật".
 */
export function payloadToSave(state: DraftState): ConfigPayload {
  if (state.projectKey === null) return state.draft;

  const payload: ConfigPayload = { ...state.draft };
  for (const part of INHERITABLE_PARTS) {
    if (state.inherited[part]) {
      (payload as Record<InheritablePartKey, unknown>)[part] = [];
    }
  }
  return payload;
}

/**
 * Cấu hình dùng cho Xem thử.
 *
 * KHÁC `payloadToSave`: xem thử cần cấu hình ĐẦY ĐỦ như lúc chạy thật, gồm cả
 * phần đang kế thừa. Gửi mảng rỗng thì bảng xem thử sẽ hiện mọi Task rơi vào
 * "Chưa phân loại" và PM tưởng mình vừa làm hỏng cấu hình.
 */
export function payloadToPreview(state: DraftState): ConfigPayload {
  return state.draft;
}

/** Mã Phase đang có, để ô chọn Phase của luật khớp không cho gõ tay mã sai. */
export function phaseCodeOptions(state: DraftState): readonly string[] {
  return state.draft.phaseDefinitions.map((p) => p.phaseCode).filter((code) => code !== '');
}

/** Một nhóm thứ tự Sub-phase của một Phase, kèm chỉ số PHẲNG để dispatch action. */
export interface SubPhaseGroup {
  readonly phaseCode: string;
  readonly rows: readonly { readonly row: SubPhaseOrder; readonly index: number }[];
}

/**
 * Gom `subPhaseOrders` (mảng phẳng — đúng hình dạng lưu) thành nhóm theo Phase
 * để vẽ. Nhóm xếp theo lần xuất hiện ĐẦU TIÊN — reducer đã giữ các dòng cùng
 * Phase đứng liền nhau nên thứ tự này ổn định.
 */
export function subPhaseGroups(state: DraftState): readonly SubPhaseGroup[] {
  const groups = new Map<string, { row: SubPhaseOrder; index: number }[]>();
  state.draft.subPhaseOrders.forEach((row, index) => {
    const list = groups.get(row.phaseCode);
    if (list) list.push({ row, index });
    else groups.set(row.phaseCode, [{ row, index }]);
  });
  return [...groups.entries()].map(([phaseCode, rows]) => ({ phaseCode, rows }));
}
