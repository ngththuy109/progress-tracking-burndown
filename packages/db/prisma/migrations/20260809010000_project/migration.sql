-- Bảng `project` — danh mục Project do Admin quản lý, dùng để gán PM.
--
-- VÌ SAO CẦN: PM chỉ được gán vào project có thật. Không có danh mục này thì Admin
-- gõ tay key ở màn hình cấp quyền, gõ nhầm `PAI` thay `PAY` là PM mất quyền xem
-- trong im lặng. Bảng này là DANH SÁCH CHỌN có kiểm soát.
--
-- KHÔNG đặt khoá ngoại từ `tracked_epic.project_key` sang đây: Epic đến từ Jira
-- với bất kỳ project nào, ràng buộc lại sẽ chặn luồng thêm Epic. Đây thuần tuý là
-- danh mục để gán quyền.

CREATE TABLE "project" (
  "project_key"  VARCHAR(32) PRIMARY KEY NOT NULL,
  "display_name" TEXT,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
