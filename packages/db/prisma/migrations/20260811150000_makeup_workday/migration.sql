-- Ngày LÀM BÙ (make-up workday) — T-39.
--
-- Ngày cuối tuần (theo workdays_mask) được xếp làm việc để bù cho một ngày nghỉ
-- khác, rất phổ biến quanh Tết/lễ ở VN. NGƯỢC nghĩa với calendar_holiday:
--   • holiday: biến một ngày làm việc thành NGHỈ;
--   • makeup : biến một ngày nghỉ (theo mask) thành NGÀY LÀM VIỆC.
--
-- Engine (packages/engine/src/calendar/count-workdays.ts → isWorkday) tính đường
-- Kế hoạch trên ngày làm bù NHƯ ngày làm việc bình thường, và biểu đồ Burndown
-- KHÔNG bôi xám ngày này. Ngày lễ vẫn THẮNG ngày làm bù nếu lỡ khai trùng.
--
-- Khoá chính (calendar_id, work_date) như calendar_holiday: mỗi ngày khai một
-- lần cho một lịch. Cột work_date kiểu DATE (C-1) — ngày dương lịch thuần.

-- CreateTable
CREATE TABLE "calendar_makeup_workday" (
    "calendar_id" VARCHAR(32) NOT NULL,
    "work_date" DATE NOT NULL,
    "label" TEXT,
    CONSTRAINT "calendar_makeup_workday_pkey" PRIMARY KEY ("calendar_id","work_date")
);

-- AddForeignKey
ALTER TABLE "calendar_makeup_workday" ADD CONSTRAINT "calendar_makeup_workday_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "work_calendar"("calendar_id") ON DELETE CASCADE ON UPDATE CASCADE;
