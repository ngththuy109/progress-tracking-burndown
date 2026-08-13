-- Hoàn tác 20260813000000_signboard_request_participants.
-- An toàn: cột này chỉ nuôi cột PIC (hiển thị), không tham gia tính Burndown.
ALTER TABLE "jira_issue" DROP COLUMN IF EXISTS "sb_request_participants";
