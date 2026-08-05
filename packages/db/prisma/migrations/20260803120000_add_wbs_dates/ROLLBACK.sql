-- Kịch bản rollback cho migration 20260803120000_add_wbs_dates
-- CONVENTIONS.md C-13: mỗi migration phải có kịch bản rollback.
--
-- CẢNH BÁO: chạy script này sẽ MẤT ngày kế hoạch của mọi Sub-task đã đồng bộ.
-- Lấy lại được bằng cách chạy lại đồng bộ từ Jira (dữ liệu gốc vẫn ở đó), nhưng
-- `phase_rollup` sẽ sai cho tới khi đồng bộ xong.

DROP INDEX IF EXISTS "idx_issue_missing_wbs";

ALTER TABLE "jira_issue" DROP COLUMN IF EXISTS "wbs_end_date";
ALTER TABLE "jira_issue" DROP COLUMN IF EXISTS "wbs_start_date";
