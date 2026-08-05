import {
  RECOMPUTE_SECONDS_PER_EPIC,
  UNCLASSIFIED_LABEL,
  type ApiWarning,
  type ConfigPayload,
  type PreviewResponse,
  type PreviewRow,
  type PreviewRowStatus,
} from '@app/shared';
import { UNCLASSIFIED_PHASE } from '@app/shared';
import { TaskTitleParser, mergeInheritance, validateConfigPayload } from '@app/engine';

/**
 * Xem thử cấu hình nháp — PRD §2.2.5, Phụ lục B.
 *
 * VÌ SAO TÍNH NĂNG NÀY BẮT BUỘC PHẢI CÓ: không có nó thì PM sửa xong phải đợi
 * tới job đêm hôm sau mới biết đúng hay sai. Cấu hình "đơn giản" trở thành
 * không dùng được trên thực tế.
 *
 * Toàn bộ file này là HÀM THUẦN: nhận danh sách Task đã nạp sẵn, trả về dữ liệu.
 * Không chạm database. Đó cũng là lý do "xem thử ghi nhầm vào DB" — lỗi nặng
 * nhất có thể mắc ở card này — không thể xảy ra: chỗ này không có gì để ghi.
 */

export interface PreviewTask {
  readonly taskKey: string;
  readonly epicKey: string;
  readonly title: string;
  /** `phase_code` đang lưu trong DB, để so ra `CHANGED` hay `UNCHANGED`. */
  readonly currentPhaseCode: string;
}

export interface BuildPreviewArgs {
  readonly projectKey: string | null;
  /** Cấu hình PM đang sửa, CHƯA lưu. */
  readonly draft: ConfigPayload;
  /**
   * Bộ Mặc định đang hiệu lực.
   *
   * BẮT BUỘC phải có khi `projectKey !== null`. Xem thử bản nháp của project mà
   * không gộp kế thừa sẽ cho kết quả KHÁC với lúc lưu thật: bản nháp bỏ trống
   * danh sách Phase sẽ hiện toàn UNCLASSIFIED, trong khi lưu xong lại kế thừa
   * đầy đủ từ Mặc định. Xem thử mà nói dối thì thà không có.
   */
  readonly globalConfig: ConfigPayload | null;
  readonly tasks: readonly PreviewTask[];
  /** Số dòng tối đa trả về. Phần tóm tắt vẫn đếm trên toàn bộ `tasks`. */
  readonly limit: number;
}

export function buildPreview(args: BuildPreviewArgs): PreviewResponse {
  const { projectKey, draft, globalConfig, tasks, limit } = args;

  // Gộp kế thừa ĐÚNG như lúc lưu thật, nếu không xem thử sẽ nói dối.
  const effective =
    projectKey === null
      ? mergeInheritance(draft, null, { globalVersion: 0, projectVersion: null })
      : mergeInheritance(globalConfig ?? draft, { ...draft, projectKey }, {
          globalVersion: 0,
          projectVersion: null,
        });

  const warnings: ApiWarning[] = [];

  // Đưa CẢ lỗi chặn lẫn cảnh báo vào đây. PM cần biết mình sắp không lưu được
  // ngay lúc xem thử, chứ không phải sau khi bấm Lưu rồi mới nhận HTTP 400.
  for (const issue of validateConfigPayload(draft)) {
    warnings.push({ code: issue.code, message: issue.message });
  }

  const labelOf = new Map(effective.phaseDefinitions.map((p) => [p.phaseCode, p.labelVi]));
  const parser = new TaskTitleParser(effective);

  const rows: PreviewRow[] = [];
  const affectedEpics = new Set<string>();
  let unchanged = 0;
  let changed = 0;
  let stillUnclassified = 0;

  for (const task of tasks) {
    const parsed = parser.parse(task.title);
    const status = rowStatus(task.currentPhaseCode, parsed.phaseCode);

    if (status === 'CHANGED') {
      changed += 1;
      affectedEpics.add(task.epicKey);
    } else if (status === 'STILL_UNCLASSIFIED') {
      stillUnclassified += 1;
    } else {
      unchanged += 1;
    }

    // Cắt bớt dòng trả về nhưng VẪN đếm đủ ở trên — project lớn có hàng nghìn
    // Task, trả hết một lần sẽ làm treo màn hình.
    if (rows.length < limit) {
      rows.push({
        taskKey: task.taskKey,
        originalTitle: task.title,
        matchedPattern: parsed.matchedPattern,
        extractedName: parsed.rawPhaseLabel,
        winningRule: parsed.winningRule
          ? {
              keyword: parsed.winningRule.keyword,
              mode: parsed.winningRule.matchMode,
              priority: parsed.winningRule.matchPriority,
            }
          : null,
        resultPhaseCode: parsed.phaseCode,
        resultLabel: labelOf.get(parsed.phaseCode) ?? UNCLASSIFIED_LABEL,
        previousPhaseCode: task.currentPhaseCode,
        status,
      });
    }
  }

  // Cảnh báo của bộ phân tách gom theo MÃ, không lặp cho từng Task — một luật
  // nhập nhằng sẽ sinh cảnh báo trên cả nghìn dòng và làm ngập danh sách.
  const seen = new Set(warnings.map((w) => w.code));
  for (const w of parser.regexWarnings) {
    if (seen.has(w.code)) continue;
    seen.add(w.code);
    warnings.push({ code: w.code, message: w.message });
  }

  return {
    projectKey,
    totalTasks: tasks.length,
    summary: {
      unchanged,
      changed,
      stillUnclassified,
      affectedEpics: affectedEpics.size,
      estimatedRecomputeSeconds: affectedEpics.size * RECOMPUTE_SECONDS_PER_EPIC,
    },
    warnings,
    rows,
  };
}

function rowStatus(previous: string, next: string): PreviewRowStatus {
  if (previous === next) {
    // Vẫn không nhận diện được sau khi sửa — đây là thứ PM cần nhìn thấy nhất,
    // nên tách riêng khỏi "không đổi" dù về mặt kỹ thuật cả hai đều không đổi.
    return next === UNCLASSIFIED_PHASE ? 'STILL_UNCLASSIFIED' : 'UNCHANGED';
  }
  return 'CHANGED';
}
