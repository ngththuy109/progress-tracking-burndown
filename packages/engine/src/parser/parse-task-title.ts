import { UNCLASSIFIED_PHASE, type EffectiveConfig, type MatchRule } from '@app/shared';
import { normalize, normalizePreservingCase } from './normalize.js';
import { compilePatterns } from './compile-pattern.js';
import { SafeRegexRunner, type RegexWarning } from './safe-regex.js';

export interface TaskParseWarning {
  readonly code: string;
  readonly message: string;
}

export interface TaskParseResult {
  readonly phaseCode: string;
  /** Phần chữ bóc ra từ tiêu đề. Giữ dạng gốc để PM đọc được. */
  readonly rawPhaseLabel: string | null;
  /** Mẫu nào đã khớp — màn hình Xem thử (T-09) hiển thị cột này. */
  readonly matchedPattern: string | null;
  /** Luật nào đã thắng — cũng để hiển thị ở Xem thử. */
  readonly winningRule: MatchRule | null;
  readonly warnings: readonly TaskParseWarning[];
}

/**
 * Bộ phân tách tiêu đề, dựng sẵn từ một `EffectiveConfig`.
 *
 * Tạo MỘT thể hiện cho mỗi lần đồng bộ rồi dùng lại cho mọi Task: biên dịch mẫu
 * và đếm timeout của regex chỉ có ý nghĩa khi trạng thái được giữ qua nhiều lần
 * gọi.
 */
export class TaskTitleParser {
  private readonly patterns: Array<{ patternText: string; source: string }>;
  private readonly rules: readonly MatchRule[];
  private readonly runner: SafeRegexRunner;
  private readonly setupWarnings: TaskParseWarning[] = [];

  constructor(
    private readonly config: EffectiveConfig,
    runner?: SafeRegexRunner,
  ) {
    this.runner = runner ?? new SafeRegexRunner();

    const { compiled, errors } = compilePatterns(config.titlePatterns, ['name']);
    this.patterns = compiled;
    for (const e of errors) {
      this.setupWarnings.push({ code: 'PATTERN_INVALID', message: e.message });
    }

    // Sắp xếp SẴN theo quy tắc ưu tiên (PRD §2.2.3) để không phải sắp lại cho
    // từng tiêu đề:
    //   1. matchPriority nhỏ hơn thắng
    //   2. bằng nhau → TỪ KHOÁ DÀI HƠN thắng (cụ thể hơn thì đúng hơn)
    //
    // Độ dài đo trên chuỗi ĐÃ CHUẨN HOÁ — toàn giác và bán giác có độ dài khác
    // nhau, so trên chuỗi gốc sẽ ra thứ tự sai.
    this.rules = [...config.matchRules].sort((a, b) => {
      if (a.matchPriority !== b.matchPriority) return a.matchPriority - b.matchPriority;
      return normalize(b.keyword).length - normalize(a.keyword).length;
    });
  }

  get regexWarnings(): readonly RegexWarning[] {
    return this.runner.getWarnings();
  }

  parse(title: string): TaskParseResult {
    const warnings: TaskParseWarning[] = [...this.setupWarnings];

    // --- TẦNG 1: bóc tên giai đoạn ra khỏi tiêu đề ---
    let extracted: string | null = null;
    let matchedPattern: string | null = null;

    for (const p of this.patterns) {
      const m = this.runner.exec(p.source, normalizePreservingCase(title));
      const groups = m?.groups as Record<string, string> | undefined;
      if (groups?.['name']) {
        extracted = groups['name'].trim();
        matchedPattern = p.patternText;
        break;
      }
    }

    // Lưới an toàn: không mẫu nào khớp thì tìm từ khoá trên TOÀN BỘ tiêu đề.
    // Nhờ vậy tiêu đề trần "詳細設計" (không tiền tố) vẫn nhận ra được DESIGN.
    const haystack = extracted ?? (this.config.fallbackScanFullTitle ? title : null);
    if (haystack === null) {
      return {
        phaseCode: UNCLASSIFIED_PHASE,
        rawPhaseLabel: null,
        matchedPattern: null,
        winningRule: null,
        warnings,
      };
    }

    // --- TẦNG 2: đổi tên vừa bóc ra thành mã Phase ---
    const normalized = normalize(haystack);
    const winners: MatchRule[] = [];

    for (const rule of this.rules) {
      if (this.matches(rule, normalized)) {
        if (winners.length === 0) {
          winners.push(rule);
        } else {
          const w = winners[0]!;
          // Cùng mức ưu tiên VÀ cùng độ dài = thật sự nhập nhằng
          if (
            w.matchPriority === rule.matchPriority &&
            normalize(w.keyword).length === normalize(rule.keyword).length &&
            w.phaseCode !== rule.phaseCode
          ) {
            winners.push(rule);
          }
          break;
        }
      }
    }

    if (winners.length === 0) {
      return {
        phaseCode: UNCLASSIFIED_PHASE,
        // Giữ tên gốc để PM biết cần thêm từ khoá gì (PRD §2.2.8)
        rawPhaseLabel: extracted,
        matchedPattern,
        winningRule: null,
        warnings,
      };
    }

    if (winners.length > 1) {
      warnings.push({
        code: 'AMBIGUOUS_PHASE_RULE',
        message:
          `Title "${title}" matches several rules with the same priority and length: ` +
          winners.map((w) => `"${w.keyword}"→${w.phaseCode}`).join(', ') +
          `. Took the first rule. Adjust matchPriority to make the winner explicit.`,
      });
    }

    return {
      phaseCode: winners[0]!.phaseCode,
      rawPhaseLabel: extracted,
      matchedPattern,
      winningRule: winners[0]!,
      warnings,
    };
  }

  private matches(rule: MatchRule, normalizedHaystack: string): boolean {
    if (rule.matchMode === 'REGEX') {
      return this.runner.exec(rule.keyword, normalizedHaystack) !== null;
    }
    return normalizedHaystack.includes(normalize(rule.keyword));
  }
}
