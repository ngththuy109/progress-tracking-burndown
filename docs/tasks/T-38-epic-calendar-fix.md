---
id: T-38
title: Sửa gán lịch cho Epic + hiện cảnh báo lịch trên Burndown
status: review
model: opus
effort: low
depends_on: ["T-10", "T-29", "T-30", "T-36"]
touches:
  - apps/web/src/routes/epics/add-epics-panel.tsx
  - apps/web/src/routes/epics/index.tsx
  - apps/web/src/routes/burndown/index.tsx
  - apps/api/src/adapters/burndown.adapters.ts
  - apps/api/src/services/burndown.service.ts
  - packages/shared/src/api-burndown.ts
  - tools/db/fix-epic-calendar.sql
prd_refs: ["§9.4", "E-14", "C-10"]
owner: null
started_at: 2026-08-11
finished_at: 2026-08-11
---

# T-38 · Sửa gán lịch cho Epic + hiện cảnh báo lịch trên Burndown

## Mục tiêu

Bịt nốt gốc rễ của lỗi "đường plan chia đều cho tất cả các ngày": màn Track
new Epics gán cứng `calendarId: 'default'` — một lịch **không tồn tại trong
seed** — nên mọi tầng âm thầm rơi về lịch mặc định không có ngày lễ. Sau card
này, PM chọn lịch thật khi thêm Epic, đổi được lịch của Epic đã theo dõi, và
mọi cấu hình lịch sai đều hiện cảnh báo ngay trên biểu đồ.

## Ngữ cảnh cần biết

- `WorkCalendar.warnings` tồn tại từ T-12 với đúng mục đích "tầng API còn phải
  hiện nó cho người dùng (C-10)" — nhưng trước card này nó chưa bao giờ đi vào
  `BurndownResponse`. Card này chỉ nối nốt đoạn ống đã có sẵn.
- Múi giờ chốt sổ snapshot phải ĐI THEO lịch: lịch VN + timezone Tokyo cho ra
  ngày chốt sổ lệch một ngày quanh nửa đêm.

## Phạm vi

**Trong:** ô chọn lịch (từ `GET /api/calendars`) ở màn Track new Epics, mặc
định `VN_STANDARD`; cột Calendar đổi lịch trên màn Epics (PATCH sẵn có); script
data-fix `tools/db/fix-epic-calendar.sql`; `calendarWarnings` trong
`BurndownResponse` + hiển thị.

**Ngoài:** KHÔNG thêm màn hình CRUD lịch (mask, timezone vẫn là dữ liệu seed);
KHÔNG tự động resync sau khi đổi lịch (PM bấm Resync hoặc đợi job đêm — màn
hình có ghi chú).

## Đầu vào đã có

- `GET /api/calendars` (T-36); `patchEpicRequestSchema` đã nhận
  `calendarId`/`timezone` (T-10); `WorkCalendar.warnings` (T-12).

## Việc phải làm

1. Thay hằng `DEFAULT_CALENDAR_ID = 'default'` bằng `SIDE_CALENDAR_ID.VN`,
   thêm dropdown; timezone lấy theo lịch được chọn.
2. Cột Calendar trên màn Epics: select đổi `calendarId` + `timezone` một lần;
   lịch không tồn tại hiện `(unknown!)` thay vì biến mất.
3. `burndown.adapters`: sinh cảnh báo khi lịch không tồn tại HOẶC chưa khai
   ngày lễ nào; `buildChart` chép `calendar.warnings` vào
   `calendarWarnings` (schema có `default([])` cho client cũ).
4. Màn Burndown hiện từng cảnh báo dạng notice đỏ, icon 📅.
5. Script SQL idempotent trỏ Epic dùng lịch 'default'/không tồn tại về
   `VN_STANDARD` + đồng bộ timezone; KHÔNG tự xoá bản ghi 'default'.

## Quy ước bắt buộc

- **C-10** — cấu hình sai phải nói ra ngay trên màn hình người dùng đang nhìn.
- **C-6** — script data-fix chạy lại vô hại.

## Checklist đầu ra

- [x] Typecheck + test + lint xanh (`burndown.routes.test.ts` có case mới)
- [x] Cập nhật `status: review` + `finished_at`
- [x] Ghi "Đã làm gì" cuối card

## Test phải viết

1. `cảnh báo lịch (thiếu ngày lễ, lịch không tồn tại) đi kèm phản hồi — E-14 không im lặng`

## Định nghĩa "xong"

Thêm Epic mới không còn đường nào tạo ra `calendar_id` rác; Epic cũ trỏ lịch
rác được script sửa một lần; biểu đồ của Epic có lịch chưa khai ngày lễ hiện
cảnh báo đỏ nói rõ cách khắc phục.

## Cạm bẫy đã biết

- Đổi `calendarId` mà quên `timezone` là ngày chốt sổ lệch âm thầm — hai
  trường phải đi cùng nhau trong một PATCH.
- Data-fix phải upsert hai lịch chuẩn TRƯỚC khi trỏ vào (DB có thể chưa từng
  chạy seed).

## Đã làm gì

- Dropdown lịch ở Track new Epics (kèm cảnh báo ⚠ lịch chưa có ngày lễ),
  cột Calendar trên màn Epics, script `fix-epic-calendar.sql`.
- `calendarWarnings` xuyên suốt adapter → service → schema → màn Burndown.
