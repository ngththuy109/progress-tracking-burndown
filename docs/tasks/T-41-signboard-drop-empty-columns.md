---
id: T-41
title: Signboard không dựng cột không có task nào
status: review
model: opus
effort: low
depends_on: ["T-28", "T-31", "T-35"]
touches:
  - apps/api/src/services/signboard.service.ts
  - apps/api/src/routes/signboard.routes.test.ts
  - apps/web/src/routes/signboard/index.tsx
  - apps/web/src/routes/signboard/signboard.test.tsx
  - packages/shared/src/api-signboard.ts
  - docs/PRD_Burndown_Engine.md
  - README.md
prd_refs: ["§6.1", "§6.6"]
owner: claude
started_at: 2026-08-17
finished_at: 2026-08-17
---

# T-41 · Signboard không dựng cột không có task nào

## Mục tiêu
Bảng Signboard chỉ vẽ những cột **thật sự có việc**. Loại task mà cả bảng không
có Sub-task nào (cột trống từ trên xuống dưới) không được dựng, để PM không phải
cuộn ngang qua những cột không nói lên điều gì.

## Ngữ cảnh cần biết

**Cột trước đây LUÔN là toàn bộ cấu hình.** T-35 nhân bộ cột cấu hình cho MỖI
Sub-phase để "giữ lưới đều, so ngang giữa các Sub-phase". Với Phase chỉ làm vài
khâu (hoặc có nhiều Sub-phase), bảng phình ra rất rộng mà phần lớn là ô trống —
đúng thứ PM báo lại.

**Ô trống vẫn giữ nguyên ý nghĩa (§6.6).** Việc rút cột xét trên **cả bảng**, KHÔNG
theo từng hàng: chỉ cần MỘT Sub-task ở một Function là cột được giữ, và các
Function khác vẫn hiện ô trống `—` như trước. Không có chuyện ô trống biến mất
khỏi một hàng nào đó.

**Cột cấu hình không đổi.** Đây thuần tuý là chuyện dựng bảng lúc đọc; màn
"Signboard columns" và bảng `signboard_column` giữ nguyên. Cột vắng mặt chỉ vì
Phase đang xem chưa có việc ở khâu đó, không phải vì ai xoá cấu hình.

## Phạm vi

**Trong:**
- `buildSignboard` lọc cột lá theo tập `(subPhaseKey, taskType)` CÓ Sub-task
- Nhóm Sub-phase không còn cột nào thì bỏ luôn khỏi `columnGroups`
- Web: nói rõ khi KHÔNG còn cột nào thay vì vẽ bảng rỗng
- Cập nhật PRD §6.1 + README

**Ngoài:**
- Không đụng cấu hình cột (`signboard_column`, màn `/config/signboard`)
- Không đụng `packages/engine` — logic ô giữ nguyên
- Không lọc theo từng HÀNG (một hàng trống không làm mất cột của hàng khác)
- Không đụng khu "chưa lên được bảng" — Sub-task loại task lạ vẫn nằm nguyên ở đó

## Đầu vào đã có
- `apps/api/src/services/signboard.service.ts` — `buildSignboard` đã gộp ô theo
  khoá `(subPhaseKey, taskType)`, chỉ thiếu bước biết khoá nào có việc.
- `apps/web/src/routes/signboard/index.tsx` — `groupOffsets` vốn đã cộng dồn theo
  `taskColumns.length` của TỪNG nhóm, nên nhóm lệch số cột không cần sửa gì thêm.

## Việc phải làm
1. Service: gom `usedCells: Set<string>` ngay trong vòng lặp Sub-task; dựng
   `groups` = Sub-phase × cột đã lọc, bỏ nhóm rỗng; `columnGroups`, `columns`
   (cột lá), `cells`, `subtotals`, `summary.totalCells` đều lấy theo `groups`.
2. `packages/shared`: sửa mô tả `taskColumns` — không còn "cùng bộ cột cho mọi nhóm".
3. Web: `BoardTable` hiện `EmptyState` khi `columnGroups` rỗng.
4. Sửa các test đang mã hoá hành vi cũ + thêm test cho hành vi mới; cập nhật PRD/README.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):
- **E-31** — gộp theo khoá đã chuẩn hoá (NFKC + lowercase); tập `usedCells` dùng
  đúng khoá `(subPhaseKey đã chuẩn hoá, taskType)` mà ô đang dùng.
- **C-10** — cột do người khai, không suy ra từ dữ liệu. Rút cột rỗng KHÔNG được
  biến thành "tự sinh cột theo dữ liệu": `taskType` lạ vẫn không thành cột.
- Ranh giới engine (ARCHITECTURE.md §2) — việc dựng cột nằm ở service.

## Checklist đầu ra
- [x] `pnpm typecheck` xanh
- [x] `pnpm lint` xanh
- [x] `pnpm test` xanh (1349 pass, 2 skip)
- [x] Cập nhật `status: review` + `finished_at`

## Test phải viết
- `cột không có Sub-task nào thì KHÔNG được dựng`
- `CHỈ MỘT Function có việc ở một cột thì cột đó vẫn được dựng`
- `cột rỗng được rút theo TỪNG Sub-phase, không phải cả bảng`
- `Sub-phase chỉ toàn loại task chưa khai cột thì KHÔNG thành nhóm`
- `totalCells = số hàng × số cột lá CÒN LẠI sau khi rút cột rỗng`
- Web: `vẽ đúng cột của TỪNG nhóm, ô vẫn khớp cột dù nhóm sau ít cột hơn`
- Web: `không cột nào còn task thì nói rõ, không vẽ bảng rỗng`

## Định nghĩa "xong"
Mở một Phase mà cả Phase chỉ có Sub-task khâu `Create`: bảng hiện đúng MỘT cột
`Create` cho mỗi Sub-phase, không còn cột review trống; `cells` vẫn 1:1 với
`columns` và `summary` cộng khớp.

## Cạm bẫy đã biết
- **Lọc theo hàng thay vì theo bảng.** Làm vậy thì mỗi hàng một bộ cột khác nhau
  và `cells` hết 1:1 với `columns` — lưới gãy im lặng.
- **Quên nhóm rỗng.** Sub-phase mà mọi Sub-task đều mang loại task chưa khai cột
  sẽ còn 0 cột; để nguyên thì web dựng `colSpan={0}` và ra header cụt.
- **`summary.totalCells` tính theo cấu hình.** Phải tính theo số cột lá CÒN LẠI,
  không thì bất biến `Σ(byStatus) + emptyCells = totalCells` (§8.3) vỡ.

## Đã làm gì

### Một tập `usedCells`, phần còn lại là lọc
`buildSignboard` vốn đã đi qua từng Sub-task để gom ô theo khoá
`(subPhaseKey, taskType)`; chỉ thêm `usedCells.add(cellKey)` ngay tại đó là biết
được cột nào có việc — không thêm vòng lặp, không thêm truy vấn. Cột lá, nhóm
cột, `cells`, `subtotals` và `totalCells` sau đó đều đọc từ cùng một danh sách
`groups`, nên không có đường nào để `cells` lệch khỏi `columns`.

### Rút theo TỪNG Sub-phase
Sub-phase `P1` chỉ làm `Create` còn `P2` chỉ làm `JMReview` thì mỗi nhóm chỉ còn
đúng cột của mình (2 cột thay vì 6). Đổi lại, các nhóm có thể khác số cột nhau —
web không phải sửa vì `groupOffsets` đã cộng dồn theo `taskColumns.length` của
từng nhóm từ T-35; đã thêm test web dựng nhóm lệch cột để chốt điều đó.

### Nhóm rỗng cũng bị bỏ
Sub-phase mà mọi Sub-task đều mang loại task chưa khai cột thì không còn cột nào
để dựng → bỏ luôn cả nhóm thay vì để header cụt. Những Sub-task đó vẫn nằm đủ ở
khu "chưa lên được bảng" (§6.8) nên không mất dấu.

### Test cũ mã hoá hành vi cũ
8 test cũ giả định "cột luôn là toàn bộ cấu hình" (ví dụ: một Sub-task `Create`
mà vẫn đòi 3 cột). Đã sửa từng cái theo hướng **giữ nguyên ý định bài test** —
thêm Sub-task/Function để lưới còn đủ cột mà kiểm — chứ không hạ kỳ vọng.
