-- Kịch bản rollback cho migration 20260803130000_signboard_actuals
-- CONVENTIONS.md C-13: mỗi migration phải có kịch bản rollback.
--
-- Thứ tự NGƯỢC với lúc tạo.

ALTER TABLE "jira_issue" DROP COLUMN IF EXISTS "sb_task_raw";

DROP TABLE IF EXISTS "subtask_actual_dates";
