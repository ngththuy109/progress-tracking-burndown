import {
  deriveDefaultTiersFromPhase,
  UNCLASSIFIED_PHASE,
  type EffectiveConfig,
  type GroupTier,
} from '@app/shared';
import { TaskTitleParser } from './parse-task-title.js';
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
  /** Phase của Task cha, đã tính sẵn ở persist-issues — nguồn cho tầng `PARENT_TASK_TITLE`. */
  readonly parentPhase: string;
  /** Tiêu đề CHÍNH lá — nguồn cho tầng `SELF_TITLE` (case project 2 tầng / phẳng §2.4–2.5). */
  readonly leafTitle: string;
}

export class GroupKeyResolver {
  private readonly tiers: readonly GroupTier[];
  /** Vị trí tầng `role=PHASE` trong `tiers` (đã sắp theo `tierOrder`). -1 nếu vắng. */
  private readonly phaseTierIndex: number;
  /** Parser dựng SẴN cho tầng `SELF_TITLE`; `null` cho tầng không cần parse tiêu đề lá. */
  private readonly selfParsers: readonly (TaskTitleParser | null)[];

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
  }

  resolve(input: ResolveGroupKeysInput): ResolvedGroupKeys {
    const groupPath = this.tiers.map((t, i) => {
      switch (t.sourceType) {
        // Tầng dựa tiêu đề Task cha = Phase của cha đã parse sẵn — KHÔNG parse lại, giữ
        // byte-identical với mô hình 3 tầng hôm nay (persist-issues.phaseOfTask).
        case 'PARENT_TASK_TITLE':
          return input.parentPhase;
        // Bóc khoá từ CHÍNH tiêu đề lá bằng đúng bộ máy parse Task (mẫu tiêu đề + luật
        // từ khoá của tầng). Dùng cho project 2 tầng / phẳng (§2.4–2.5).
        case 'SELF_TITLE':
          return this.selfParsers[i]!.parse(input.leafTitle).phaseCode;
        default:
          // SUBTASK_TITLE_TOKEN / LABEL / CUSTOM_FIELD chỉ tới được khi Config UI đa
          // tầng ra đời (Vòng 3). Fail-fast — không đoán bừa một khoá sai.
          throw new Error(
            `GroupKeyResolver: nguồn khoá "${t.sourceType}" (tầng ${t.code}) chưa hỗ trợ ở Vòng 2.`,
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
