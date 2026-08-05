# GD-15 · Tổng hợp ngày của Phase

**Kịch bản.** Phase DESIGN có 3 Sub-task: một cái bình thường, một cái **quên điền cả hai ngày `wbs_*`**, một cái bị mở lại rồi mới xong hẳn ngày 09/03.

**Điểm cần bắt.**

- `planStart` = MIN các ngày bắt đầu = **02/03**; `planEnd` = MAX các ngày kết thúc = **06/03**. Sub-task thiếu ngày **không** kéo hai mốc này về `null`.
- `missingDateCount` = **1** — con số này là danh sách việc phải làm của PM (rủi ro **R-08**).
- `actualEnd` của Phase = **09/03**, tức lần chuyển sang Done **cuối cùng** của PAY-13, không phải lần đầu (05/03).

**Vì sao `actualEnd` phải lấy lần cuối.** Lấy lần Done đầu tiên sẽ báo Phase đã xong từ 05/03 trong khi thực tế còn phải làm lại tới 09/03 — hệ thống nói dối đúng vào chỗ PM cần sự thật nhất.

**Kèm theo.** Khối lượng vẫn cộng đủ cả PAY-12 dù nó thiếu ngày (quy ước **C-11**): công việc là có thật.
