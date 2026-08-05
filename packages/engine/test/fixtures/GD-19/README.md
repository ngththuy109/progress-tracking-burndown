# GD-19 · Phân tách tiêu đề Sub-task

**Định dạng.** `[Project][Team][Phase][FunctionName]_TaskName`

**Tám ca, mỗi ca một điểm.**

| Mã | Tiêu đề | Điểm cần bắt |
|---|---|---|
| S-1 | `[PAY][TeamA][Design][Login]_Create` | ca cơ bản |
| S-2 | `...[Login_Form]_BALReview` | **gạch dưới nằm trong tên Function** vẫn tách đúng, vì ngoặc vuông đã tự phân tách |
| S-3 | `［PAY］…［決済］_JMReview` | ngoặc **toàn giác** kiểu Nhật |
| S-4 | `...[login]_Create` | khác hoa/thường |
| S-5 | `...[Ｌｏｇｉｎ]_Create` | chữ **toàn giác** |
| S-6 | `決済画面を作る` | không khớp định dạng → `UNPARSED` |
| S-7 | `...[Login]_Deploy` | `TaskName` lạ → `taskType = null` |
| S-8 | `[PAY][TeamA][Dev][Login]_Create` | `[Phase]` trong tiêu đề **lệch** với Task cha |

**Ba điều quan trọng nhất.**

1. **S-1, S-4, S-5 phải gộp thành MỘT hàng** trên bảng Signboard: `functionKey` của cả ba đều là `login` (chuẩn hoá NFKC + chữ thường). Không gộp thì cùng một chức năng hiện thành ba hàng và bảng trở nên vô dụng (PRD E-31).
2. **S-6 vẫn được tính vào Burndown** dù không lên được Signboard. Tiêu đề đặt sai không làm cho công việc biến mất (quy ước C-11).
3. **S-8 lấy Phase của Task cha**, kèm cảnh báo `PHASE_MISMATCH`. Cây Jira là cấu trúc thật; tiêu đề chỉ là chữ.
