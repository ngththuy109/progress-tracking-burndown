# GD-01 · Đường đi lý tưởng

**Kịch bản.** Epic `PAY-1` có 3 Phase và 10 Sub-task, mỗi Sub-task 8 giờ. Kế hoạch chia đều: DESIGN 3 ngày, DEV 4 ngày, TEST 3 ngày, nối đuôi nhau từ 02/03 tới 13/03 (10 ngày làm việc, không lễ). Mỗi ngày đội làm xong đúng một Sub-task và log đủ 8 giờ.

**Điểm cần bắt.** Đường Thực tế bám sát đường Kế hoạch — trùng nhau **từng điểm một**, không phải "gần bằng".

**Vì sao trùng khít.** Cả ba Phase tình cờ có cùng nhịp cháy 28800 giây/ngày (86400/3, 115200/4, 86400/3). Nhờ vậy đường Kế hoạch là một đường thẳng giảm đều 28800 mỗi ngày, và vì mỗi ngày đúng một Sub-task Done nên đường Thực tế cũng giảm đúng 28800.

Đây là bộ dữ liệu **dễ đọc nhất** trong 20 bộ. Ai muốn hiểu engine làm gì thì đọc bộ này trước.
