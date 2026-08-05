-- Bổ sung ngày kế hoạch của từng Sub-task vào `jira_issue`.
--
-- VÌ SAO CẦN: PRD §2.7 tổng hợp `phase_rollup.plan_start/plan_end` bằng
-- MIN(wbs_start_date) / MAX(wbs_end_date) của các Sub-task, và mỗi ô Signboard
-- (Phụ lục B) hiện ngày kế hoạch của từng ticket. Không có hai cột này thì
-- không tổng hợp được, không dựng được Signboard, và cũng không chỉ ra được
-- Sub-task nào còn thiếu ngày để PM đi điền (rủi ro R-08).
--
-- Bản migration đầu (20260803000000_init) thiếu hai cột này.

ALTER TABLE "jira_issue" ADD COLUMN "wbs_start_date" DATE;
ALTER TABLE "jira_issue" ADD COLUMN "wbs_end_date"   DATE;

-- Index riêng cho câu hỏi "Sub-task nào của Epic này còn thiếu ngày?"
-- (`GET /api/epics/:epicKey/missing-dates`).
--
-- Là PARTIAL INDEX: chỉ chứa đúng những dòng THIẾU ngày. Trên dữ liệu sạch nó
-- gần như rỗng nên gần như không tốn gì, mà vẫn trả lời tức thì đúng lúc dữ
-- liệu bẩn — là lúc PM cần tới nó.
CREATE INDEX "idx_issue_missing_wbs" ON "jira_issue" ("epic_key")
  WHERE "issue_type" = 'SUBTASK'
    AND "removed_at" IS NULL
    AND ("wbs_start_date" IS NULL OR "wbs_end_date" IS NULL);
