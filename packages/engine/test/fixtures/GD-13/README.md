# GD-13 · Cấu hình nhận diện Phase

**Kịch bản.** Hai mẫu tiêu đề, ba luật khớp trong đó **hai luật cùng khớp một tiêu đề**.

**Điều phải nhớ trước tiên.** Mẫu tiêu đề được biên dịch thành regex **neo hai đầu**, tức nó phải khớp **toàn bộ** tiêu đề. Vì vậy quy ước là `[Phase] {name}` — chữ *Phase* nằm nguyên văn trong ngoặc, phần tên nằm sau. Viết `[{name}]` sẽ chỉ khớp những tiêu đề **chỉ có** cặp ngoặc và không có gì khác.

**Sáu ca.**

| Tiêu đề | Kết quả | Vì sao |
|---|---|---|
| `[Phase] Design` | DESIGN | chỉ luật "Design" khớp |
| `[Phase] Design Review` | **TESTING** | cả hai luật cùng khớp, luật ưu tiên **10** thắng luật ưu tiên 50 |
| `【開発】` | DEV | mẫu thứ hai khớp |
| `［Phase］ Ｄｅｓｉｇｎ` | DESIGN | ngoặc và chữ **toàn giác**, chuẩn hoá NFKC xong mới khớp |
| `決済画面の開発作業` | DEV | không mẫu nào khớp → quét từ khoá trên **cả tiêu đề** |
| `[Phase] Release` | UNCLASSIFIED | bóc được nhãn nhưng không luật nào khớp |

**Vì sao ca toàn giác quan trọng.** Người Nhật gõ ngoặc toàn giác `［］` là chuyện thường ngày, và nhìn bằng mắt thì **không phân biệt được** với ngoặc nửa giác. Thiếu bước chuẩn hoá NFKC thì một nửa số Task rơi vào "chưa phân loại" mà không ai hiểu vì sao.

**Ca cuối cùng là ranh giới cần nhớ.** Bóc được nhãn ≠ phân loại được. `Release` bóc ra ngon lành nhưng chưa có luật nào nhận, nên nó phải hiện ở khu "chưa nhận diện được" để PM thêm luật, chứ không được đoán bừa.
