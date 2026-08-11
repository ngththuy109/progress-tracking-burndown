-- Chặn lỗi quy ước bit của workdays_mask ở TẦNG DATABASE (T-12, C-10).
--
-- Quy ước hệ thống (packages/shared/src/calendar.ts): bit 0 = Thứ Hai … bit 6
-- = Chủ nhật, theo cách đánh số của luxon. T2–T6 = 31, T2–T7 = 63.
--
-- Lỗi thực tế đã gặp: bản ghi lịch tạo tay tính bit theo SỐ THỨ TỰ 1-indexed
-- (T2 = 1<<1 … CN = 1<<7) nên ra mask 126 thay vì 63. Engine đọc 0-indexed nên
-- cả tuần trượt một ngày: Chủ nhật thành ngày làm việc, còn MỌI Thứ Hai lặng
-- lẽ biến mất khỏi trục biểu đồ Burndown — không lỗi, không cảnh báo.
-- Seed chỉ ghi 31 và không màn hình nào sửa được mask, nên đường vào duy nhất
-- của giá trị sai là sửa tay — và database phải là chốt chặn cuối cùng.

-- 1) Chữa dữ liệu đang sai: các vết trượt 1-indexed đã biết chỉ cần dịch phải
--    1 bit là về đúng ý định ban đầu (62→31 T2–T6, 126→63 T2–T7, 254→127 cả tuần).
UPDATE work_calendar SET workdays_mask = workdays_mask >> 1 WHERE workdays_mask IN (62, 126, 254);

-- 2) Giá trị rác còn lại (0 hoặc ngoài 7 bit): về mặc định T2–T6 = 31 — cùng
--    giá trị DEFAULT_WORKDAYS_MASK mà hệ thống vẫn dùng khi thiếu lịch.
UPDATE work_calendar SET workdays_mask = 31 WHERE workdays_mask < 1 OR workdays_mask > 127;

-- 3) Lưới an toàn cuối cùng để hai ALTER TABLE bên dưới không thể làm hỏng
--    lượt nâng cấp trên dữ liệu lạ chưa lường tới: mask nào vẫn thiếu Thứ Hai
--    thì bật bit Thứ Hai lên.
UPDATE work_calendar SET workdays_mask = workdays_mask | 1 WHERE (workdays_mask & 1) = 0;

-- 4) Từ nay database TỪ CHỐI mask sai ngay lúc ghi — kể cả khi sửa tay bằng psql:
--    • ck_workdays_mask_range: đúng 7 bit (1..127);
--    • ck_workdays_mask_has_monday: bắt buộc có Thứ Hai. Mọi tuần làm việc của
--      hệ thống này đều có Thứ Hai, còn mask 1-indexed thì LUÔN mất Thứ Hai —
--      đây chính là chữ ký của lỗi. Nếu một ngày thật sự cần lịch nghỉ Thứ Hai,
--      gỡ ràng buộc này bằng MỘT MIGRATION MỚI kèm lý do (C-13).
ALTER TABLE work_calendar
  ADD CONSTRAINT ck_workdays_mask_range CHECK (workdays_mask BETWEEN 1 AND 127);
ALTER TABLE work_calendar
  ADD CONSTRAINT ck_workdays_mask_has_monday CHECK ((workdays_mask & 1) = 1);
