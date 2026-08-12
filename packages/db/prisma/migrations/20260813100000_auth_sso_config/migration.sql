-- Cấu hình SSO (OIDC in-app) — một dòng duy nhất, ADMIN chỉnh trên UI.
--
-- VÌ SAO CẦN: trước đây SSO bắt buộc dựng oauth2-proxy và sửa file config tay.
-- Từ bản này app tự là OIDC client (authorization code + PKCE): issuer/client
-- ID/secret lưu ở đây, secret mã hóa AES-256-GCM bằng APP_ENCRYPTION_KEY
-- (cùng secret-box với token Jira, xem packages/db/src/crypto/secret-box.ts).
--
-- enabled = false (mặc định) → chế độ header cũ giữ nguyên, hệ thống hiện có
-- không đổi hành vi gì sau migration này.

CREATE TABLE "auth_sso_config" (
  "id"                INTEGER PRIMARY KEY DEFAULT 1,
  "enabled"           BOOLEAN NOT NULL DEFAULT FALSE,
  "issuer_url"        TEXT,
  "client_id"         TEXT,
  "client_secret_enc" TEXT,
  "scopes"            TEXT NOT NULL DEFAULT 'openid profile email',
  "email_claim"       VARCHAR(64) NOT NULL DEFAULT 'email',
  "session_ttl_hours" SMALLINT NOT NULL DEFAULT 12,
  "updated_by"        VARCHAR(254),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Bảng MỘT DÒNG: mọi UPSERT đều nhắm id = 1; CHECK chặn dòng thứ hai lọt vào
-- từ SQL tay (Prisma không mô tả được CHECK nên viết ở đây — C-13).
ALTER TABLE "auth_sso_config"
  ADD CONSTRAINT "auth_sso_config_singleton" CHECK ("id" = 1);

-- Phiên đăng nhập bật được ngay sau khi cấu hình: TTL 1..168 giờ (1 tuần).
ALTER TABLE "auth_sso_config"
  ADD CONSTRAINT "auth_sso_config_ttl_check" CHECK ("session_ttl_hours" BETWEEN 1 AND 168);
