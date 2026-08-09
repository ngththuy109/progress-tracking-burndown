-- Kịch bản rollback cho migration 20260809000000_app_user
-- CONVENTIONS.md C-13: mỗi migration phải có kịch bản rollback.
--
-- CẢNH BÁO: chạy script này sẽ MẤT toàn bộ phân quyền đã cấu hình. Sau khi rollback,
-- API quay lại trạng thái không tra được role → mọi thao tác ghi trả 401/403 cho
-- tới khi có cơ chế phân quyền khác.

-- Thu hẹp lại `added_by` về VARCHAR(64) như trước. CHỈ an toàn khi mọi giá trị
-- hiện có ≤ 64 ký tự; nếu có email dài hơn thì phải xử lý trước khi rollback.
ALTER TABLE "tracked_epic" ALTER COLUMN "added_by" TYPE VARCHAR(64);

DROP TABLE IF EXISTS "app_user";
