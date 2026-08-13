-- Đường Kế hoạch chuyển từ rải-đều-theo-Phase sang rải-đều-theo-Sub-task.
--
-- Trước đây `phase_rollup` chỉ giữ MIN(wbs_start_date)/MAX(wbs_end_date) gộp cả
-- Phase, làm mất lịch riêng của từng Sub-task. Giờ đường Kế hoạch cho mỗi Sub-task
-- (đủ hai ngày) tự rải đều khối lượng trên cửa sổ của chính nó rồi cộng dồn.
--
-- API service (apps/api/src/services/burndown.service.ts) chỉ nạp phase_rollup,
-- KHÔNG nạp Sub-task thô, nhưng vẫn phải chiếu đường Kế hoạch cho những ngày
-- NGOÀI khoảng snapshot. Vì vậy lịch ramp per-Sub-task phải nằm trong rollup:
--   [{ wbsStartDate, wbsEndDate, originalS, planWorkdays }, …]
--
-- phase_rollup được UPSERT TRỌN VẸN sau MỖI lần đồng bộ (reconstruct-epic.job),
-- nên DEFAULT '[]' chỉ đỡ cho tới lần sync kế tiếp là dữ liệu tự đầy lại.
ALTER TABLE "phase_rollup"
  ADD COLUMN "planned_items" JSONB NOT NULL DEFAULT '[]'::jsonb;
