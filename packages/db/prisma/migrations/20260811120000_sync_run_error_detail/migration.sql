-- Màn hình Monitoring: dòng job FAILED phải dẫn được tới lỗi chi tiết.
-- `error_message` một dòng không nói được lỗi Ở ĐÂU trong pipeline và vì sao.
--   error_step   — bước đang chạy khi job ném lỗi (FETCH_TREE | FETCH_HISTORY | PERSIST | FINALIZE)
--   error_detail — stack trace nguyên văn, chỉ hiện ở màn hình chi tiết
ALTER TABLE "sync_run"
  ADD COLUMN "error_step" VARCHAR(32),
  ADD COLUMN "error_detail" TEXT;
