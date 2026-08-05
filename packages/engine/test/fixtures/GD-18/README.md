# GD-18 · Sub-task chuyển Phase

**Kịch bản.** PAY-13 (kế hoạch 05/03 → 06/03) vừa được chuyển từ Phase **DESIGN** sang Phase **DEV**.

**Điểm cần bắt.** Phải tính lại **cả hai** Phase, không chỉ Phase mới:

| Phase | Trước | Sau | Vì sao |
|---|---|---|---|
| DESIGN | kết thúc 06/03 | kết thúc **04/03** | mất PAY-13, mốc muộn nhất còn lại là PAY-12 |
| DEV | bắt đầu 09/03 | bắt đầu **05/03** | nhận PAY-13, mốc sớm nhất bây giờ là của nó |

Sinh **hai** bản ghi dịch chuyển, cả hai đều mang số ngày âm.

**Vì sao dễ sai.** Chỉ tính lại Phase mới là việc tự nhiên nhất khi viết code. Làm vậy thì Phase cũ giữ nguyên số liệu của một Sub-task **không còn thuộc về nó** — tổng các Phase vẫn bằng Epic nên không có gì báo lỗi, nhưng cả hai Phase đều sai (PRD E-24).
