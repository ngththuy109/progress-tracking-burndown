# GD-07 · Trạng thái tiếng Nhật

**Kịch bản.** Dự án Nhật, luồng trạng thái là `未着手` (10000) → `進行中` (3) → `レビュー中` (10003) → `完了` (10001). Múi giờ `Asia/Tokyo`.

**Điểm cần bắt.** `進行中` và `レビュー中` là **hai tên khác nhau** nhưng cùng thuộc nhóm *Đang làm*, nên cả hai ngày 02/03 và 03/03 đều đếm vào `countInProgress`. Ngày 04/03 chuyển sang `完了` thì mới tính là xong.

**Vì sao.** Quy ước **C-4**: chỉ đọc `statusCategory.key`, không bao giờ đọc `status.name`. Tên trạng thái là tiếng Nhật, quản trị viên Jira đổi được bất cứ lúc nào, và mỗi project lại đặt một kiểu. Bám vào tên là hệ thống hỏng ngay lần đầu gặp một quy trình mới.

**Kèm theo.** Mốc chốt sổ ở đây là 23:59:59.999 giờ Nhật = **14:59:59.999Z** cùng ngày (UTC+9), khác với các bộ dùng giờ Việt Nam (UTC+7).
