# GD-20 · Cây quyết định Signboard

**Hôm nay là 10/03/2026.** Mọi trạng thái đều so với ngày này.

**Sáu trạng thái, mỗi cái một ô.**

| Ô | Trạng thái | Vì sao |
|---|---|---|
| 1 | `COMPLETED` | đã Done — xong là xong, kể cả khi trễ |
| 2 | `NYS` | chưa tới ngày bắt đầu (12/03 còn ở tương lai) |
| 3 | `ON_SCHEDULE` | bắt đầu đúng hạn, chưa quá ngày kết thúc |
| 4 | `NO_PLAN` | thiếu cả hai ngày kế hoạch — **không kết luận được** |
| 5 | `DELAY_START` | quá ngày bắt đầu mà chưa động tới |
| 6 | `DELAY_END` | quá ngày kết thúc mà chưa xong |
| 7 | `DELAY_START` | bắt đầu trễ (08/03 so với 05/03) nhưng **còn trong hạn** |

**Ca 6 và ca 7 là hai đầu của cùng một cây quyết định.** Ticket vừa bắt đầu trễ **vừa** quá hạn phải ra `DELAY_END` chứ không phải `DELAY_START`: đảo thứ tự hai bước xét sẽ làm PM thấy màu vàng thay vì màu đỏ và không ưu tiên xử lý. Lỗi này hoàn toàn im lặng.

**Hai ca gộp ô.**

- Ô 8: `Completed` (hạng 0) + `NYS` (hạng 1) → ra **`NYS`**. Đúng, vì ô đó **chưa xong**.
- Ô 9: `DELAY_START` (hạng 4) + `DELAY_END` (hạng 5) → ra **`DELAY_END`**, cái xấu nhất.

Ngày của ô gộp lấy MIN ngày bắt đầu và MAX ngày kết thúc — ô chỉ thật sự kết thúc khi ticket muộn nhất kết thúc.

**Ô 10 trống khác hẳn `NO_PLAN`.** Ô trống nghĩa là Function này **vốn không có khâu đó**; `NO_PLAN` nghĩa là *có* ticket nhưng thiếu ngày. Gộp hai khái niệm sẽ làm thanh tóm tắt đếm sai (PRD §6.6).
