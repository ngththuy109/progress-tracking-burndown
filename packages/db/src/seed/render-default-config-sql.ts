import { DEFAULT_CALENDARS } from './work-calendar.seed.js';
import { DEFAULT_PHASE_CONFIG } from './default-phase-config.js';

/**
 * Sinh SQL thuần để seed bộ Mặc định — chạy trực tiếp bằng `psql`, KHÔNG cần
 * Node/tsx/Prisma.
 *
 * VÌ SAO SINH RA THAY VÌ VIẾT TAY: `DEFAULT_PHASE_CONFIG` là nguồn sự thật duy
 * nhất. Một file `.sql` chép tay cùng dữ liệu sẽ có ngày lệch với hằng số TS mà
 * không ai hay (đúng loại lỗi im lặng mà cả repo này dựng test để chặn). Ở đây
 * SQL được SINH từ chính hằng số đó, và một test giữ file `.sql` đã commit luôn
 * khớp với hàm này — sửa hằng số mà quên sinh lại là test đỏ ngay.
 *
 * Hàm THUẦN: không đọc đồng hồ, không random, cùng đầu vào cho cùng đầu ra —
 * nhờ vậy so khớp theo từng byte được.
 */

/** Đường dẫn (tương đối gốc repo) của file SQL đã sinh. Một chỗ khai duy nhất. */
export const SEED_SQL_RELATIVE_PATH = 'tools/db/seed-default-config.sql';

/** Bọc chuỗi thành literal SQL an toàn: nhân đôi dấu nháy đơn. */
function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Chuỗi hoặc `NULL` khi vắng — cho cột nullable (`label_ja`, `color_hex`). */
function qOrNull(s: string | null | undefined): string {
  return s == null ? 'NULL' : q(s);
}

export function renderDefaultConfigSql(): string {
  const c = DEFAULT_PHASE_CONFIG;

  const titlePatternRows = c.titlePatterns
    .map((p) => `    (set_id, ${q(p.patternText)}, '', ${p.sortOrder})`)
    .join(',\n');

  const subtaskPatternRows = c.subtaskPatterns
    .map((p) => `    (set_id, ${q(p.patternText)}, '', ${p.sortOrder})`)
    .join(',\n');

  const phaseRows = c.phaseDefinitions
    .map(
      (p) =>
        `    (set_id, ${q(p.phaseCode)}, ${q(p.labelVi)}, ${qOrNull(p.labelJa)}, ${qOrNull(p.colorHex)}, ${p.displayOrder})`,
    )
    .join(',\n');

  const ruleRows = c.matchRules
    .map(
      (r) =>
        `    (set_id, ${q(r.keyword)}, ${q(r.matchMode)}, ${q(r.phaseCode)}, ${r.matchPriority})`,
    )
    .join(',\n');

  const columnRows = c.signboardColumns
    .map(
      (col) =>
        `    (set_id, ${q(col.taskCode)}, ${q(col.labelVi)}, ${qOrNull(col.labelJa)}, ${q(col.side)}, ${col.displayOrder})`,
    )
    .join(',\n');

  // Bộ Mặc định hiện KHÔNG seed thứ tự Sub-phase (thứ của từng dự án), nhưng
  // renderer vẫn phải biết phần này — hằng số có dữ liệu mà quên sinh SQL là
  // đúng loại lệch im lặng file này sinh ra để chặn.
  const subPhaseRows = c.subPhaseOrders
    .map((s) => `    (set_id, ${q(s.phaseCode)}, ${q(s.subPhaseCode)}, ${s.displayOrder})`)
    .join(',\n');
  const subPhaseInsert =
    c.subPhaseOrders.length === 0
      ? ''
      : `
  INSERT INTO sub_phase_order (config_set_id, phase_code, sub_phase_code, display_order) VALUES
${subPhaseRows};
`;

  const calendarRows = DEFAULT_CALENDARS.map(
    (cal) => `  (${q(cal.calendarId)}, ${q(cal.timezone)}, ${cal.workdaysMask}, ${cal.hoursPerDay})`,
  ).join(',\n');

  const fallback = c.fallbackScanFullTitle ? 'TRUE' : 'FALSE';

  return `-- ⚠️ FILE ĐƯỢC SINH TỰ ĐỘNG — ĐỪNG SỬA TAY.
-- Nguồn: packages/db/src/seed/default-phase-config.ts (DEFAULT_PHASE_CONFIG)
--        packages/db/src/seed/work-calendar.seed.ts   (DEFAULT_CALENDARS)
-- Sinh lại sau khi đổi các hằng số trên: pnpm db:seed:sql:gen
--
-- MỤC ĐÍCH: seed dữ liệu Mặc định bằng SQL thuần, chạy TRỰC TIẾP không cần
-- Node/tsx/Prisma — tương đương \`pnpm db:seed\`:
--
--     psql "$DATABASE_URL" -f ${SEED_SQL_RELATIVE_PATH}
--
-- Idempotent: đã có bộ Mặc định (GLOBAL) đang hiệu lực thì BỎ QUA; lịch làm
-- việc dùng upsert. An toàn chạy lại nhiều lần.

BEGIN;

-- 1) Bộ nhận diện Phase Mặc định (GLOBAL) — chỉ tạo khi CHƯA có bản nào hiệu lực.
DO $$
DECLARE
  set_id       BIGINT;
  next_version INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM phase_config_set WHERE scope = 'GLOBAL' AND is_active = TRUE) THEN
    RAISE NOTICE '[seed] Bộ Mặc định (GLOBAL) đã hiệu lực — bỏ qua.';
    RETURN;
  END IF;

  -- Số version kế tiếp, phòng khi còn bản cũ đã tắt (khớp cách saveNewVersion tính).
  SELECT COALESCE(MAX(version), 0) + 1 INTO next_version
    FROM phase_config_set WHERE scope = 'GLOBAL' AND project_key IS NULL;

  INSERT INTO phase_config_set
    (scope, project_key, version, is_active, fallback_scan_full_title, created_by, note)
  VALUES
    ('GLOBAL', NULL, next_version, TRUE, ${fallback}, 'system', 'Bộ Mặc định khởi tạo (seed SQL).')
  RETURNING id INTO set_id;

  -- compiled_regex để chuỗi rỗng: T-07 sinh regex thật khi biên dịch mẫu.
  INSERT INTO phase_title_pattern (config_set_id, pattern_text, compiled_regex, sort_order) VALUES
${titlePatternRows};

  INSERT INTO subtask_title_pattern (config_set_id, pattern_text, compiled_regex, sort_order) VALUES
${subtaskPatternRows};

  INSERT INTO phase_definition (config_set_id, phase_code, label_vi, label_ja, color_hex, display_order) VALUES
${phaseRows};

  INSERT INTO phase_match_rule (config_set_id, keyword, match_mode, phase_code, match_priority) VALUES
${ruleRows};

  INSERT INTO signboard_column (config_set_id, task_code, label_vi, label_ja, side, display_order) VALUES
${columnRows};
${subPhaseInsert}
  RAISE NOTICE '[seed] Đã tạo bộ Mặc định (GLOBAL) version %.', next_version;
END $$;

-- 2) Lịch làm việc Mặc định — upsert theo khoá tự nhiên (idempotent).
INSERT INTO work_calendar (calendar_id, timezone, workdays_mask, hours_per_day) VALUES
${calendarRows}
ON CONFLICT (calendar_id) DO UPDATE SET
  timezone      = EXCLUDED.timezone,
  workdays_mask = EXCLUDED.workdays_mask,
  hours_per_day = EXCLUDED.hours_per_day;

COMMIT;
`;
}
