# GD-17 · Cả Phase thiếu ngày kế hoạch

**Kịch bản.** Phase `UNCLASSIFIED` gom những Sub-task chưa ai điền `wbs_*`. Phase DESIGN thì có đủ ngày.

**Điểm cần bắt.**

- `plannedRemainingS` của UNCLASSIFIED là **`null`** — không vẽ đường Kế hoạch cho Phase đó.
- Đường **Thực tế** của nó vẫn được vẽ bình thường: 2 giờ đã log là 2 giờ có thật.
- Đường Kế hoạch của cả Epic **không bao giờ chạm 0** (dừng ở 14400), vì phần khối lượng của UNCLASSIFIED không có mốc nào để cháy dần.

**Vì sao không đoán.** Bịa ra một khoảng thời gian cho Phase đó sẽ cho ra một đường Kế hoạch trông rất thuyết phục nhưng hoàn toàn vô căn cứ. Quy ước **C-10**: thà không vẽ còn hơn vẽ sai. Con số dừng ở 14400 chính là **lời nhắc PM đi điền ngày** (rủi ro R-08).
