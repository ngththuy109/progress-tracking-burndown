-- Kịch bản rollback cho migration 20260810000000_hierarchy_profile
-- CONVENTIONS.md C-13: mỗi migration phải có kịch bản rollback.
--
-- CẢNH BÁO: chạy script này sẽ MẤT mọi Hierarchy Profile đã cấu hình — các
-- project 2 tầng (hoặc dạng khác) quay về bị hiểu như 3 tầng và phân loại sai
-- cho tới khi cấu hình lại.

DROP TABLE IF EXISTS "hierarchy_profile";

DROP INDEX IF EXISTS "idx_issue_signboard_role";

ALTER TABLE "jira_issue" DROP CONSTRAINT IF EXISTS "ck_issue_resolved_role";
ALTER TABLE "jira_issue" DROP COLUMN IF EXISTS "resolved_role";

-- Tái tạo partial index cũ theo issue_type mà migration này đã gỡ.
CREATE INDEX "idx_issue_signboard"
  ON "jira_issue" (epic_key, phase_code, function_key, task_type)
  WHERE issue_type = 'SUBTASK' AND removed_at IS NULL;
