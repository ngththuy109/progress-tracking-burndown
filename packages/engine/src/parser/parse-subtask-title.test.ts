import { describe, it, expect } from 'vitest';
import type { ConfigPayload, EffectiveConfig } from '@app/shared';
import { toFunctionKey } from './function-key.js';
import { SubtaskTitleParser } from './parse-subtask-title.js';

const BASE: ConfigPayload = {
  fallbackScanFullTitle: true,
  titlePatterns: [{ patternText: '[Phase] {name}', sortOrder: 1 }],
  subtaskPatterns: [
    { patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 },
  ],
  phaseDefinitions: [
    { phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 1 },
    { phaseCode: 'DEVELOPMENT', labelVi: 'Phát triển', displayOrder: 2 },
  ],
  matchRules: [
    { keyword: 'Development', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 40 },
    { keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
  ],
  signboardColumns: [
    { taskCode: 'Create', labelVi: 'Tạo mới', displayOrder: 1 },
    { taskCode: 'BALReview', labelVi: 'BAL review', displayOrder: 2 },
    { taskCode: 'FixCommentBAL', labelVi: 'Sửa comment BAL', displayOrder: 3 },
    { taskCode: 'JMReview', labelVi: 'JM review', displayOrder: 4 },
    { taskCode: 'FixCommentJM', labelVi: 'Sửa comment JM', displayOrder: 5 },
  ],
  subPhaseOrders: [],
};

const cfg = (over: Partial<ConfigPayload> = {}): EffectiveConfig => ({
  ...BASE,
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

/** Mặc định Task cha thuộc DESIGN — trùng với `[Design]` trong các tiêu đề mẫu. */
const parse = (title: string, parentPhaseCode = 'DESIGN', over: Partial<ConfigPayload> = {}) =>
  new SubtaskTitleParser(cfg(over)).parse(title, parentPhaseCode);

describe('tách 5 thành phần', () => {
  it('tách đúng 5 thành phần từ "[PAY][TeamA][Design][Login]_Create"', () => {
    const r = parse('[PAY][TeamA][Design][Login]_Create');
    expect(r.sbProject).toBe('PAY');
    expect(r.sbTeam).toBe('TeamA');
    expect(r.sbPhaseRaw).toBe('Design');
    expect(r.functionName).toBe('Login');
    expect(r.taskType).toBe('Create');
    expect(r.sbParseStatus).toBe('OK');
  });

  it('dấu _ trong FunctionName không gây mơ hồ', () => {
    // Tách bằng split('_') sẽ hỏng ở đây: cặp ngoặc mới là ranh giới thật
    const r = parse('[PAY][TeamA][Design][Login_Form]_BALReview');
    expect(r.functionName).toBe('Login_Form');
    expect(r.taskType).toBe('BALReview');
  });

  it('ngoặc toàn giác ［］ kiểu Nhật được chấp nhận', () => {
    const r = parse('［PAY］［TeamA］［Design］［Login］_Create');
    expect(r.sbProject).toBe('PAY');
    expect(r.functionName).toBe('Login');
    expect(r.taskType).toBe('Create');
  });

  it('FunctionName tiếng Nhật 決済 tách đúng', () => {
    const r = parse('［PAY］［TeamA］［Design］［決済］_JMReview');
    expect(r.functionName).toBe('決済');
    expect(r.taskType).toBe('JMReview');
    expect(r.sbParseStatus).toBe('OK');
  });

  it('khoảng trắng thừa cạnh dấu phân tách không làm hỏng việc tách', () => {
    // Biểu thức chuẩn ở PRD §2.9.1 có `\s*` giữa các cặp ngoặc
    const r = parse('[PAY] [TeamA] [Design] [ Login ] _Create');
    expect(r.functionName).toBe('Login');
    expect(r.taskType).toBe('Create');
  });

  it('khoảng trắng GIỮA CHỮ trong FunctionName được giữ nguyên', () => {
    const r = parse('[PAY][TeamA][Design][Login Form]_Create');
    expect(r.functionName).toBe('Login Form');
  });
});

describe('gộp hàng theo function_key', () => {
  it('Login, login và Ｌｏｇｉｎ cho ra cùng một function_key', () => {
    const keys = ['[P][A][Design][Login]_Create', '[P][A][Design][login]_Create', '[P][A][Design][Ｌｏｇｉｎ]_Create'].map(
      (t) => parse(t).functionKey,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('login');
  });

  it('functionName giữ nguyên dạng gốc, chỉ functionKey bị chuẩn hoá', () => {
    const r = parse('[PAY][TeamA][Design][LoginForm]_Create');
    expect(r.functionName).toBe('LoginForm');
    expect(r.functionKey).toBe('loginform');
  });

  it('toFunctionKey dùng đúng cách chuẩn hoá của T-07', () => {
    expect(toFunctionKey('  Ｌｏｇｉｎ  ')).toBe('login');
    expect(toFunctionKey('ﾃｽﾄ')).toBe(toFunctionKey('テスト'));
  });
});

describe('khớp loại task — CHÍNH XÁC, không phải "chứa"', () => {
  it('_Create khớp chính xác cột Create', () => {
    expect(parse('[P][A][Design][Login]_Create').taskType).toBe('Create');
  });

  it('_CreateScreen KHÔNG khớp cột Create', () => {
    const r = parse('[P][A][Design][Login]_CreateScreen');
    expect(r.taskType).toBeNull();
    expect(r.sbParseStatus).toBe('UNKNOWN_TASK_TYPE');
  });

  it('_BALReview khớp BALReview, KHÔNG khớp FixCommentBAL', () => {
    expect(parse('[P][A][Design][Login]_BALReview').taskType).toBe('BALReview');
    expect(parse('[P][A][Design][Login]_FixCommentBAL').taskType).toBe('FixCommentBAL');
  });

  it('_UnitTest cho UNKNOWN_TASK_TYPE nhưng functionName vẫn có', () => {
    const r = parse('[P][A][Design][Login]_UnitTest');
    expect(r.sbParseStatus).toBe('UNKNOWN_TASK_TYPE');
    expect(r.functionName).toBe('Login');
    expect(r.functionKey).toBe('login');
    expect(r.taskType).toBeNull();
  });

  it('khớp cột không phân biệt hoa thường và toàn giác/bán giác', () => {
    expect(parse('[P][A][Design][Login]_create').taskType).toBe('Create');
    expect(parse('[P][A][Design][Login]_Ｃｒｅａｔｅ').taskType).toBe('Create');
  });

  it('hai cột trùng nhau sau chuẩn hoá thì cảnh báo AMBIGUOUS_TASK_COLUMN', () => {
    const r = parse('[P][A][Design][Login]_Create', 'DESIGN', {
      signboardColumns: [
        { taskCode: 'Create', labelVi: 'Tạo mới', displayOrder: 1 },
        { taskCode: 'ｃｒｅａｔｅ', labelVi: 'Tạo mới (trùng)', displayOrder: 2 },
      ],
    });
    expect(r.warnings.some((w) => w.code === 'AMBIGUOUS_TASK_COLUMN')).toBe(true);
    expect(r.taskType).toBe('Create'); // giữ cột khai TRƯỚC
  });
});

describe('Phase — Task cha luôn thắng', () => {
  it('Phase trong tiêu đề khác Task cha thì kết quả VẪN lấy Phase của Task cha', () => {
    const r = parse('[PAY][TeamA][Development][Login]_Create', 'DESIGN');
    expect(r.phaseCode).toBe('DESIGN');
    expect(r.sbPhaseRaw).toBe('Development'); // giữ lại, nhưng chỉ để đối chiếu
  });

  it('trường hợp lệch sinh cảnh báo PHASE_MISMATCH kèm cả hai giá trị', () => {
    const r = parse('[PAY][TeamA][Development][Login]_Create', 'DESIGN');
    const w = r.warnings.find((x) => x.code === 'PHASE_MISMATCH');
    expect(w).toBeDefined();
    expect(w!.message).toContain('DEVELOPMENT');
    expect(w!.message).toContain('DESIGN');
  });

  it('Phase trong tiêu đề trùng Task cha thì không có cảnh báo nào', () => {
    const r = parse('[PAY][TeamA][Design][Login]_Create', 'DESIGN');
    expect(r.warnings).toEqual([]);
  });

  it('Phase trong tiêu đề không khớp luật nào thì KHÔNG báo lệch', () => {
    // UNCLASSIFIED nghĩa là KHÔNG BIẾT, không phải LỆCH — báo ở đây là đoán bừa
    const r = parse('[PAY][TeamA][Chuẩn bị họp][Login]_Create', 'DESIGN');
    expect(r.warnings).toEqual([]);
    expect(r.phaseCode).toBe('DESIGN');
  });

  it('đối chiếu Phase vẫn chạy khi PM tắt fallbackScanFullTitle', () => {
    // Cờ đó dành cho tiêu đề TASK. Nếu nó tắt luôn cả việc đối chiếu Sub-task
    // thì PHASE_MISMATCH sẽ biến mất trong im lặng.
    const r = parse('[PAY][TeamA][Development][Login]_Create', 'DESIGN', {
      fallbackScanFullTitle: false,
    });
    expect(r.warnings.some((w) => w.code === 'PHASE_MISMATCH')).toBe(true);
  });
});

describe('không khớp format', () => {
  it('tiêu đề "Họp review thiết kế với khách" cho UNPARSED, mọi trường bằng null', () => {
    const r = parse('Họp review thiết kế với khách');
    expect(r.sbParseStatus).toBe('UNPARSED');
    expect(r.sbProject).toBeNull();
    expect(r.sbTeam).toBeNull();
    expect(r.sbPhaseRaw).toBeNull();
    expect(r.functionName).toBeNull();
    expect(r.functionKey).toBeNull();
    expect(r.taskType).toBeNull();
    expect(r.matchedPattern).toBeNull();
    // Vẫn phải trả về Phase của Task cha: UNPARSED chỉ là không lên được
    // Signboard, công việc vẫn được cộng dồn đầy đủ vào Burndown (C-11)
    expect(r.phaseCode).toBe('DESIGN');
  });

  it('tiêu đề thiếu một cặp ngoặc cho UNPARSED', () => {
    expect(parse('[PAY][TeamA][Design]_Create').sbParseStatus).toBe('UNPARSED');
  });

  it('tiêu đề thiếu dấu _ và TaskName cho UNPARSED', () => {
    expect(parse('[PAY][TeamA][Design][Login]').sbParseStatus).toBe('UNPARSED');
  });
});

describe('cấu hình hỏng', () => {
  it('không có mẫu Sub-task nào thì cảnh báo NO_SUBTASK_PATTERN', () => {
    const r = parse('[PAY][TeamA][Design][Login]_Create', 'DESIGN', { subtaskPatterns: [] });
    expect(r.sbParseStatus).toBe('UNPARSED');
    expect(r.warnings.some((w) => w.code === 'NO_SUBTASK_PATTERN')).toBe(true);
  });

  it('mẫu thiếu ô {function} bị bỏ qua kèm cảnh báo SUBTASK_PATTERN_INVALID', () => {
    const r = parse('[PAY][TeamA][Design][Login]_Create', 'DESIGN', {
      subtaskPatterns: [{ patternText: '[{project}]_{task}', sortOrder: 1 }],
    });
    expect(r.warnings.some((w) => w.code === 'SUBTASK_PATTERN_INVALID')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'NO_SUBTASK_PATTERN')).toBe(true);
  });

  it('mẫu thứ hai được thử khi mẫu thứ nhất không khớp', () => {
    const r = parse('[Login]_Create', 'DESIGN', {
      subtaskPatterns: [
        { patternText: '[{project}][{team}][{phase}][{function}]_{task}', sortOrder: 1 },
        { patternText: '[{function}]_{task}', sortOrder: 2 },
      ],
    });
    expect(r.matchedPattern).toBe('[{function}]_{task}');
    expect(r.functionName).toBe('Login');
    expect(r.sbPhaseRaw).toBeNull(); // mẫu này không có ô {phase}
    expect(r.sbParseStatus).toBe('OK');
  });
});
