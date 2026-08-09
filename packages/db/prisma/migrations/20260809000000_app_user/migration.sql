-- Bảng `app_user` — nguồn sự thật của phân quyền (role/projects) cho mô hình SSO.
--
-- VÌ SAO CẦN: cổng (auth proxy) chỉ xác thực DANH TÍNH qua SSO rồi bơm header
-- `x-user-id`. API không tin `role` từ header mà tra ở bảng này (xem
-- apps/api/src/adapters/principal.ts). Không có bảng này thì mọi người dùng đã
-- đăng nhập đều cùng một quyền, và không thể phân biệt Admin / PM / Viewer.
--
-- `user_id` là danh tính ổn định do IdP cấp (email đã chuẩn hoá chữ thường).
-- 254 ký tự = giới hạn địa chỉ email theo RFC 5321.

CREATE TABLE "app_user" (
  "user_id"      VARCHAR(254) PRIMARY KEY NOT NULL,
  "role"         VARCHAR(16)  NOT NULL,
  "projects"     TEXT[]       NOT NULL DEFAULT '{}',
  "display_name" TEXT,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Chỉ nhận đúng ba vai trò hợp lệ. Vai trò lạ (gõ sai, cấu hình cũ) phải bị
-- CHẶN ngay tại DB — Prisma không tự sinh CHECK nên viết tay ở đây (C-13).
ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_role_check" CHECK ("role" IN ('ADMIN', 'PM', 'VIEWER'));

-- `tracked_epic.added_by` giờ lưu chính `user_id` (email) nên phải đủ dài như
-- danh tính. Nới VARCHAR(64) → VARCHAR(254): mở rộng chiều dài không mất dữ
-- liệu, mọi giá trị cũ vẫn vừa.
ALTER TABLE "tracked_epic" ALTER COLUMN "added_by" TYPE VARCHAR(254);
