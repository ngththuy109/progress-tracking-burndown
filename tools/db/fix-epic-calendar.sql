-- Data-fix một lần (T-38): trỏ lại các Epic đang dùng lịch không tồn tại.
--
-- BỐI CẢNH: màn hình "Track new Epics" từng gán cứng calendar_id = 'default' —
-- một lịch KHÔNG có trong seed (seed chỉ tạo VN_STANDARD và JP_STANDARD). Nếu
-- ai đó đã tạo tay bản ghi 'default' trong work_calendar thì các Epic trỏ vào
-- nó vẫn insert được, nhưng lịch đó thường không có ngày lễ (và có thể sai cả
-- workdays_mask) → đường Kế hoạch chia đều cho mọi ngày.
--
-- Script này idempotent, chạy lại vô hại:
--   1. Trỏ mọi Epic đang dùng lịch 'default' (hoặc lịch không tồn tại) về
--      VN_STANDARD — lịch thực thi của người làm — và đồng bộ lại timezone.
--   2. KHÔNG xoá bản ghi 'default' (nếu có): để admin tự xem xét, vì có thể
--      còn thứ khác trỏ vào. Sau khi chắc chắn: DELETE FROM work_calendar
--      WHERE calendar_id = 'default';
--
-- Chạy:  psql "$DATABASE_URL" -f tools/db/fix-epic-calendar.sql
-- Sau đó bấm Resync các Epic bị đổi (hoặc đợi job đêm) để đường Kế hoạch vẽ
-- lại theo lịch đúng.

BEGIN;

-- Bảo đảm hai lịch chuẩn tồn tại trước khi trỏ vào (giống seed, idempotent).
INSERT INTO work_calendar (calendar_id, timezone, workdays_mask, hours_per_day) VALUES
  ('VN_STANDARD', 'Asia/Ho_Chi_Minh', 31, 8),
  ('JP_STANDARD', 'Asia/Tokyo', 31, 8)
ON CONFLICT (calendar_id) DO NOTHING;

WITH fixed AS (
  UPDATE tracked_epic e
     SET calendar_id = 'VN_STANDARD',
         timezone    = 'Asia/Ho_Chi_Minh'
   WHERE e.calendar_id = 'default'
      OR NOT EXISTS (
           SELECT 1 FROM work_calendar c WHERE c.calendar_id = e.calendar_id
         )
  RETURNING e.epic_key
)
SELECT COUNT(*) AS epics_repointed FROM fixed;

COMMIT;
