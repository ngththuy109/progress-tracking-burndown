-- Hai mảnh cuối để màn hình Signboard chạy được (PRD §6).
--
-- 1) Ngày bắt đầu/kết thúc THỰC TẾ của TỪNG Sub-task.
--    `phase_rollup` đã có bản TỔNG HỢP theo Phase (MIN/MAX), nhưng mỗi ô
--    Signboard cần bản CHI TIẾT theo ticket để so kế hoạch↔thực tế của chính nó
--    (nguồn phát hiện trễ không bị baseline trôi làm nhiễu — R-11).
--
--    Đây là dữ liệu SUY RA từ changelog + worklog, không có sẵn trên Jira. Cách
--    tính (lần đầu vào In Progress / lần cuối sang Done, kết hợp worklog) cần tra
--    status_id → nhóm trạng thái — bảng tra đó nằm ở Redis, KHÔNG có trong SQL —
--    nên bảng này do job `reconstruct` GHI (dùng lại engine.resolveSubtaskActualDates),
--    không phải một VIEW thuần SQL.
CREATE TABLE "subtask_actual_dates" (
    "issue_key" VARCHAR(32) NOT NULL,
    "actual_start" DATE,
    "actual_end" DATE,
    -- true = Sub-task chưa từng Done; actual_end mới chỉ là ngày worklog cuối,
    -- một phỏng đoán. Tầng hiển thị phải phân biệt (PRD §2.7.2).
    "actual_end_is_provisional" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "subtask_actual_dates_pkey" PRIMARY KEY ("issue_key")
);

ALTER TABLE "subtask_actual_dates"
  ADD CONSTRAINT "subtask_actual_dates_issue_key_fkey"
  FOREIGN KEY ("issue_key") REFERENCES "jira_issue"("issue_key")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) TaskName THÔ bóc từ tiêu đề Sub-task, giữ nguyên KỂ CẢ khi không khớp cột
--    nào. Bộ phân tách đã tính giá trị này rồi vứt đi; giữ lại để màn hình gợi ý
--    cột Signboard mới (PRD E-29, endpoint .../unparsed).
ALTER TABLE "jira_issue" ADD COLUMN "sb_task_raw" VARCHAR(64);
