-- Data quality (B1 / CLOSE_LAG): số NGÀY LÀM VIỆC giữa worklog cuối và lúc bấm
-- đóng ticket, engine tính sẵn (cần lịch + holiday nên KHÔNG tính được bằng SQL
-- thuần), lưu per Sub-task để màn hình Monitoring cảnh báo "đóng ticket trễ hơn
-- ngày làm thật". NULL = chưa Done, không có worklog, hoặc đang bị mở lại.
ALTER TABLE "subtask_actual_dates"
  ADD COLUMN "close_lag_workdays" INTEGER;
