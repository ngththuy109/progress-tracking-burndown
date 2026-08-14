import {
  deriveDefaultTiersFromPhase,
  UNCLASSIFIED_PHASE,
  type EffectiveConfig,
  type GroupTier,
  type SubtaskParseResult,
  type TierPreviewEntry,
} from '@app/shared';
import { TaskTitleParser } from './parse-task-title.js';
import { SubtaskTitleParser } from './parse-subtask-title.js';
import type { SafeRegexRunner } from './safe-regex.js';

/**
 * Suy VECTƠ khoá nhóm (`group_path`) của một lá từ cấu hình tầng —
 * DYNAMIC-TIERS-DESIGN.md §5, §6. Tổng quát việc "gán một `phaseCode"` hôm nay.
 *
 * Dựng SẴN từ một `EffectiveConfig` rồi dùng lại cho mọi lá (như `TaskTitleParser` /
 * `SubtaskTitleParser`): biên dịch mẫu của từng tầng một lần.
 *
 * BẤT BIẾN "không đổi hành vi": config mặc định = đúng MỘT tầng PHASE/`PARENT_TASK_TITLE`
 * (từ `deriveDefaultTiersFromPhase`), và tầng đó lấy thẳng `parentPhase` đã tính sẵn ⇒
 * `groupPath = [parentPhase]`, `phaseCode = parentPhase`. Đây CHÍNH là `phase_code` của
 * lá hôm nay (Sub-task luôn kế thừa Phase của Task cha — PRD §2.9.2), nên byte không đổi.
 */

export interface ResolvedGroupKeys {
  readonly groupPath: string[];
  /** Phần tử tại tầng `role=PHASE`. Vào thẳng `jira_issue.phase_code` (tương thích ngược). */
  readonly phaseCode: string;
}

export interface ResolveGroupKeysInput {
  /** Phase của Task cha, đã tính sẵn ở persist-issues — nguồn cho tầng ✦PHASE/`PARENT_TASK_TITLE`. */
  readonly parentPhase: string;
  /**
   * Tiêu đề NGUYÊN VĂN của Task cha — nguồn cho tầng GROUP/`PARENT_TASK_TITLE` (tầng
   * bóc một chiều KHÁC từ cùng title, VD `[PAY][offshore_P1]Design` → giai đoạn GD1).
   * `null`/vắng (lá mồ côi, scope QUERY) ⇒ tầng đó ra UNCLASSIFIED.
   */
  readonly parentTaskTitle?: string | null;
  /** Tiêu đề CHÍNH lá — nguồn cho tầng `SELF_TITLE` / `SUBTASK_TITLE_TOKEN` (§2.4–2.5). */
  readonly leafTitle: string;
  /** Nhãn (labels) Jira của lá — nguồn cho tầng `LABEL`. */
  readonly leafLabels?: readonly string[];
}

/** Token trong mẫu tiêu đề Sub-task → trường tương ứng của `SubtaskParseResult`. */
const TOKEN_FIELD: Record<string, (p: SubtaskParseResult) => string | null> = {
  project: (p) => p.sbProject,
  team: (p) => p.sbTeam,
  phase: (p) => p.sbPhaseRaw,
  function: (p) => p.functionKey,
  task: (p) => p.sbTaskRaw,
};

export class GroupKeyResolver {
  private readonly tiers: readonly GroupTier[];
  /** Vị trí tầng `role=PHASE` trong `tiers` (đã sắp theo `tierOrder`). -1 nếu vắng. */
  private readonly phaseTierIndex: number;
  /** Parser dựng SẴN cho tầng `SELF_TITLE`; `null` cho tầng không cần parse tiêu đề lá. */
  private readonly selfParsers: readonly (TaskTitleParser | null)[];
  /**
   * Parser dựng SẴN cho tầng GROUP nguồn `PARENT_TASK_TITLE` — bóc một chiều KHÁC
   * (giai đoạn, stream…) từ title Task cha bằng mẫu/luật RIÊNG của tầng. Tầng ✦PHASE
   * cùng nguồn thì KHÔNG có parser ở đây: nó lấy thẳng `parentPhase` đã tính (bất
   * biến byte-identical — phase_code phải đúng bằng kết quả của cấu hình Phase).
   */
  private readonly parentParsers: readonly (TaskTitleParser | null)[];
  /** Parser Sub-task dùng chung cho mọi tầng `SUBTASK_TITLE_TOKEN`; `null` nếu không có tầng nào. */
  private readonly subtaskParser: SubtaskTitleParser | null;

  constructor(config: EffectiveConfig, runner?: SafeRegexRunner) {
    // Vắng `tiers` (payload cũ, hoặc mergeInheritance chưa mang tầng) ⇒ mirror 1 tầng
    // Phase từ phase_* — cùng nguồn với Vòng 1 (repository/backfill/seed).
    const tiers = (config.tiers && config.tiers.length > 0
      ? config.tiers
      : deriveDefaultTiersFromPhase(config)
    )
      .slice()
      .sort((a, b) => a.tierOrder - b.tierOrder);
    this.tiers = tiers;

    // Đúng MỘT tầng role=PHASE (bất biến quyết định #3). Vắng ⇒ -1, phaseCode = UNCLASSIFIED.
    this.phaseTierIndex = tiers.findIndex((t) => t.role === 'PHASE');

    this.selfParsers = tiers.map((t) =>
      t.sourceType === 'SELF_TITLE'
        ? new TaskTitleParser(tierAsEffectiveConfig(t, config), runner)
        : null,
    );

    this.parentParsers = tiers.map((t) =>
      t.sourceType === 'PARENT_TASK_TITLE' && t.role !== 'PHASE'
        ? new TaskTitleParser(tierAsEffectiveConfig(t, config), runner)
        : null,
    );

    // Chỉ dựng parser Sub-task khi thực sự có tầng token — tránh cảnh báo/chi phí thừa.
    this.subtaskParser = tiers.some((t) => t.sourceType === 'SUBTASK_TITLE_TOKEN')
      ? new SubtaskTitleParser(config, runner)
      : null;
  }

  resolve(input: ResolveGroupKeysInput): ResolvedGroupKeys {
    const groupPath = this.tiers.map((t, i) => {
      switch (t.sourceType) {
        // Tầng ✦PHASE dựa tiêu đề Task cha = Phase của cha đã parse sẵn — KHÔNG parse
        // lại, giữ byte-identical với mô hình 3 tầng hôm nay (persist-issues.phaseOfTask).
        // Tầng GROUP cùng nguồn thì parse title cha bằng mẫu/luật RIÊNG của tầng — bóc
        // một chiều khác từ cùng title (VD "[PAY][offshore_P1]Design" → giai đoạn GD1).
        case 'PARENT_TASK_TITLE': {
          const parser = this.parentParsers[i] ?? null;
          if (parser === null) return input.parentPhase;
          const title = input.parentTaskTitle?.trim() ?? '';
          // Lá không có Task cha (mồ côi, scope QUERY) ⇒ không có gì để bóc. Không
          // đoán bừa — UNCLASSIFIED hiện rõ trên biểu đồ.
          return title === '' ? UNCLASSIFIED_PHASE : parser.parse(title).phaseCode;
        }
        // Bóc khoá từ CHÍNH tiêu đề lá bằng đúng bộ máy parse Task (mẫu tiêu đề + luật
        // từ khoá của tầng). Dùng cho project 2 tầng / phẳng (§2.4–2.5).
        case 'SELF_TITLE':
          return this.selfParsers[i]!.parse(input.leafTitle).phaseCode;
        // Lấy một token trong mẫu tiêu đề Sub-task ({project}/{team}/{function}…).
        case 'SUBTASK_TITLE_TOKEN':
          return resolveToken(this.subtaskParser, t, input);
        // Lấy từ nhãn Jira của lá theo tiền tố (VD `team:` → "alpha").
        case 'LABEL':
          return resolveLabel(t, input.leafLabels ?? []);
        default:
          // CUSTOM_FIELD để v2 (cần map field như wbs_*). Fail-fast — không đoán bừa.
          throw new Error(
            `GroupKeyResolver: nguồn khoá "${t.sourceType}" (tầng ${t.code}) chưa hỗ trợ.`,
          );
      }
    });

    const phaseCode =
      this.phaseTierIndex >= 0 ? groupPath[this.phaseTierIndex]! : UNCLASSIFIED_PHASE;
    return { groupPath, phaseCode };
  }
}

/**
 * Ánh xạ một tầng nhóm sang hình dạng `EffectiveConfig` để DÙNG LẠI `TaskTitleParser`
 * (vốn chỉ đọc `titlePatterns`, `matchRules`, `fallbackScanFullTitle`). Các trường khác
 * kế thừa từ `base` — vô hại vì parser không đọc tới.
 */
function tierAsEffectiveConfig(tier: GroupTier, base: EffectiveConfig): EffectiveConfig {
  return {
    ...base,
    titlePatterns: tier.titlePatterns.map((p) => ({
      patternText: p.patternText,
      sortOrder: p.sortOrder,
    })),
    matchRules: tier.rules.map((r) => ({
      keyword: r.keyword,
      matchMode: r.matchMode,
      phaseCode: r.groupCode,
      matchPriority: r.matchPriority,
    })),
  };
}

/**
 * Xem thử cấu trúc tầng cho MỘT tiêu đề Task (màn Cấu trúc tầng, chưa lưu).
 *
 * Chỉ chạy được những tầng bóc từ TIÊU ĐỀ TASK CHA — đúng dữ liệu người dùng dán
 * vào. Tầng nguồn khác (`SELF_TITLE`, token, label, custom field) trả `resolved:
 * null`: chúng cần dữ liệu của LÁ, đoán từ title Task là bịa. TOÀN PHẦN — không
 * ném lỗi với nguồn chưa hỗ trợ (khác `GroupKeyResolver.resolve`, vốn fail-fast
 * lúc ingest thật).
 */
export function previewTierKeys(
  config: EffectiveConfig,
  tiers: readonly GroupTier[],
  taskTitle: string,
  runner?: SafeRegexRunner,
): { parentPhase: string; entries: TierPreviewEntry[] } {
  // Phase theo cấu hình Phase đang hiệu lực — đúng đường persist-issues.phaseOfTask.
  const parentPhase = new TaskTitleParser(config, runner).parse(taskTitle).phaseCode;

  const entries = tiers
    .slice()
    .sort((a, b) => a.tierOrder - b.tierOrder)
    .map((t): TierPreviewEntry => {
      const resolved =
        t.sourceType !== 'PARENT_TASK_TITLE'
          ? null
          : t.role === 'PHASE'
            ? parentPhase
            : taskTitle.trim() === ''
              ? UNCLASSIFIED_PHASE
              : new TaskTitleParser(tierAsEffectiveConfig(t, config), runner).parse(taskTitle)
                  .phaseCode;
      return { code: t.code, labelVi: t.labelVi, sourceType: t.sourceType, resolved };
    });

  return { parentPhase, entries };
}

/** Lấy khoá cho tầng `SUBTASK_TITLE_TOKEN`: parse tiêu đề lá rồi lấy token đã khai. */
function resolveToken(
  parser: SubtaskTitleParser | null,
  tier: GroupTier,
  input: ResolveGroupKeysInput,
): string {
  if (parser === null) {
    throw new Error(`GroupKeyResolver: tầng ${tier.code} khai SUBTASK_TITLE_TOKEN nhưng thiếu parser.`);
  }
  const token = String(tier.sourceConfig?.['token'] ?? '').toLowerCase();
  const pick = TOKEN_FIELD[token];
  if (pick === undefined) {
    throw new Error(
      `GroupKeyResolver: tầng ${tier.code} khai token "${token}" không hợp lệ ` +
        `(chọn một trong: ${Object.keys(TOKEN_FIELD).join(', ')}).`,
    );
  }
  const raw = pick(parser.parse(input.leafTitle, input.parentPhase));
  return raw !== null && raw.trim() !== '' ? raw : UNCLASSIFIED_PHASE;
}

/** Lấy khoá cho tầng `LABEL`: nhãn đầu tiên khớp tiền tố, đã cắt tiền tố. */
function resolveLabel(tier: GroupTier, labels: readonly string[]): string {
  const prefix = String(tier.sourceConfig?.['prefix'] ?? '');
  for (const label of labels) {
    // Không khai tiền tố ⇒ lấy nhãn đầu tiên nguyên vẹn.
    if (prefix === '') return label;
    if (label.startsWith(prefix)) return label.slice(prefix.length);
  }
  return UNCLASSIFIED_PHASE;
}
