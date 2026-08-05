# GD-12 · Ngày đổi giờ mùa hè (DST)

**Kịch bản.** Kế hoạch trải từ thứ Năm 05/03 tới thứ Ba 10/03. Chủ nhật 08/03 nước Mỹ đổi sang giờ mùa hè: 02:00 nhảy thành 03:00, múi giờ đi từ **UTC−5 sang UTC−4**.

**Điểm cần bắt.** Mốc chốt sổ 23:59:59.999 giờ địa phương quy ra UTC phải **đổi theo**:

| Ngày | Mốc chốt sổ (UTC) | Lệch |
|---|---|---|
| 05/03 | `04:59:59.999Z` ngày 06 | UTC−5 |
| 06/03 | `04:59:59.999Z` ngày 07 | UTC−5 |
| 09/03 | `03:59:59.999Z` ngày 10 | **UTC−4** |
| 10/03 | `03:59:59.999Z` ngày 11 | UTC−4 |

**Vì sao dùng New York chứ không dùng Tokyo.** Dự án chạy ở `Asia/Tokyo`, mà **Nhật không có DST từ năm 1952**. Chỉ kiểm Tokyo thì test này không chứng minh được gì cả — nó sẽ xanh kể cả khi mã nguồn cộng thêm một khoảng lệch cố định. Bộ này là lưới chống hồi quy cho ngày dự án phải chạy ở một múi giờ có DST.
