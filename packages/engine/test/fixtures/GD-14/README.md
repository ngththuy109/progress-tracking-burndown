# GD-14 · Kế thừa cấu hình theo project

**Kịch bản.** Project SHOP chỉ ghi đè **mẫu tiêu đề** (dùng ngoặc Nhật 【】). Mọi phần khác để trống.

**Điểm cần bắt.** Ba phần kế thừa **độc lập nhau** (PRD §2.2.6):

| Phần | Nguồn | `inherited` |
|---|---|---|
| Mẫu tiêu đề Task | project | `false` |
| Mẫu tiêu đề Sub-task | Mặc định | `true` |
| Danh sách Phase | Mặc định | `true` |
| Luật khớp | Mặc định | `true` |
| Cột Signboard | Mặc định | `true` |

**Vì sao không làm "tất cả hoặc không có gì".** Project chỉ muốn đổi cách viết tiêu đề sẽ **mất sạch danh sách Phase**, và mọi Task rơi vào *Chưa phân loại*. Cấu hình vẫn lưu được, giao diện vẫn xanh, chỉ có số liệu là sai — đúng kiểu lỗi im lặng.

**Quy ước nhận biết "chưa ghi đè".** Mảng rỗng = kế thừa tiếp. Đây cũng là lý do màn hình cấu hình (T-21) phải gửi **mảng rỗng** cho phần chưa ghi đè, chứ không gửi bản sao của bộ Mặc định.
