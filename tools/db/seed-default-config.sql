-- ⚠️ FILE ĐƯỢC SINH TỰ ĐỘNG — ĐỪNG SỬA TAY.
-- Nguồn: packages/db/src/seed/default-phase-config.ts (DEFAULT_PHASE_CONFIG)
--        packages/db/src/seed/work-calendar.seed.ts   (DEFAULT_CALENDARS)
-- Sinh lại sau khi đổi các hằng số trên: pnpm db:seed:sql:gen
--
-- MỤC ĐÍCH: seed dữ liệu Mặc định bằng SQL thuần, chạy TRỰC TIẾP không cần
-- Node/tsx/Prisma — tương đương `pnpm db:seed`:
--
--     psql "$DATABASE_URL" -f tools/db/seed-default-config.sql
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
    ('GLOBAL', NULL, next_version, TRUE, TRUE, 'system', 'Bộ Mặc định khởi tạo (seed SQL).')
  RETURNING id INTO set_id;

  -- compiled_regex để chuỗi rỗng: T-07 sinh regex thật khi biên dịch mẫu.
  INSERT INTO phase_title_pattern (config_set_id, pattern_text, compiled_regex, sort_order) VALUES
    (set_id, '[Phase] {name}', '', 1),
    (set_id, '【{name}】', '', 2);

  INSERT INTO subtask_title_pattern (config_set_id, pattern_text, compiled_regex, sort_order) VALUES
    (set_id, '[{project}][{team}][{phase}][{function}]_{task}', '', 1);

  INSERT INTO phase_definition (config_set_id, phase_code, label_vi, label_ja, color_hex, display_order) VALUES
    (set_id, 'REQUIREMENT', 'Yêu cầu', '要件定義', '#6B7280', 1),
    (set_id, 'DESIGN', 'Thiết kế', '設計', '#4A90D9', 2),
    (set_id, 'DEVELOPMENT', 'Phát triển', '開発', '#2E9E5B', 3),
    (set_id, 'TESTING', 'Kiểm thử', 'テスト', '#E8A33D', 4),
    (set_id, 'UAT', 'Nghiệm thu', '受入テスト', '#B45FD4', 5),
    (set_id, 'RELEASE', 'Triển khai', 'リリース', '#D9534F', 6);

  INSERT INTO phase_match_rule (config_set_id, keyword, match_mode, phase_code, match_priority) VALUES
    (set_id, 'Requirement', 'CONTAINS', 'REQUIREMENT', 50),
    (set_id, '要件定義', 'CONTAINS', 'REQUIREMENT', 50),
    (set_id, 'Yêu cầu', 'CONTAINS', 'REQUIREMENT', 50),
    (set_id, 'Design Review', 'CONTAINS', 'TESTING', 10),
    (set_id, 'Design', 'CONTAINS', 'DESIGN', 50),
    (set_id, '基本設計', 'CONTAINS', 'DESIGN', 50),
    (set_id, '詳細設計', 'CONTAINS', 'DESIGN', 50),
    (set_id, '設計', 'CONTAINS', 'DESIGN', 60),
    (set_id, 'Thiết kế', 'CONTAINS', 'DESIGN', 50),
    (set_id, 'Development', 'CONTAINS', 'DEVELOPMENT', 50),
    (set_id, 'Implementation', 'CONTAINS', 'DEVELOPMENT', 50),
    (set_id, 'Dev', 'CONTAINS', 'DEVELOPMENT', 70),
    (set_id, '開発', 'CONTAINS', 'DEVELOPMENT', 50),
    (set_id, '実装', 'CONTAINS', 'DEVELOPMENT', 50),
    (set_id, 'Phát triển', 'CONTAINS', 'DEVELOPMENT', 50),
    (set_id, '受入テスト', 'CONTAINS', 'UAT', 20),
    (set_id, 'UAT', 'CONTAINS', 'UAT', 20),
    (set_id, 'Nghiệm thu', 'CONTAINS', 'UAT', 20),
    (set_id, 'Testing', 'CONTAINS', 'TESTING', 50),
    (set_id, 'Test', 'CONTAINS', 'TESTING', 70),
    (set_id, 'QA', 'CONTAINS', 'TESTING', 50),
    (set_id, 'テスト', 'CONTAINS', 'TESTING', 60),
    (set_id, '試験', 'CONTAINS', 'TESTING', 50),
    (set_id, 'Kiểm thử', 'CONTAINS', 'TESTING', 50),
    (set_id, 'Release', 'CONTAINS', 'RELEASE', 50),
    (set_id, 'Deployment', 'CONTAINS', 'RELEASE', 50),
    (set_id, 'リリース', 'CONTAINS', 'RELEASE', 50),
    (set_id, '本番', 'CONTAINS', 'RELEASE', 50),
    (set_id, 'Triển khai', 'CONTAINS', 'RELEASE', 50);

  INSERT INTO signboard_column (config_set_id, task_code, label_vi, label_ja, side, display_order) VALUES
    (set_id, 'Create', 'Tạo mới', '作成', 'VN', 1),
    (set_id, 'BALReview', 'BAL review', 'BALレビュー', 'VN', 2),
    (set_id, 'FixCommentBAL', 'Sửa comment BAL', 'BAL指摘対応', 'VN', 3),
    (set_id, 'JMReview', 'JM review', 'JMレビュー', 'JP', 4),
    (set_id, 'FixCommentJM', 'Sửa comment JM', 'JM指摘対応', 'VN', 5);

  RAISE NOTICE '[seed] Đã tạo bộ Mặc định (GLOBAL) version %.', next_version;
END $$;

-- 2) Lịch làm việc Mặc định — upsert theo khoá tự nhiên (idempotent).
INSERT INTO work_calendar (calendar_id, timezone, workdays_mask, hours_per_day) VALUES
  ('VN_STANDARD', 'Asia/Ho_Chi_Minh', 31, 8),
  ('JP_STANDARD', 'Asia/Tokyo', 31, 8)
ON CONFLICT (calendar_id) DO UPDATE SET
  timezone      = EXCLUDED.timezone,
  workdays_mask = EXCLUDED.workdays_mask,
  hours_per_day = EXCLUDED.hours_per_day;

COMMIT;
