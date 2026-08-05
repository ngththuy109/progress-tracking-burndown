# GD-11 · Đổi tiêu đề Task làm đổi Phase

**Kịch bản.** Task cha của PAY-11 vốn tên `[Design] ...` nên Sub-task thuộc Phase DESIGN. Có người sửa tiêu đề thành `[Design Review] ...`, và luật khớp ưu tiên cao đưa nó sang **TESTING**.

**Điểm cần bắt.** Snapshot của **mọi ngày đã qua** đều tính PAY-11 vào TESTING, kể cả những ngày trước khi tiêu đề bị sửa. Lịch sử được **dựng lại toàn bộ**, không vá từng ngày.

**Vì sao thiết kế như vậy.** Phân loại là thuộc tính *hiện tại* của Task; giữ lại phân loại cũ cho quá khứ sẽ tạo ra một biểu đồ mà tổng các Phase không bao giờ khớp với Epic.

**Hệ quả nhìn thấy được.** `planEnd` của DESIGN co từ 06/03 về 04/03 — một bản ghi dịch chuyển kế hoạch với số ngày **âm** (kéo sớm lên). Dấu âm ở đây là tin tốt, và hệ thống vẫn phải ghi lại.
