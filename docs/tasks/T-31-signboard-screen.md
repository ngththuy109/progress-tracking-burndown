---
id: T-31
title: Bảng Signboard và khu "chưa lên được bảng"
status: review
model: opus
effort: high
depends_on: ["T-20", "T-28", "T-29"]
touches:
  - apps/web/src/routes/signboard/
  - apps/web/src/api/use-signboard.ts
  - apps/web/e2e/signboard.spec.ts
  - apps/web/src/routes/app-routes.tsx
  - apps/web/src/styles.css
prd_refs: ["§6.1", "§6.3", "§6.4", "§6.5", "§6.6", "US-13", "US-14", "US-15"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-31 · Bảng Signboard và khu "chưa lên được bảng"

## Mục tiêu
PM chọn một Phase và thấy ngay ma trận **Function × loại task**: function nào đang trễ, trễ ở khâu nào.

## Ngữ cảnh cần biết

**Mockup** (PRD §6.1):

```
┌ Signboard · Epic PAY-1 · Phase Thiết kế ────────────── 10/03/2026 ┐
│  3 trễ kết thúc · 5 trễ bắt đầu · 12 đúng tiến độ · 2 chưa có ngày │
│  [tìm Function...]                                                 │
├──────────┬─────────┬───────────┬──────────────┬──────────┬────────┤
│ Function │ Create  │ BALReview │ FixCommentBAL│ JMReview │  Tổng  │
├──────────┼─────────┼───────────┼──────────────┼──────────┼────────┤
│ Login    │ 02→03 ✅│ 04→05 🟦  │      —       │ 09→10 ⬜ │   🟦   │
│ 決済     │ 02→03 ✅│ 04→05 🟥  │  06→08 🟨≡2  │ 09→10 ⬜ │   🟥   │
└──────────┴─────────┴───────────┴──────────────┴──────────┴────────┘
```

**Sáu trạng thái** (PRD §6.3) — màu đã có sẵn thành biến CSS từ T-20:

| Trạng thái | Nghĩa | Sắc thái `Badge` |
|---|---|---|
| `COMPLETED` | Đã xong | `success` |
| `ON_SCHEDULE` | Đang làm, đúng tiến độ | `info` |
| `NYS` | Chưa tới ngày bắt đầu | `neutral` |
| `DELAY_START` | Quá ngày bắt đầu mà chưa bắt đầu, hoặc bắt đầu trễ | `warning` |
| `DELAY_END` | Quá ngày kết thúc mà chưa xong | `danger` |
| `NO_PLAN` | Thiếu `wbs_*`, **không kết luận được** | `muted` + kẻ sọc + ⚠ |

**Ô trống `—` KHÁC HẲN `NO_PLAN`.** Ô trống = Function này vốn không có khâu đó. `NO_PLAN` = *có* ticket nhưng thiếu ngày. Đây là chỗ dễ nhầm nhất của cả màn hình (PRD §6.5).

**Ô gộp nhiều ticket** hiện huy hiệu `≡N`, mang trạng thái **xấu nhất**, rê chuột ra danh sách từng ticket.

**Màu không được là thứ duy nhất mang nghĩa.** Người mù màu và bản in đen trắng đều mất sạch thông tin. Mỗi ô phải có **chữ hoặc ký hiệu** nói lên trạng thái.

## Phạm vi

**Trong:**
- Bảng Function × loại task, có cột "Tổng" mỗi hàng
- Ô hiện `plan_start → plan_end` + trạng thái; ngày thực tế trong tooltip
- Ô gộp: huy hiệu `≡N` + danh sách ticket khi rê chuột
- Thanh tóm tắt đếm theo trạng thái, **bấm được để lọc**
- Ô tìm kiếm Function
- Khu "chưa lên được bảng" ở dưới, kèm lý do và link Jira
- Banner cảnh báo khi > 30% Sub-task không parse được tiêu đề
- Bộ chọn Epic và Phase

**Ngoài:**
- Không sửa API (T-28 đã đủ)
- Không làm màn hình cấu hình cột (T-32)
- Không cho sửa dữ liệu — bảng này chỉ để đọc

## Đầu vào đã có
- Ba endpoint từ **T-28**
- `DataTable` (có `render` tuỳ biến từng ô), `Badge` 6 sắc thái, `EmptyState` từ **T-20**
- Biến màu `--tone-*` trong `styles.css` từ **T-20**

## Việc phải làm

1. `use-signboard.ts` — hook cho ba endpoint của T-28.
2. Bảng dùng lại `DataTable`; mỗi ô là một component riêng vẽ ngày + `Badge` + huy hiệu `≡N`.
3. **Bảng sẽ rất rộng** (một cột cho mỗi loại task). Cột Function phải **dính bên trái** khi cuộn ngang; `.table-wrap` từ T-20 đã lo phần cuộn.
4. Thanh tóm tắt: bấm một trạng thái thì chỉ còn ô mang trạng thái đó; bấm lần nữa thì bỏ lọc. Đang lọc phải có dấu hiệu rõ ràng để không ai tưởng dữ liệu bị mất.
5. Ô `NO_PLAN` vẽ **kẻ sọc + biểu tượng ⚠**, không chỉ đổi màu.
6. Tooltip của ô gộp liệt kê từng ticket kèm trạng thái riêng và link Jira.
7. Khu "chưa lên được bảng" chia hai nhóm rõ ràng:
   - *Tiêu đề đặt sai định dạng* — kèm định dạng đúng để PM biết sửa thế nào
   - *Loại task lạ* — kèm gợi ý thêm cột nếu xuất hiện ≥ 3 lần, có nút mở sang T-32
8. Ô tìm kiếm lọc theo **`function_key`** đã chuẩn hoá, để gõ `login` cũng tìm ra `Ｌｏｇｉｎ`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-3** — file `kebab-case.tsx`.
- **C-9** — thông báo tiếng Việt, nói cả cách khắc phục.
- **C-10** — thiếu ngày thì hiện `NO_PLAN`, tuyệt đối không đoán.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:web` xanh
- [ ] `pnpm e2e` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**E2E — theo đúng US-13, US-14, US-15:**
1. `chọn một Phase thì thấy ma trận Function × loại task`
2. `bấm "3 trễ kết thúc" trên thanh tóm tắt thì chỉ còn các ô đó`
3. `hai ticket cùng một ô thì ô hiện huy hiệu ≡2 và trạng thái xấu nhất`
4. `rê chuột lên ô gộp thấy danh sách từng ticket kèm trạng thái riêng`
5. `Sub-task đặt tên sai định dạng hiện ở khu dưới kèm lý do, KHÔNG bị giấu đi`
6. `ô thiếu ngày kế hoạch hiện NO_PLAN có kẻ sọc, khác hẳn ô trống —`
7. `gõ "login" vào ô tìm kiếm cũng tìm ra hàng có tên Ｌｏｇｉｎ`

**Đơn vị:**
8. `mỗi ô có chữ hoặc ký hiệu nói lên trạng thái, không chỉ có màu`
9. `cột Tổng của mỗi hàng không bao giờ tốt hơn ô xấu nhất trong hàng`
10. `hơn 30% Sub-task không parse được thì hiện banner cảnh báo`

## Định nghĩa "xong"
PM mở Signboard của Phase Thiết kế, thấy ngay function nào đang trễ ở khâu nào, bấm lọc "trễ kết thúc" để biết cần xử lý cái gì trước, và thấy được danh sách Sub-task chưa lên được bảng để đi sửa tên.

## Cạm bẫy đã biết
- **Trộn ô trống `—` với `NO_PLAN` là lỗi nghiệp vụ, không phải lỗi hiển thị.** Một cái nghĩa là "không có việc đó", cái kia nghĩa là "có việc nhưng chưa biết bao giờ". Trộn lẫn làm thanh tóm tắt đếm sai và PM đi tìm 20 việc không tồn tại.
- **Chỉ dùng màu để phân biệt 6 trạng thái là loại bỏ người mù màu khỏi sản phẩm.** Khoảng 8% nam giới không phân biệt được đỏ và xanh lá — tức là gần như chắc chắn có người trong đội PM.
- **Giấu Sub-task không parse được cho bảng "sạch" là tự tay tạo ra một góc khuất.** Chúng vẫn được tính vào Burndown (C-11), nên bảng sạch mà tổng không khớp sẽ khiến PM mất lòng tin vào cả hai màn hình.
- **Bảng rộng mà cột Function không dính bên trái thì cuộn sang phải là mất luôn tên hàng**, và mọi ô trở nên vô nghĩa.
- **Đừng lọc theo `function_name` chưa chuẩn hoá.** Ô tìm kiếm phải khớp trên `function_key`, nếu không gõ `login` sẽ không ra `Login`.
- **Trạng thái phụ thuộc "hôm nay".** Người dùng mở tab từ hôm qua rồi quay lại sẽ thấy trạng thái cũ. Hiện rõ **ngày đang tính** ở góc bảng và cho tải lại.

## Đã làm gì

**12 test E2E xanh** (card yêu cầu 10), tất cả xanh ngay lần chạy đầu.

### Ô trống và `NO_PLAN` được tách bằng ba tầng, không chỉ bằng màu

| Tầng | Ô trống | `NO_PLAN` |
|---|---|---|
| Kiểu dữ liệu | `{ present: false }` — không có trường `status` | có `status` |
| Chữ hiển thị | `—` | `⚠ Chưa có ngày` |
| Nền | không | **kẻ sọc chéo** |

Test khẳng định cả hai: ô trống có `title="…không có khâu đó"`, ô `NO_PLAN` có class kẻ sọc và chữ *"Chưa có ngày"*. Trộn hai thứ này là lỗi nghiệp vụ chứ không phải lỗi hiển thị — nó làm thanh tóm tắt đếm sai và PM đi tìm hàng chục việc không tồn tại.

### Màu không bao giờ là thứ duy nhất mang nghĩa

Có một test riêng đọc **chữ** của ba trạng thái (`Xong`, `Trễ kết thúc`, `Chưa có ngày`). Khoảng 8% nam giới không phân biệt được đỏ với xanh lá, tức là gần như chắc chắn có người trong đội PM; và bản in đen trắng thì mất sạch màu.

`NO_PLAN` còn được thêm kẻ sọc + biểu tượng ⚠ vì nó là trạng thái dễ bị bỏ qua nhất.

### Lọc làm MỜ chứ không làm MẤT

Bấm một trạng thái trên thanh tóm tắt thì các ô khác chuyển thành dấu `·` mờ, kèm dòng chữ *"các ô khác bị làm mờ, không phải mất"*. Bấm lần nữa là bỏ lọc.

Nếu ẩn hẳn thì bảng co lại và người dùng tưởng dữ liệu biến mất — mà không có nút nào rõ ràng để quay về.

### Ô tìm kiếm khớp trên `functionKey` đã chuẩn hoá

Gõ `login` tìm ra hàng tên `Ｌｏｇｉｎ`. Khớp trên `functionName` thô thì ba dạng viết của cùng một chức năng sẽ không tìm thấy nhau (E-31).

### Cột Function dính bên trái

Bảng Signboard rất rộng (một cột cho mỗi loại task). Cuộn sang phải mà mất tên hàng thì mọi ô trở nên vô nghĩa. `position: sticky; left: 0` trên cả `<th>` đầu hàng lẫn ô tiêu đề cột.

### Ngày đang tính luôn hiện ở đầu bảng

Trạng thái phụ thuộc "hôm nay". Người dùng mở tab từ hôm qua rồi quay lại sẽ thấy trạng thái cũ mà không có gì báo — nên `asOfDate` hiện thẳng cạnh mã Epic, kèm nút Tải lại. `staleTime: 0` để dữ liệu không bị giữ lại qua nửa đêm.

### Khu "chưa lên được bảng" nói rõ hai điều

1. Những Sub-task này **vẫn được tính vào Burndown** — nhắc ở cả tiêu đề khu lẫn từng dòng. Giấu chúng đi cho bảng "sạch" là tự tạo ra một góc khuất, và tổng không khớp sẽ làm PM mất lòng tin vào cả hai màn hình.
2. Loại task lạ xuất hiện ≥ 3 lần thì hiện gợi ý thêm cột, kèm liên kết mở thẳng màn hình cấu hình cột (T-32).

## Bổ sung sau này — chọn NHIỀU Phase & "toàn bộ Epic"

Bộ chọn Phase từ chỗ chọn MỘT nay chọn được NHIỀU Phase một lúc, kèm nút
**Whole epic** mở mọi Phase đang có Sub-task. Lưu ở URL: `?phases=A,B` hoặc
`?phases=__all__` (token bám theo danh sách Phase hiện tại, Epic thêm/bớt Phase
không phải sửa link). Tham số cũ `?phase=A` **vẫn đọc được** nên link chia sẻ từ
trước không gãy.

Mỗi Phase được chọn dựng thành MỘT bảng riêng, xếp chồng theo `display_order`,
**không trộn số liệu**: mỗi bảng giữ nguyên thanh tóm tắt, cột Sub-phase, banner
cảnh báo và khu "chưa lên được bảng" của chính nó. Chọn đúng một Phase thì giữ
nguyên khung nhìn cũ (không thêm tiêu đề). Dùng lại nguyên `SignboardBoard` của
mỗi Phase — **không đụng API (T-28) hay engine**, chỉ là lớp chọn + xếp bảng ở
`SignboardScreen`.
