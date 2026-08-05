# GD-04 · Log giờ lùi ngày

**Kịch bản.** Ngày 06/03 job đồng bộ chạy (`sourceReadAt`) và mới nhìn thấy hai bản ghi log giờ mà người dùng khai lùi cho ngày **03/03** và **05/03**.

**Điểm cần bắt.** Giờ phải rơi vào đúng ngày người ta khai đã làm, tức snapshot của 03/03 và 05/03 **bị sửa lại**, chứ không dồn hết vào ngày đồng bộ.

**Vì sao.** Worklog được tính theo trường `started` của Jira chứ không phải `created` (PRD E-03). Dùng nhầm `created` thì cứ mỗi lần ai đó khai bù giờ cuối tuần là đường Thực tế lại có một bậc thang giả vào thứ Hai.

**Kèm theo.** Đường Kế hoạch ở bộ này chia 28800 / 5 ngày = 5760 giây — con số không tròn giờ, dùng để khẳng định engine **không làm tròn**.
