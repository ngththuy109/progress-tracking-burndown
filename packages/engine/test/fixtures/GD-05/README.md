# GD-05 · Thêm việc giữa chừng

**Kịch bản.** Phase DESIGN ban đầu có 2 Sub-task (8 giờ mỗi cái), kế hoạch 02/03 → 04/03. Ngày 04/03 thêm 5 Sub-task nữa, mỗi cái 1,5 giờ. Bốn cái kết thúc 05/03, riêng **PAY-17 kéo tới 10/03**.

**Điểm cần bắt.**

1. `scopeAddedS` ngày 04/03 = 5 × 5400 = **27000 giây**, đúng bằng phần vừa thêm.
2. `planEnd` của Phase bị đẩy từ 04/03 sang **10/03**.
3. Sinh **đúng một** bản ghi dịch chuyển kế hoạch, chỉ đích danh **PAY-17**.

**Điều đáng chú ý nhất.** Đường Kế hoạch **đi lên** ở ngày 04/03 (33600 → 48000). Nhìn biểu đồ thì tưởng có gì đó sai, nhưng đó là sự thật: khối lượng vừa phình ra. Nếu hệ thống dùng baseline đóng băng thì phần phình này bị giấu đi — chính là rủi ro **R-11**.
