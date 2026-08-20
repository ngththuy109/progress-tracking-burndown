-- Index started_at cho báo cáo lưới PIC × ngày (Log work).
--
-- Report này gộp worklog theo (tác giả, ngày) trên TOÀN bảng worklog_entry
-- trong một cửa sổ thời gian, KHÔNG lọc theo epic_key (để bắt cả Epic PAUSED/
-- ERROR và worklog mồ côi). Hai index sẵn có đều dẫn đầu bằng khoá khác
-- (issue_key / epic_key) nên không phục vụ được truy vấn chỉ lọc started_at →
-- seq scan cả bảng. Index này cho phép range-scan đúng cửa sổ.
CREATE INDEX "idx_worklog_started" ON "worklog_entry" ("started_at");
