-- Log work tracking (T — theo dõi việc log work của member).
--
-- Hai thay đổi:
--   1) Giờ/ngày kỳ vọng CẤU HÌNH RIÊNG theo project — dùng cho chỉ báo "behind".
--      NULL → dùng giờ/ngày của lịch làm việc gắn với Epic, cuối cùng tới 8h.
--   2) Bảng "PM verify — thôi theo dõi": cặp (member, ticket) đã được xác nhận
--      không cần log; bị loại khỏi cờ "chưa log" nhưng vẫn giữ để gỡ và truy vết.

ALTER TABLE "project"
  ADD COLUMN "expected_hours_per_day" DOUBLE PRECISION;

CREATE TABLE "logwork_exemption" (
  "account_id"  VARCHAR(64)    NOT NULL,
  "issue_key"   VARCHAR(32)    NOT NULL,
  "epic_key"    VARCHAR(32)    NOT NULL,
  "project_key" VARCHAR(32)    NOT NULL,
  "exempted_by" VARCHAR(254)   NOT NULL,
  "exempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "note"        TEXT,
  CONSTRAINT "logwork_exemption_pkey" PRIMARY KEY ("account_id", "issue_key")
);

CREATE INDEX "idx_logwork_exemption_epic" ON "logwork_exemption" ("epic_key");
