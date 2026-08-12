-- Nhật ký thao tác quản trị nhạy cảm (audit log) — khuyến nghị từ lần đánh giá
-- rủi ro rò rỉ token 2026-08-12.
--
-- VÌ SAO CẦN: ADMIN không đọc lại được token Jira, nhưng đổi được jira_base_url
-- của một dự án — trỏ sang server tự kiểm soát rồi bấm Test connection là token
-- đã lưu bị gửi sang đó. (Từ bản này, đổi base URL sẽ TỰ XÓA token đã lưu, và
-- bảng này ghi lại mọi lần sửa/test kết nối để truy được ai-đổi-gì-lúc-nào.)
--
-- `detail` là JSONB chỉ chứa cờ/enum — TUYỆT ĐỐI không chứa token hay giá trị
-- nhạy cảm (cùng nguyên tắc C-9 với log).

CREATE TABLE "admin_audit_log" (
  "id"          BIGSERIAL PRIMARY KEY,
  "actor_id"    VARCHAR(254) NOT NULL,
  "action"      VARCHAR(48)  NOT NULL,
  "project_key" VARCHAR(32),
  "detail"      JSONB,
  "at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX "idx_audit_project" ON "admin_audit_log" ("project_key", "at" DESC);
