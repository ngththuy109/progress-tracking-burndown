-- Data quality: cho phép đánh dấu Sub-task "không cần sửa dữ liệu".
-- Ticket được đánh dấu bị LOẠI khỏi các số đo Data quality ở màn hình
-- Monitoring (cả tử số lẫn mẫu số), nhưng vẫn nằm trong danh sách chi tiết để
-- gỡ đánh dấu được. Ghi lại ai đánh dấu và lúc nào để truy vết.
ALTER TABLE "jira_issue"
  ADD COLUMN "dq_exempt" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "dq_exempt_by" VARCHAR(254),
  ADD COLUMN "dq_exempt_at" TIMESTAMPTZ(6);
