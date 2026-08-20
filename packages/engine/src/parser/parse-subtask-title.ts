import {
  UNCLASSIFIED_PHASE,
  type EffectiveConfig,
  type SubtaskParseResult,
  type SubtaskParseWarning,
} from '@app/shared';
import { normalize, normalizePreservingCase } from './normalize.js';
import { compilePattern, PatternCompileError } from './compile-pattern.js';
import { SafeRegexRunner, type RegexWarning } from './safe-regex.js';
import { TaskTitleParser } from './parse-task-title.js';
import { toFunctionKey } from './function-key.js';

/**
 * Mẫu tiêu đề Sub-task bắt buộc phải có hai ô này — thiếu một trong hai thì
 * không dựng được hàng (Function) hay cột (loại task) nào của Signboard.
 * Trùng đúng với điều kiện kiểm tra lúc lưu cấu hình ở T-06.
 */
const REQUIRED_SLOTS = ['function', 'task'] as const;

/**
 * Bỏ khoảng trắng NGAY CẠNH dấu phân tách `[` `]` `_`.
 *
 * Biểu thức chuẩn ở PRD §2.9.1 có `\s*` giữa các cặp ngoặc, nhưng
 * `compilePattern` escape phần chữ nguyên văn chứ không tự sinh `\s*`. Vì vậy
 * phải kéo cả tiêu đề LẪN mẫu về cùng một dạng "không có khoảng trắng cạnh dấu
 * phân tách" rồi mới so.
 *
 * Phải áp cho CẢ HAI phía. Chỉ áp cho tiêu đề thì mẫu do PM gõ có dấu cách
 * (`[{project}] [{team}]`) sẽ không bao giờ khớp được nữa.
 *
 * Cố ý KHÔNG đụng tới khoảng trắng ở giữa chữ: `[Login Form]` vẫn giữ nguyên
 * dấu cách bên trong.
 */
function tightenDelimiters(s: string): string {
  return s
    .replace(/([\]］])\s+([[［_])/g, '$1$2') // `] [`  và  `] _`
    .replace(/([[［])\s+/g, '$1') // `[ PAY`
    .replace(/\s+([\]］])/g, '$1'); // `PAY ]`
}

/**
 * Bộ phân tách tiêu đề Sub-task, dựng sẵn từ một `EffectiveConfig`.
 *
 * Giống `TaskTitleParser`: tạo MỘT thể hiện cho mỗi lần đồng bộ rồi dùng lại cho
 * mọi Sub-task. Biên dịch mẫu, bảng tra cột và bộ đếm timeout của regex chỉ có
 * ý nghĩa khi trạng thái được giữ qua nhiều lần gọi.
 */
export class SubtaskTitleParser {
  private readonly patterns: Array<{ patternText: string; source: string }> = [];
  private readonly runner: SafeRegexRunner;
  private readonly setupWarnings: SubtaskParseWarning[] = [];
  /** Tra mã cột theo dạng đã chuẩn hoá → mã cột gốc để trả về. */
  private readonly columnByKey = new Map<string, string>();
  /** Chỉ dùng để ĐỐI CHIẾU Phase. Xem chú thích trong constructor. */
  private readonly phaseResolver: TaskTitleParser;

  constructor(config: EffectiveConfig, runner?: SafeRegexRunner) {
    this.runner = runner ?? new SafeRegexRunner();

    for (const p of [...config.subtaskPatterns].sort((a, b) => a.sortOrder - b.sortOrder)) {
      try {
        this.patterns.push({
          // Giữ nguyên chữ PM gõ để báo lại ở `matchedPattern`, chỉ dạng đem đi
          // biên dịch mới bị siết khoảng trắng.
          patternText: p.patternText,
          source: compilePattern(tightenDelimiters(p.patternText), REQUIRED_SLOTS),
        });
      } catch (err) {
        if (!(err instanceof PatternCompileError)) throw err;
        this.setupWarnings.push({ code: 'SUBTASK_PATTERN_INVALID', message: err.message });
      }
    }

    if (this.patterns.length === 0) {
      // Không có mẫu nào dùng được thì MỌI Sub-task đều UNPARSED và bảng
      // Signboard trống trơn. Trạng thái đó nhìn y hệt "chưa có dữ liệu", nên
      // phải nói thẳng ra nguyên nhân.
      this.setupWarnings.push({
        code: 'NO_SUBTASK_PATTERN',
        message:
          'No usable Sub-task title pattern. Every Sub-task will be marked UNPARSED ' +
          'and the Signboard will be empty — check the configuration.',
      });
    }

    for (const c of config.signboardColumns) {
      const key = normalize(c.taskCode);
      const existing = this.columnByKey.get(key);
      if (existing !== undefined) {
        // Kiểm tra lúc lưu chỉ chặn trùng y hệt, không chặn trùng SAU chuẩn hoá.
        // `Create` và `Ｃreate` là hai dòng khác nhau trên màn hình cấu hình
        // nhưng ở đây gộp làm một — im lặng thì mất hẳn một cột.
        this.setupWarnings.push({
          code: 'AMBIGUOUS_TASK_COLUMN',
          message:
            `Columns "${existing}" and "${c.taskCode}" collide after normalization. ` +
            `Kept the first-declared column "${existing}"; rename one of the two.`,
        });
        continue;
      }
      this.columnByKey.set(key, c.taskCode);
    }

    // Bộ suy đoán Phase từ chữ trong tiêu đề. Hai chỗ cố ý ghi đè cấu hình:
    //
    //   • `titlePatterns: []` — `sbPhaseRaw` đã là phần chữ BÓC SẴN ("Development"),
    //     không còn tiền tố nào để bóc nữa. Bỏ trống tầng 1 để rơi thẳng xuống
    //     tầng 2 (khớp từ khoá) — đúng phần cần dùng lại của T-07.
    //
    //   • `fallbackScanFullTitle: true` — cờ này vốn dành cho tiêu đề TASK. Nếu
    //     PM tắt nó, việc đối chiếu Phase của Sub-task sẽ ngừng hoạt động trong
    //     im lặng: `PHASE_MISMATCH` không bao giờ xuất hiện nữa và trông y như
    //     mọi tiêu đề đều khớp.
    //
    // Dùng CHUNG `runner` để bộ đếm timeout tính trên toàn hệ thống.
    this.phaseResolver = new TaskTitleParser(
      { ...config, titlePatterns: [], fallbackScanFullTitle: true },
      this.runner,
    );
  }

  get regexWarnings(): readonly RegexWarning[] {
    return this.runner.getWarnings();
  }

  /**
   * @param parentPhaseCode Phase của Task cha — NGUỒN SỰ THẬT DUY NHẤT về Phase.
   */
  parse(title: string, parentPhaseCode: string): SubtaskParseResult {
    const warnings: SubtaskParseWarning[] = [...this.setupWarnings];
    const haystack = tightenDelimiters(normalizePreservingCase(title));

    for (const p of this.patterns) {
      const groups = this.runner.exec(p.source, haystack)?.groups as
        | Record<string, string>
        | undefined;
      if (!groups) continue;

      const functionName = groups['function']?.trim();
      const rawTask = groups['task']?.trim();
      // Khớp được mẫu nhưng một trong hai phần rỗng thì chẳng dựng được ô nào.
      // Thử mẫu tiếp theo thay vì trả về kết quả rỗng ruột.
      if (!functionName || !rawTask) continue;

      const sbPhaseRaw = groups['phase']?.trim() || null;
      if (sbPhaseRaw !== null) {
        this.comparePhase(sbPhaseRaw, parentPhaseCode, title, warnings);
      }

      // Khớp CHÍNH XÁC, không phải "chứa" (PRD §2.9.3). `BALReview` và
      // `FixCommentBAL` quá giống nhau; khớp kiểu chứa sẽ sinh nhập nhằng.
      const taskType = this.columnByKey.get(normalize(rawTask)) ?? null;

      return {
        phaseCode: parentPhaseCode,
        sbProject: groups['project']?.trim() || null,
        sbTeam: groups['team']?.trim() || null,
        sbPhaseRaw,
        functionName,
        functionKey: toFunctionKey(functionName),
        taskType,
        sbTaskRaw: rawTask,
        sbParseStatus: taskType === null ? 'UNKNOWN_TASK_TYPE' : 'OK',
        matchedPattern: p.patternText,
        warnings,
      };
    }

    // Không mẫu nào khớp. Sub-task này KHÔNG lên được Signboard, nhưng vẫn được
    // cộng dồn đầy đủ vào Burndown (C-11, PRD E-27) — công việc là có thật, chỉ
    // có tiêu đề là đặt sai.
    return {
      phaseCode: parentPhaseCode,
      sbProject: null,
      sbTeam: null,
      sbPhaseRaw: null,
      functionName: null,
      functionKey: null,
      taskType: null,
      sbTaskRaw: null,
      sbParseStatus: 'UNPARSED',
      matchedPattern: null,
      warnings,
    };
  }

  /**
   * So `[Phase]` trong tiêu đề với Phase của Task cha — PRD §2.9.2, E-28.
   *
   * Chỉ ghi cảnh báo. Kết quả trả về LUÔN dùng `parentPhaseCode`.
   */
  private comparePhase(
    sbPhaseRaw: string,
    parentPhaseCode: string,
    title: string,
    warnings: SubtaskParseWarning[],
  ): void {
    // Cố ý bỏ `warnings` của bộ suy đoán: nó chỉ sinh ra `AMBIGUOUS_PHASE_RULE`,
    // mà lỗi đó đã được báo một lần lúc lưu cấu hình và một lần khi phân tách
    // Task cha. Lặp lại cho từng Sub-task chỉ làm ngập danh sách.
    const guessed = this.phaseResolver.parse(sbPhaseRaw).phaseCode;

    // UNCLASSIFIED nghĩa là KHÔNG BIẾT, không phải LỆCH. Chữ trong tiêu đề có
    // thể chỉ là cách viết chưa có luật khớp. Báo mismatch ở đây là đoán bừa
    // (C-10) và sẽ chôn mất những ca lệch thật.
    if (guessed === UNCLASSIFIED_PHASE || guessed === parentPhaseCode) return;

    warnings.push({
      code: 'PHASE_MISMATCH',
      message:
        `Sub-task title "${title}" says Phase "${sbPhaseRaw}" (recognized as ${guessed}) ` +
        `but the parent Task belongs to ${parentPhaseCode}. Used the parent Task's Phase ` +
        `${parentPhaseCode}; fix the title in Jira so they match.`,
    });
  }
}
