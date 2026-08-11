-- T-37: cột Signboard mang "phía làm" — VN (người làm) | JP (khách hàng review).
-- Mặc định 'VN' cho mọi cột đã có; PM đổi các cột phía khách hàng qua màn hình
-- Signboard columns. Giá trị này quyết định ngày kế hoạch của Sub-task được
-- kiểm tra với lịch nghỉ nào (plan-conflicts).
ALTER TABLE "signboard_column"
  ADD COLUMN "side" VARCHAR(2) NOT NULL DEFAULT 'VN';

-- Chặn giá trị rác ngay ở tầng DB: chỉ hai phía VN | JP.
ALTER TABLE "signboard_column"
  ADD CONSTRAINT "chk_sbcolumn_side" CHECK ("side" IN ('VN', 'JP'));
