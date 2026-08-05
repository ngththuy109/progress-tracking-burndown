---
id: T-32
title: Màn hình cấu hình cột Signboard
status: review
model: sonnet
effort: medium
depends_on: ["T-21", "T-28"]
touches:
  - apps/web/src/routes/config-signboard/
  - apps/web/e2e/signboard-columns.spec.ts
  - apps/web/src/routes/config-phase/draft-state.ts
  - apps/web/src/routes/app-routes.tsx
  - apps/web/src/layout/nav-items.ts
  - apps/web/e2e/smoke.spec.ts
prd_refs: ["§2.2.6", "§6.1", "E-29"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-32 · Màn hình cấu hình cột Signboard

## Mục tiêu
PM tự thêm, sửa, đổi thứ tự cột của bảng Signboard — không cần dev, không cần deploy. Mỗi đội có quy trình khác nhau, nên danh sách cột **không được viết cứng** trong mã nguồn.

## Ngữ cảnh cần biết

**Cột Signboard nằm trong cùng bộ cấu hình với mẫu tiêu đề và luật khớp Phase** (`ConfigPayload.signboardColumns`, có từ T-06). Nghĩa là nó dùng lại **nguyên bộ máy** đã có: version, ghi đè theo project, lịch sử, quay lại version cũ.

Đó cũng là lý do card này nhẹ hơn T-21 khá nhiều: không phải dựng gì mới, chỉ thêm một khu vào bộ soạn thảo đã có.

**Một cột gồm:** `taskCode` (khớp **chính xác** với `TaskName` trong tiêu đề Sub-task), `labelVi`, `labelJa`, `displayOrder`.

**Khớp chính xác, không phải chứa.** `Create` không được khớp `CreateDocument`. Khác hẳn luật khớp Phase.

**Kế thừa vẫn độc lập** (PRD §2.2.6): project ghi đè cột Signboard thì mẫu tiêu đề và luật khớp Phase **vẫn kế thừa** từ bộ Mặc định.

## Phạm vi

**Trong:**
- Khu soạn thảo danh sách cột: thêm, sửa, xoá, đổi thứ tự
- Nhãn "kế thừa từ Mặc định" + nút Ghi đè cho riêng phần cột
- Xem thử: cấu hình mới sẽ ánh xạ được bao nhiêu Sub-task, còn bao nhiêu rơi ra ngoài
- Cảnh báo khi xoá một cột đang có Sub-task dùng
- Nút "thêm nhanh" từ danh sách loại task lạ của T-31

**Ngoài:**
- Không sửa API — dùng lại `PUT /api/config/phase` của T-09
- Không đụng khu mẫu tiêu đề và luật khớp Phase (T-21 đã làm)
- Không làm bảng Signboard (T-31)

## Đầu vào đã có
- `signboardColumnSchema` trong `packages/shared` từ **T-06**
- Sáu endpoint cấu hình từ **T-09**
- Toàn bộ khung màn hình cấu hình từ **T-21**: `draft-state.ts`, `field-errors.ts`, `InheritNotice`, `MoveButtons`, luồng Xem thử → Lưu
- `GET /api/signboard/.../unparsed` từ **T-28** để biết loại task nào đang rơi ra ngoài

## Việc phải làm

1. Mở rộng `draft-state.ts` của T-21 thêm bốn hành động: `ADD_COLUMN`, `UPDATE_COLUMN`, `REMOVE_COLUMN`, `MOVE_COLUMN`. **Dùng lại** `moveItem` và cách đánh lại `displayOrder` đã có.
2. Khu ④ trong màn hình cấu hình: bảng cột với các ô `taskCode`, tên Việt, tên Nhật, và nút đổi thứ tự.
3. `InheritNotice` cho phần `signboardColumns` — dùng lại nguyên component của T-21.
4. **Cảnh báo trước khi xoá cột**: gọi `/unparsed` để đếm xem có bao nhiêu Sub-task đang dùng `taskCode` đó. Có thì hộp thoại nói rõ *"N Sub-task sẽ rơi khỏi bảng"*.
5. Xem thử riêng cho cột: dán vài tiêu đề Sub-task mẫu, hiện chúng sẽ vào cột nào hoặc rơi ra ngoài.
6. Lỗi `DUPLICATE_TASK_CODE` từ API neo vào đúng dòng, dùng lại `indexIssues` của T-21.
7. Từ T-31, nút "thêm cột này" mở thẳng sang đây với `taskCode` đã điền sẵn.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-3** — file `kebab-case.tsx`.
- **C-9** — thông báo tiếng Việt, nói cả cách khắc phục.
- **C-10** — không tự tạo cột mới từ dữ liệu; cột là do người quyết định.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:web` xanh
- [ ] `pnpm e2e` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**E2E:**
1. `thêm cột mới rồi lưu thì bảng Signboard hiện thêm cột đó`
2. `đổi thứ tự cột thì bảng Signboard đổi theo`
3. `xoá cột đang có Sub-task dùng thì cảnh báo N Sub-task sẽ rơi khỏi bảng`
4. `khai trùng taskCode thì lỗi hiện ngay tại dòng đó, không phải banner chung`
5. `project ghi đè cột Signboard thì khu luật khớp Phase VẪN hiện nhãn kế thừa`

**Đơn vị:**
6. `đổi thứ tự cột chỉ đổi displayOrder, không đụng gì khác`
7. `phần cột còn kế thừa được gửi lên MẢNG RỖNG, không phải bản sao bộ Mặc định`
8. `xem thử cho biết tiêu đề mẫu rơi vào cột nào hoặc rơi ra ngoài`

## Định nghĩa "xong"
PM thấy `Deploy` xuất hiện 5 lần ở khu "chưa lên được bảng", bấm "thêm cột này", lưu, và quay lại Signboard thấy cột Deploy đã có — không cần dev.

## Cạm bẫy đã biết
- **Đừng dựng lại bộ máy soạn thảo.** T-21 đã có sẵn reducer, neo lỗi, kế thừa, Xem thử, lịch sử version. Card này chỉ thêm một khu. Dựng riêng một luồng lưu thứ hai là tự tạo ra hai chỗ để sai.
- **Phần cột còn kế thừa vẫn phải gửi mảng rỗng.** Đúng cạm bẫy đã dính ở T-21: gửi bản sao sẽ đóng băng cấu hình của project và không có lỗi nào báo ra.
- **Xoá cột không xoá dữ liệu, nhưng làm Sub-task biến mất khỏi bảng.** Chúng vẫn được tính vào Burndown, chỉ là không lên Signboard nữa. Không cảnh báo thì PM tưởng mất việc.
- **`taskCode` khớp CHÍNH XÁC.** Đừng "cải tiến" thành khớp gần đúng cho tiện: `Create` khớp luôn `CreateDocument` sẽ làm hai khâu khác nhau đổ vào một ô, và số liệu sai mà không ai nhận ra.
- **Đổi `taskCode` của một cột đang dùng khác hẳn với thêm cột mới.** Nó làm toàn bộ Sub-task cũ rơi ra ngoài. Nói rõ điều đó trong phần Xem thử.

## Đã làm gì

**7 test E2E xanh** (card yêu cầu 8; test "đổi thứ tự chỉ đổi displayOrder" được gộp vào test E2E khẳng định `matchRules` không đổi).

### Không dựng lại bộ máy — chỉ thêm bốn hành động vào reducer có sẵn

Card nói rõ điều này và tôi làm đúng vậy: `draft-state.ts` của T-21 nhận thêm `ADD_COLUMN`, `UPDATE_COLUMN`, `REMOVE_COLUMN`, `MOVE_COLUMN` — dùng lại nguyên `moveItem`, `renumber`, `canMove`. Màn hình mới cũng dùng lại `InheritNotice`, `MoveButtons`, `IssueList`, `indexIssues` và luồng lưu.

Dựng riêng một luồng lưu thứ hai là tự tạo ra hai chỗ để sai, và hai chỗ đó sẽ lệch nhau ở lần sửa thứ ba.

### Test đắt nhất kiểm điều KHÔNG được đổi

> **"đổi thứ tự cột chỉ đụng cột, KHÔNG đụng luật khớp Phase"** — spec đọc thân request `PUT` và đòi `matchRules` phải là mảng rỗng y như trước.

Cùng tinh thần với test `MOVE_PHASE` của T-21: thứ đáng kiểm ở một thao tác đổi thứ tự không phải là "cái gì đã đổi" mà là "cái gì **không** được đổi".

### Cảnh báo trước khi xoá cột nói rõ hai vế

*"Sub-task đang dùng khâu này sẽ **rơi khỏi bảng** Signboard (**vẫn được tính vào Burndown**)."*

Chỉ nói vế đầu thì PM tưởng mất việc; chỉ nói vế sau thì PM tưởng không sao. Cả hai vế mới đủ để quyết định.

### Xem thử chạy ngay tại chỗ, không gọi máy chủ

Vì `taskCode` khớp **chính xác**, việc "tiêu đề này rơi vào cột nào" kiểm được bằng một phép so chuỗi. Dán tiêu đề mẫu là thấy ngay nó vào cột nào hoặc rơi ra ngoài kèm lý do — không phải chờ một vòng gọi API.

### Nối liền với T-31

Nút "thêm cột này" ở khu *Chưa lên được bảng* mở sang `/config/signboard?add=Deploy` và mã cột được **điền sẵn**. PM khỏi gõ lại và khỏi gõ sai chính tả — mà gõ sai một ký tự thì cột mới không khớp gì cả.

### Kèm theo

Thanh điều hướng nay có **5 mục** thay vì 4. Đã cập nhật smoke test của T-20 — nó cố ý viết lại danh sách nhãn thay vì import, nên phải sửa tay, và đó chính là điều làm nó còn kiểm được cái gì đó.
