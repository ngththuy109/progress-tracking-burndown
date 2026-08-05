# GD-16 · Mốc kết thúc bị lùi qua cuối tuần

**Kịch bản.** Phase DESIGN dự kiến xong **thứ Sáu 06/03**. Ngày 04/03 thêm PAY-12 với ngày kết thúc **thứ Hai 09/03**.

**Điểm cần bắt.** `shiftedWorkdays` = **1**, không phải 3.

**Vì sao.** Từ thứ Sáu sang thứ Hai chỉ cách nhau **một ngày làm việc**; hai ngày kia là cuối tuần, không ai làm việc nên không phải là chậm trễ. Đếm theo ngày lịch sẽ thổi phồng mọi lần dịch qua cuối tuần lên gấp ba, và ngưỡng cảnh báo 20% của **R-11** sẽ kêu sai liên tục cho tới khi có người tắt nó đi.

**Kèm theo.** `planWorkdays` giãn từ 5 lên 6, nên nhịp cháy chậm lại từ 5760 xuống 9600 giây/ngày trên khối lượng lớn hơn — đường Kế hoạch được **vẽ lại toàn bộ**, kể cả phần quá khứ.
