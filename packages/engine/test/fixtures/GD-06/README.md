# GD-06 · Done → mở lại → Done

**Kịch bản.** Sub-task xong ngày 03/03, bị mở lại sáng 04/03 vì QA trả về, làm thêm 2 giờ ngày 05/03 rồi xong hẳn chiều 06/03.

**Điểm cần bắt.** Khối lượng còn lại phải **quay trở lại** khác 0 trong những ngày bị mở lại:

| Ngày | Còn lại | Vì sao |
|---|---|---|
| 02/03 | 14400 | quy tắc 3: 28800 − 14400 |
| 03/03 | **0** | quy tắc 1: đang ở Done |
| 04/03 | **14400** | đã mở lại, quay về quy tắc 3 |
| 05/03 | 7200 | log thêm 2 giờ |
| 06/03 | **0** | Done lần nữa |

**Vì sao dễ sai.** Rất dễ viết code kiểu "đã Done thì mãi mãi Done" cho nhanh. Làm vậy thì toàn bộ khối lượng làm lại biến mất khỏi biểu đồ, và không có lỗi nào báo ra (PRD E-13).
