# GD-06 · Done → mở lại → Done

**Kịch bản.** Sub-task xong ngày 03/03, bị mở lại sáng 04/03 vì QA trả về, làm thêm 2 giờ ngày 05/03 rồi xong hẳn chiều 06/03.

**Điểm cần bắt.** Khối lượng còn lại phải **quay trở lại** khác 0 trong những ngày bị mở lại:

| Ngày | Còn lại | Vì sao |
|---|---|---|
| 02/03 | 14400 | quy tắc 3: 28800 − 14400. Lần đóng 03/03 là đóng NON (bị mở lại) nên **không** backdate |
| 03/03 | **0** | quy tắc 1: đang ở Done |
| 04/03 | **14400** | đã mở lại, quay về quy tắc 3 |
| 05/03 | **0** | **quy tắc 1b**: log lần cuối 05/03 rồi đóng HẲN 06/03 (không mở lại nữa), không sửa estimate sau đó → về 0 từ ngày làm thật cuối |
| 06/03 | **0** | Done lần nữa |

**Vì sao dễ sai.** Rất dễ viết code kiểu "đã Done thì mãi mãi Done" cho nhanh. Làm vậy thì toàn bộ khối lượng làm lại biến mất khỏi biểu đồ, và không có lỗi nào báo ra (PRD E-13).

**Điểm 1b cần bắt.** Quy tắc 1b CHỈ backdate cho lần đóng **dính-luôn** (06/03), không cho lần đóng non 03/03 — nên 02/03 vẫn giữ 14400, chỉ 05/03 mới về 0. Đóng non mà cũng backdate thì phần dư của những ngày làm thật trước đó biến mất.
