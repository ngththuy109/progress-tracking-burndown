import { describe, it, expect } from 'vitest';
import type { ConfigPayload, EffectiveConfig } from '@app/shared';
import { normalize } from './normalize.js';
import { compilePattern, PatternCompileError } from './compile-pattern.js';
import { SafeRegexRunner, MAX_REGEX_LENGTH } from './safe-regex.js';
import { TaskTitleParser } from './parse-task-title.js';

const BASE: ConfigPayload = {
  fallbackScanFullTitle: true,
  titlePatterns: [
    { patternText: '[Phase] {name}', sortOrder: 1 },
    { patternText: '【{name}】', sortOrder: 2 },
  ],
  subtaskPatterns: [],
  phaseDefinitions: [
    { phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 1 },
    { phaseCode: 'DEVELOPMENT', labelVi: 'Phát triển', displayOrder: 2 },
    { phaseCode: 'TESTING', labelVi: 'Kiểm thử', displayOrder: 3 },
  ],
  matchRules: [
    { keyword: 'Design Review', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 10 },
    { keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
    { keyword: '基本設計', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
    { keyword: '詳細設計', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
    { keyword: 'Dev', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 70 },
  ],
  signboardColumns: [],
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

const parse = (title: string, over: Partial<ConfigPayload> = {}) =>
  new TaskTitleParser(cfg(over)).parse(title);

describe('chuẩn hoá chuỗi', () => {
  it('ﾃｽﾄ nửa giác và テスト toàn giác được coi là cùng một chuỗi', () => {
    expect(normalize('ﾃｽﾄ')).toBe(normalize('テスト'));
  });

  it('Ａ toàn giác và A bán giác được coi là cùng một chuỗi', () => {
    expect(normalize('Ａ')).toBe(normalize('A'));
  });

  it('gộp khoảng trắng liên tiếp và cắt hai đầu', () => {
    expect(normalize('  Thiết   kế  ')).toBe('thiết kế');
  });
});

describe('biên dịch mẫu tiêu đề', () => {
  it('mẫu [Phase] {name} khớp "[Phase] Design" và bóc ra "Design"', () => {
    // Ca then chốt: nếu `[` `]` không được escape thì `[Phase]` thành character
    // class khớp một ký tự bất kỳ — mẫu vẫn chạy nhưng khớp lung tung
    const src = compilePattern('[Phase] {name}');
    const m = new RegExp(src, 'u').exec('[Phase] Design');
    expect(m?.groups?.['name']).toBe('Design');
  });

  it('mẫu [Phase] {name} KHÔNG khớp chuỗi thiếu ngoặc vuông', () => {
    const re = new RegExp(compilePattern('[Phase] {name}'), 'u');
    expect(re.exec('Phase Design')).toBeNull();
  });

  it('mẫu 【{name}】 khớp tiêu đề Nhật và bóc ra 基本設計', () => {
    const re = new RegExp(compilePattern('【{name}】'), 'u');
    expect(re.exec('【基本設計】')?.groups?.['name']).toBe('基本設計');
  });

  it('mẫu {no}. {name} khớp "01. Thiết kế" và bóc ra "Thiết kế"', () => {
    const re = new RegExp(compilePattern('{no}. {name}'), 'u');
    const m = re.exec('01. Thiết kế');
    expect(m?.groups?.['no']).toBe('01');
    expect(m?.groups?.['name']).toBe('Thiết kế');
  });

  it('dấu chấm trong mẫu là chữ nguyên văn, không phải ký tự bất kỳ', () => {
    const re = new RegExp(compilePattern('{no}. {name}'), 'u');
    expect(re.exec('01X Thiết kế')).toBeNull();
  });

  it('ngoặc vuông toàn giác ［］ được chấp nhận như ngoặc thường', () => {
    const re = new RegExp(compilePattern('[Phase] {name}'), 'u');
    expect(re.exec('［Phase］ Design')?.groups?.['name']).toBe('Design');
  });

  it('mẫu thiếu ô {name} bị từ chối biên dịch', () => {
    expect(() => compilePattern('[Phase] abc')).toThrow(PatternCompileError);
  });

  it('ô giữ chỗ lạ bị từ chối và báo danh sách hợp lệ', () => {
    expect(() => compilePattern('{unknown}')).toThrow(/Allowed placeholders/);
  });

  it('cùng một ô giữ chỗ xuất hiện hai lần bị từ chối', () => {
    expect(() => compilePattern('{name} - {name}')).toThrow(/appears twice/);
  });
});

describe('thứ tự ưu tiên khi khớp', () => {
  it('"[Phase] Design Review" khớp Design Review chứ không khớp Design', () => {
    // matchPriority 10 < 50 nên Design Review thắng
    const r = parse('[Phase] Design Review');
    expect(r.phaseCode).toBe('TESTING');
    expect(r.winningRule?.keyword).toBe('Design Review');
  });

  it('cùng matchPriority thì TỪ KHOÁ DÀI HƠN thắng', () => {
    const r = parse('[Phase] 基本設計', {
      matchRules: [
        { keyword: '設計', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 50 },
        { keyword: '基本設計', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 50 },
      ],
    });
    expect(r.phaseCode).toBe('DESIGN');
    expect(r.winningRule?.keyword).toBe('基本設計');
  });

  it('matchPriority nhỏ hơn thắng dù từ khoá NGẮN hơn', () => {
    const r = parse('[Phase] SuperDesign', {
      matchRules: [
        { keyword: 'SuperDesign', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 90 },
        { keyword: 'Design', matchMode: 'CONTAINS', phaseCode: 'DESIGN', matchPriority: 10 },
      ],
    });
    expect(r.phaseCode).toBe('DESIGN');
  });

  it('displayOrder KHÔNG ảnh hưởng tới kết quả khớp', () => {
    const flipped = parse('[Phase] Design', {
      phaseDefinitions: [
        { phaseCode: 'DESIGN', labelVi: 'Thiết kế', displayOrder: 99 },
        { phaseCode: 'DEVELOPMENT', labelVi: 'Phát triển', displayOrder: 1 },
      ],
    });
    expect(flipped.phaseCode).toBe('DESIGN');
  });

  it('hai luật cùng ưu tiên cùng độ dài thì lấy luật đầu và cảnh báo AMBIGUOUS_PHASE_RULE', () => {
    const r = parse('[Phase] Test', {
      matchRules: [
        { keyword: 'Test', matchMode: 'CONTAINS', phaseCode: 'TESTING', matchPriority: 50 },
        { keyword: 'test', matchMode: 'CONTAINS', phaseCode: 'DEVELOPMENT', matchPriority: 50 },
      ],
    });
    expect(r.phaseCode).toBe('TESTING');
    expect(r.warnings.some((w) => w.code === 'AMBIGUOUS_PHASE_RULE')).toBe(true);
  });
});

describe('lưới an toàn và trường hợp không khớp', () => {
  it('tiêu đề "詳細設計" không có tiền tố vẫn nhận ra DESIGN khi bật fallback', () => {
    const r = parse('詳細設計');
    expect(r.phaseCode).toBe('DESIGN');
    expect(r.matchedPattern).toBeNull(); // không mẫu nào khớp, dùng lưới an toàn
  });

  it('tắt fallback thì tiêu đề không có tiền tố trả UNCLASSIFIED', () => {
    const r = parse('詳細設計', { fallbackScanFullTitle: false });
    expect(r.phaseCode).toBe('UNCLASSIFIED');
    expect(r.rawPhaseLabel).toBeNull();
  });

  it('khớp mẫu nhưng tên lạ thì trả UNCLASSIFIED kèm rawPhaseLabel giữ tên gốc', () => {
    const r = parse('[Phase] Chuẩn bị họp');
    expect(r.phaseCode).toBe('UNCLASSIFIED');
    // PM cần thấy chuỗi này để biết phải thêm từ khoá gì (PRD §2.2.8)
    expect(r.rawPhaseLabel).toBe('Chuẩn bị họp');
    expect(r.matchedPattern).toBe('[Phase] {name}');
  });

  it('khớp không phân biệt hoa thường', () => {
    expect(parse('[Phase] DESIGN').phaseCode).toBe('DESIGN');
    expect(parse('[Phase] design').phaseCode).toBe('DESIGN');
  });

  it('mẫu thứ hai được thử khi mẫu thứ nhất không khớp', () => {
    const r = parse('【基本設計】');
    expect(r.matchedPattern).toBe('【{name}】');
    expect(r.phaseCode).toBe('DESIGN');
  });
});

describe('regex an toàn', () => {
  it('regex dài quá 200 ký tự bị từ chối, KHÔNG ném lỗi', () => {
    const runner = new SafeRegexRunner();
    expect(runner.exec('a'.repeat(MAX_REGEX_LENGTH + 1), 'aaa')).toBeNull();
    expect(runner.getWarnings().some((w) => w.code === 'REGEX_TOO_LONG')).toBe(true);
  });

  it('regex không biên dịch được bị từ chối, KHÔNG ném lỗi', () => {
    const runner = new SafeRegexRunner();
    expect(runner.exec('([unclosed', 'abc')).toBeNull();
    expect(runner.getWarnings().some((w) => w.code === 'REGEX_INVALID')).toBe(true);
  });

  it('regex chạy quá 100ms bị coi là không khớp và ghi REGEX_TIMEOUT', () => {
    // Đồng hồ giả: mỗi lần đọc nhảy 200ms để mô phỏng regex chậm
    let t = 0;
    const runner = new SafeRegexRunner(() => (t += 200));
    expect(runner.exec('abc', 'abc')).toBeNull();
    expect(runner.getWarnings().some((w) => w.code === 'REGEX_TIMEOUT')).toBe(true);
  });

  it('luật timeout 5 lần thì tự vô hiệu hoá', () => {
    let t = 0;
    const runner = new SafeRegexRunner(() => (t += 200));
    for (let i = 0; i < 6; i++) runner.exec('abc', 'abc');

    expect(runner.getWarnings().some((w) => w.code === 'REGEX_DISABLED')).toBe(true);
    // Sau khi vô hiệu hoá thì không sinh thêm cảnh báo timeout nữa
    const before = runner.getWarnings().length;
    runner.exec('abc', 'abc');
    expect(runner.getWarnings().length).toBe(before);
  });

  it('luật chế độ REGEX vẫn khớp được bình thường', () => {
    const r = parse('[Phase] SP-123', {
      matchRules: [
        { keyword: '^sp-\\d+$', matchMode: 'REGEX', phaseCode: 'DEVELOPMENT', matchPriority: 20 },
      ],
    });
    expect(r.phaseCode).toBe('DEVELOPMENT');
  });
});
