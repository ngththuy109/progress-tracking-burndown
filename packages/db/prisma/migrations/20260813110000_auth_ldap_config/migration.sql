-- Cấu hình đăng nhập LDAP — một dòng duy nhất, ADMIN chỉnh trên UI.
--
-- VÌ SAO CẦN: yêu cầu đổi từ SSO/OIDC sang LDAP (form username/password bind
-- thẳng vào LDAP server của công ty), và cấu hình phải làm được trên UI thay
-- vì sửa file. `bind_password_enc` mã hóa AES-256-GCM bằng APP_ENCRYPTION_KEY
-- (cùng secret-box với token Jira).
--
-- enabled = false (mặc định) → chế độ header cũ giữ nguyên hành vi.
--
-- Bảng auth_sso_config (hướng OIDC bị hủy giữa chừng, chưa từng có bản phát
-- hành) có thể còn trên DB đã lỡ áp migration nhánh này bản cũ → dọn cho sạch.
DROP TABLE IF EXISTS "auth_sso_config";

CREATE TABLE "auth_ldap_config" (
  "id"                INTEGER PRIMARY KEY DEFAULT 1,
  "enabled"           BOOLEAN NOT NULL DEFAULT FALSE,
  "server_url"        TEXT,
  "bind_dn"           TEXT,
  "bind_password_enc" TEXT,
  "user_dn_template"  TEXT,
  "search_base"       TEXT,
  "user_filter"       TEXT NOT NULL DEFAULT '(mail={username})',
  "email_attribute"   VARCHAR(64) NOT NULL DEFAULT 'mail',
  "allow_self_signed" BOOLEAN NOT NULL DEFAULT FALSE,
  "session_ttl_hours" SMALLINT NOT NULL DEFAULT 12,
  "updated_by"        VARCHAR(254),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Bảng MỘT DÒNG: mọi UPSERT đều nhắm id = 1; CHECK chặn dòng thứ hai lọt vào
-- từ SQL tay (Prisma không mô tả được CHECK nên viết ở đây — C-13).
ALTER TABLE "auth_ldap_config"
  ADD CONSTRAINT "auth_ldap_config_singleton" CHECK ("id" = 1);

ALTER TABLE "auth_ldap_config"
  ADD CONSTRAINT "auth_ldap_config_ttl_check" CHECK ("session_ttl_hours" BETWEEN 1 AND 168);
