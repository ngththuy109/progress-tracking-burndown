-- Gỡ hai ràng buộc của 20260811140000_workdays_mask_guard.
--
-- KHÔNG khôi phục giá trị mask cũ: các giá trị đã chữa (62→31, 126→63, 254→127)
-- là dữ liệu SAI được đưa về đúng ý định ban đầu — quay lại giá trị sai không
-- phải là "rollback", đó là tự cấy lại lỗi.
ALTER TABLE work_calendar DROP CONSTRAINT IF EXISTS ck_workdays_mask_has_monday;
ALTER TABLE work_calendar DROP CONSTRAINT IF EXISTS ck_workdays_mask_range;
