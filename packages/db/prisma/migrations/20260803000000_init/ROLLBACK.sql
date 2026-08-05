-- Kịch bản rollback cho migration 20260803000000_init
-- CONVENTIONS.md C-13: mỗi migration phải có kịch bản rollback.
--
-- CẢNH BÁO: script này XOÁ TOÀN BỘ DỮ LIỆU. Chỉ dùng khi cần đưa database
-- về trạng thái trước migration đầu tiên.
--
-- Thứ tự xoá NGƯỢC với thứ tự tạo, vì có khoá ngoại:
--   phase_rollup → tracked_epic → work_calendar
--   các bảng cấu hình con → phase_config_set

DROP INDEX IF EXISTS "idx_worklog_retro";
DROP INDEX IF EXISTS "idx_issue_unparsed";
DROP INDEX IF EXISTS "idx_issue_signboard";
DROP INDEX IF EXISTS "idx_tracked_active";
DROP INDEX IF EXISTS "idx_config_active_project";
DROP INDEX IF EXISTS "idx_config_active_global";

DROP TABLE IF EXISTS "plan_shift_history";
DROP TABLE IF EXISTS "phase_rollup";
DROP TABLE IF EXISTS "daily_snapshot";
DROP TABLE IF EXISTS "sync_run";

DROP TABLE IF EXISTS "signboard_column";
DROP TABLE IF EXISTS "subtask_title_pattern";
DROP TABLE IF EXISTS "phase_match_rule";
DROP TABLE IF EXISTS "phase_definition";
DROP TABLE IF EXISTS "phase_title_pattern";
DROP TABLE IF EXISTS "phase_config_set";

DROP TABLE IF EXISTS "worklog_entry";
DROP TABLE IF EXISTS "issue_changelog_event";
DROP TABLE IF EXISTS "jira_issue";

DROP TABLE IF EXISTS "tracked_epic";
DROP TABLE IF EXISTS "calendar_holiday";
DROP TABLE IF EXISTS "work_calendar";
