import {
  resolveHierarchyProfile,
  roleOfLevel,
  TITLE_SLOTS,
  type ConfigPayload,
  type EffectiveConfig,
  type HierarchyProfile,
  type ValidationIssue,
} from '@app/shared';
// Nguồn DUY NHẤT của giới hạn độ dài regex. Khai lại ở đây sẽ có ngày hai chỗ
// lệch nhau: kiểm tra lúc lưu cho qua mà lúc chạy lại từ chối.
import { MAX_REGEX_LENGTH } from '../parser/safe-regex.js';

/**
 * Gộp bộ Mặc định với bộ ghi đè của project — PRD §2.2.6.
 *
 * Ba phần kế thừa ĐỘC LẬP NHAU. Phần nào project khai (mảng không rỗng) thì lấy
 * của project; không khai thì lấy của Mặc định.
 *
 * Làm kiểu "tất cả hoặc không có gì" là lỗi nghiêm trọng: project chỉ muốn đổi
 * mẫu tiêu đề sẽ mất sạch danh sách Phase → mọi Task rơi vào UNCLASSIFIED. Cấu
 * hình vẫn lưu được, biểu đồ vẫn vẽ — chỉ là rỗng. Lỗi hoàn toàn im lặng.
 */
export function mergeInheritance(
  global: ConfigPayload,
  project: (Partial<ConfigPayload> & { projectKey: string }) | null,
  versions: { globalVersion: number; projectVersion: number | null },
): EffectiveConfig {
  const pick = <K extends keyof ConfigPayload>(
    key: K,
  ): { value: ConfigPayload[K]; inherited: boolean } => {
    const own = project?.[key];
    const hasOwn = Array.isArray(own) ? own.length > 0 : own !== undefined;
    return hasOwn
      ? { value: own as ConfigPayload[K], inherited: false }
      : { value: global[key], inherited: true };
  };

  const titlePatterns = pick('titlePatterns');
  const subtaskPatterns = pick('subtaskPatterns');
  const phaseDefinitions = pick('phaseDefinitions');
  const matchRules = pick('matchRules');
  const signboardColumns = pick('signboardColumns');

  // Profile là MỘT object chứ không phải mảng: project khai (khác null) thì
  // thắng, không khai thì lấy của Mặc định, cả hai cùng bỏ trống thì rơi về
  // DEFAULT_HIERARCHY_PROFILE — nhờ vậy `EffectiveConfig.hierarchyProfile`
  // không bao giờ null và đường chạy không phải tự vệ.
  const ownProfile = project?.hierarchyProfile ?? null;
  const hierarchyProfile = resolveHierarchyProfile(ownProfile ?? global.hierarchyProfile);

  return {
    projectKey: project?.projectKey ?? null,
    globalVersion: versions.globalVersion,
    projectVersion: versions.projectVersion,

    // `fallbackScanFullTitle` là cờ đơn, không phải mảng — project khai thì thắng.
    fallbackScanFullTitle: project?.fallbackScanFullTitle ?? global.fallbackScanFullTitle,

    titlePatterns: titlePatterns.value,
    subtaskPatterns: subtaskPatterns.value,
    phaseDefinitions: phaseDefinitions.value,
    matchRules: matchRules.value,
    signboardColumns: signboardColumns.value,
    hierarchyProfile,

    inherited: {
      titlePatterns: titlePatterns.inherited,
      subtaskPatterns: subtaskPatterns.inherited,
      phaseDefinitions: phaseDefinitions.inherited,
      matchRules: matchRules.inherited,
      signboardColumns: signboardColumns.inherited,
      hierarchyProfile: ownProfile === null,
    },
  };
}

export { MAX_REGEX_LENGTH };

/**
 * Kiểm tra hợp lệ trước khi lưu — bảng ở PRD §2.2.4.
 *
 * Trả về danh sách vấn đề, mỗi cái có `path` để UI neo thông báo vào đúng trường.
 * Hiện lỗi thành banner chung ở đầu trang thì PM không biết sửa dòng nào — nhất
 * là khi có 20 luật khớp.
 */
export function validateConfigPayload(payload: ConfigPayload): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // --- Chặn lưu ---
  if (payload.phaseDefinitions.length === 0) {
    issues.push({
      level: 'ERROR',
      code: 'NO_PHASE_DEFINED',
      message: 'You need at least one Phase. Without one, no Task can be classified.',
      path: 'phaseDefinitions',
    });
  }

  const seenPhase = new Set<string>();
  payload.phaseDefinitions.forEach((p, i) => {
    if (seenPhase.has(p.phaseCode)) {
      issues.push({
        level: 'ERROR',
        code: 'DUPLICATE_PHASE_CODE',
        message: `Phase code "${p.phaseCode}" is declared twice.`,
        path: `phaseDefinitions[${i}].phaseCode`,
      });
    }
    seenPhase.add(p.phaseCode);
  });

  payload.matchRules.forEach((r, i) => {
    if (!seenPhase.has(r.phaseCode)) {
      issues.push({
        level: 'ERROR',
        code: 'ORPHAN_PHASE_CODE',
        message:
          `Rule "${r.keyword}" points at Phase "${r.phaseCode}", which is not defined. ` +
          `Add that Phase to the list, or point the rule at an existing one.`,
        path: `matchRules[${i}].phaseCode`,
      });
    }

    if (r.matchMode === 'REGEX') {
      if (r.keyword.length > MAX_REGEX_LENGTH) {
        issues.push({
          level: 'ERROR',
          code: 'REGEX_TOO_LONG',
          message: `Regex is ${r.keyword.length} characters long; the limit is ${MAX_REGEX_LENGTH}.`,
          path: `matchRules[${i}].keyword`,
        });
      } else if (!isCompilableRegex(r.keyword)) {
        issues.push({
          level: 'ERROR',
          code: 'REGEX_INVALID',
          message: `Regex "${r.keyword}" does not compile.`,
          path: `matchRules[${i}].keyword`,
        });
      }
    }
  });

  const checkPattern = (
    list: readonly { patternText: string }[],
    field: string,
    required: readonly string[],
  ) => {
    list.forEach((p, i) => {
      for (const slot of required) {
        if (!p.patternText.includes(`{${slot}}`)) {
          issues.push({
            level: 'ERROR',
            code: 'PATTERN_MISSING_SLOT',
            message: `Pattern "${p.patternText}" is missing the {${slot}} placeholder.`,
            path: `${field}[${i}].patternText`,
          });
        }
      }
    });
  };
  checkPattern(payload.titlePatterns, 'titlePatterns', ['name']);
  checkPattern(payload.subtaskPatterns, 'subtaskPatterns', ['function', 'task']);

  const seenTask = new Set<string>();
  payload.signboardColumns.forEach((c, i) => {
    if (seenTask.has(c.taskCode)) {
      issues.push({
        level: 'ERROR',
        code: 'DUPLICATE_TASK_CODE',
        message: `Column code "${c.taskCode}" is declared twice.`,
        path: `signboardColumns[${i}].taskCode`,
      });
    }
    seenTask.add(c.taskCode);
  });

  if (payload.hierarchyProfile) {
    issues.push(...validateHierarchyProfile(payload.hierarchyProfile, payload));
  }

  // --- Cảnh báo, vẫn cho lưu ---
  const byKeyword = new Map<string, Set<string>>();
  for (const r of payload.matchRules) {
    const k = r.keyword.normalize('NFKC').toLowerCase();
    (byKeyword.get(k) ?? byKeyword.set(k, new Set()).get(k)!).add(r.phaseCode);
  }
  for (const [keyword, phases] of byKeyword) {
    if (phases.size > 1) {
      issues.push({
        level: 'WARNING',
        code: 'AMBIGUOUS_PHASE_RULE',
        message:
          `Keyword "${keyword}" points at ${phases.size} different Phases ` +
          `(${[...phases].join(', ')}). Which one wins depends on the priority order.`,
      });
    }
  }

  return issues;
}

/**
 * Kiểm tra Hierarchy Profile — chỉ chạy khi payload CÓ khai profile (null =
 * dùng bộ mặc định 3 tầng, khỏi kiểm tra).
 *
 * Nguyên tắc như phần còn lại của file: ERROR khi cấu hình chắc chắn không chạy
 * được, WARNING khi chạy được nhưng dễ là nhầm lẫn.
 */
export function validateHierarchyProfile(
  profile: HierarchyProfile,
  payload: ConfigPayload,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string, path: string) =>
    issues.push({ level: 'ERROR', code, message, path });

  // Vai phải khớp vị trí: đầu ROOT, cuối LEAF, giữa GROUP. Trường `role` chỉ để
  // người đọc config khỏi nhớ quy ước — lệch nhau là gõ nhầm, phải chặn.
  profile.levels.forEach((level, i) => {
    const expected = roleOfLevel(profile, i);
    if (level.role !== expected) {
      err(
        'HIERARCHY_ROLE_MISMATCH',
        `Level ${i + 1} is declared as ${level.role}, but by its position it must be ${expected} ` +
          `(first level = ROOT, last = LEAF, in between = GROUP).`,
        `hierarchyProfile.levels[${i}].role`,
      );
    }
  });

  const { phaseSource } = profile;
  const hasGroup = profile.levels.length >= 3;

  switch (phaseSource.type) {
    case 'GROUP_TITLE': {
      if (!hasGroup) {
        err(
          'PHASE_SOURCE_NEEDS_GROUP',
          'Phase source GROUP_TITLE reads the Phase from a middle (GROUP) level, ' +
            'but this profile has only 2 levels. Use SELF_TITLE_SLOT, FIELD or FIXED instead.',
          'hierarchyProfile.phaseSource.type',
        );
      }
      const g = phaseSource.groupLevel;
      if (g !== undefined && (g < 1 || g > profile.levels.length - 2)) {
        err(
          'PHASE_GROUP_LEVEL_OUT_OF_RANGE',
          `groupLevel ${g} does not point at a GROUP level ` +
            `(valid range: 1..${profile.levels.length - 2}).`,
          'hierarchyProfile.phaseSource.groupLevel',
        );
      }
      break;
    }
    case 'SELF_TITLE_SLOT': {
      const slot = phaseSource.ref ?? 'phase';
      if (!(TITLE_SLOTS as readonly string[]).includes(slot)) {
        err(
          'PHASE_SLOT_UNKNOWN',
          `"${slot}" is not a Sub-task title slot (valid: ${TITLE_SLOTS.join(', ')}).`,
          'hierarchyProfile.phaseSource.ref',
        );
      } else if (
        payload.subtaskPatterns.length > 0 &&
        !payload.subtaskPatterns.some((p) => p.patternText.includes(`{${slot}}`))
      ) {
        // Cảnh báo chứ không chặn: mẫu có thể đang kế thừa từ bộ Mặc định và
        // phần khai ở đây trống — lúc đó không nhìn thấy mẫu thật để so.
        issues.push({
          level: 'WARNING',
          code: 'PHASE_SLOT_NOT_IN_PATTERN',
          message:
            `Phase is read from the {${slot}} slot, but none of the declared Sub-task ` +
            `title patterns contain {${slot}} — every leaf would fall into UNCLASSIFIED.`,
          path: 'hierarchyProfile.phaseSource.ref',
        });
      }
      break;
    }
    case 'FIELD': {
      if (!phaseSource.ref) {
        err(
          'PHASE_FIELD_REQUIRED',
          'Phase source FIELD needs the Jira field to read (e.g. labels, components, customfield_10123).',
          'hierarchyProfile.phaseSource.ref',
        );
      }
      break;
    }
    case 'FIXED': {
      if (!phaseSource.ref) {
        err(
          'PHASE_FIXED_CODE_REQUIRED',
          'Phase source FIXED needs a Phase code to assign to every leaf.',
          'hierarchyProfile.phaseSource.ref',
        );
      } else if (
        payload.phaseDefinitions.length > 0 &&
        !payload.phaseDefinitions.some((p) => p.phaseCode === phaseSource.ref)
      ) {
        err(
          'PHASE_FIXED_CODE_UNDEFINED',
          `Phase code "${phaseSource.ref}" is not in the Phase list.`,
          'hierarchyProfile.phaseSource.ref',
        );
      }
      break;
    }
  }

  const checkDimension = (dim: { source: string; ref: string }, path: string) => {
    if (dim.source === 'TITLE_SLOT' && !(TITLE_SLOTS as readonly string[]).includes(dim.ref)) {
      err(
        'SB_DIMENSION_SLOT_UNKNOWN',
        `"${dim.ref}" is not a Sub-task title slot (valid: ${TITLE_SLOTS.join(', ')}).`,
        `${path}.ref`,
      );
    }
  };
  checkDimension(profile.signboard.row, 'hierarchyProfile.signboard.row');
  checkDimension(profile.signboard.column, 'hierarchyProfile.signboard.column');

  return issues;
}

function isCompilableRegex(src: string): boolean {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

export function hasBlockingError(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.level === 'ERROR');
}
