/**
 * Biên dịch mẫu tiêu đề của PM thành regex — PRD §2.2.1, §2.9.1.
 *
 * ĐÂY LÀ MẤU CHỐT để PM không phải học regex. Họ chỉ gõ đúng HÌNH DẠNG tiêu đề
 * thật, dùng ô giữ chỗ `{name}` cho phần thay đổi:
 *
 *   [Phase] {name}              khớp  "[Phase] Design"          → Design
 *   【{name}】                   khớp  "【基本設計】画面一覧"       → 基本設計
 *   {no}. {name}                khớp  "01. Thiết kế"            → Thiết kế
 *
 * ESCAPE SAI LÀ LỖI NGUY HIỂM NHẤT Ở ĐÂY. Nếu `[Phase]` không được escape thì
 * nó thành character class khớp MỘT ký tự bất kỳ trong "Phase" — mẫu vẫn "chạy"
 * nhưng khớp lung tung, và không có lỗi nào báo ra.
 */

/** Các ô giữ chỗ được phép, kèm biểu thức tương ứng. */
const SLOTS: Readonly<Record<string, string>> = {
  name: '(?<name>.+?)',
  no: '(?<no>\\d+)',
  project: '(?<project>[^\\]］]+)',
  team: '(?<team>[^\\]］]+)',
  phase: '(?<phase>[^\\]］]+)',
  function: '(?<function>[^\\]］]+)',
  task: '(?<task>.+?)',
};

export const ALLOWED_SLOTS = Object.keys(SLOTS);

export class PatternCompileError extends Error {
  constructor(
    message: string,
    public readonly patternText: string,
  ) {
    super(message);
    this.name = 'PatternCompileError';
  }
}

/** Escape mọi ký tự có nghĩa đặc biệt trong regex. */
function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/**
 * Ngoặc vuông toàn giác `［］` kiểu Nhật phải được chấp nhận như ngoặc thường.
 *
 * Không xử lý thì tiêu đề `［PAY］［TeamA］…` sẽ không khớp mẫu `[{project}]…`
 * dù nhìn mắt thường giống hệt.
 */
function widenBrackets(escaped: string): string {
  return escaped.replace(/\\\[/g, '[\\[［]').replace(/\\\]/g, '[\\]］]');
}

/**
 * Biên dịch `patternText` thành nguồn regex.
 *
 * @param required danh sách ô giữ chỗ bắt buộc phải có. Thiếu thì ném lỗi —
 *                 mẫu không có `{name}` thì bóc ra được gì?
 */
export function compilePattern(patternText: string, required: readonly string[] = ['name']): string {
  const seen = new Set<string>();
  let out = '';
  let cursor = 0;

  const slotRe = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;

  while ((m = slotRe.exec(patternText)) !== null) {
    const slotName = m[1]!;

    if (!(slotName in SLOTS)) {
      throw new PatternCompileError(
        `Placeholder "{${slotName}}" is not valid. Allowed placeholders: ` +
          ALLOWED_SLOTS.map((s) => `{${s}}`).join(', '),
        patternText,
      );
    }
    if (seen.has(slotName)) {
      throw new PatternCompileError(
        `Placeholder "{${slotName}}" appears twice in the same pattern.`,
        patternText,
      );
    }
    seen.add(slotName);

    // Phần chữ nguyên văn giữa hai ô giữ chỗ — PHẢI escape
    out += widenBrackets(escapeLiteral(patternText.slice(cursor, m.index)));
    out += SLOTS[slotName];
    cursor = m.index + m[0].length;
  }

  out += widenBrackets(escapeLiteral(patternText.slice(cursor)));

  for (const req of required) {
    if (!seen.has(req)) {
      throw new PatternCompileError(
        `Pattern "${patternText}" is missing the {${req}} placeholder.`,
        patternText,
      );
    }
  }

  // `\s*` hai đầu để chịu được khoảng trắng thừa trong tiêu đề Jira
  return `^\\s*${out}\\s*$`;
}

/** Biên dịch nhiều mẫu, bỏ qua mẫu hỏng và trả về lỗi kèm theo. */
export function compilePatterns(
  patterns: readonly { patternText: string; sortOrder: number }[],
  required: readonly string[] = ['name'],
): { compiled: Array<{ patternText: string; source: string }>; errors: PatternCompileError[] } {
  const compiled: Array<{ patternText: string; source: string }> = [];
  const errors: PatternCompileError[] = [];

  for (const p of [...patterns].sort((a, b) => a.sortOrder - b.sortOrder)) {
    try {
      compiled.push({ patternText: p.patternText, source: compilePattern(p.patternText, required) });
    } catch (err) {
      if (err instanceof PatternCompileError) errors.push(err);
      else throw err;
    }
  }

  return { compiled, errors };
}
