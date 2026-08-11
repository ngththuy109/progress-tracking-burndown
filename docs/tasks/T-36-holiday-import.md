---
id: T-36
title: Import ngày nghỉ cho hai lịch làm việc (VN / JP)
status: review
model: opus
effort: medium
depends_on: ["T-02", "T-12", "T-23", "T-24"]
touches:
  - packages/shared/src/api-calendar.ts
  - packages/db/src/repositories/calendar-holiday.repository.ts
  - apps/api/src/routes/calendars.routes.ts
  - apps/api/src/adapters/calendars.adapters.ts
  - apps/web/src/routes/config-holidays/**
  - apps/web/src/api/use-calendars.ts
  - apps/worker/src/wire.ts
prd_refs: ["§4.4", "§9.4", "E-14", "Phụ lục C (bổ sung 2026-08)"]
owner: null
started_at: 2026-08-11
finished_at: 2026-08-11
---

# T-36 · Import ngày nghỉ cho hai lịch làm việc (VN / JP)

## Mục tiêu

Đây là "card vận hành" mà T-02 và T-12 còn nợ: hai card đó tạo bảng
`calendar_holiday` và đọc nó, nhưng **không có đường nào nạp dữ liệu vào**.
Hệ quả là danh sách ngày lễ luôn rỗng và đường Kế hoạch cháy đều qua cả tuần
nghỉ Tết (E-14) — PM nhìn biểu đồ tưởng team đang chậm nghiêm trọng.

Sau card này, admin import được ngày nghỉ hằng năm cho **cả hai phía** — lịch
VN (người làm) và lịch JP (khách hàng review) — qua màn hình, không cần dev.

## Ngữ cảnh cần biết

- Engine đã loại thứ 7/CN + ngày lễ khi đếm ngày làm việc từ T-12
  (`countWorkdays`, bitmask T2–T6, `holidays: Set<string>`). Card này KHÔNG
  sửa engine — chỉ nạp dữ liệu cho nó.
- Ngày lễ là NGÀY DƯƠNG LỊCH thuần (`'YYYY-MM-DD'`), không phải một khoảnh
  khắc. Cột `DATE` qua Prisma trả mốc nửa đêm UTC — cắt lấy 10 ký tự đầu,
  tuyệt đối không đổi múi giờ (T-12 đã ghi rõ cạm bẫy này).
- Đường Kế hoạch là "floating" — vẽ lại toàn bộ sau mỗi lần sync — nên sau khi
  import chỉ cần tính lại là mọi điểm (kể cả quá khứ) tự đúng. Không cần
  migrate snapshot.

## Phạm vi

**Trong:**
- Nhóm API `/api/calendars`: danh sách lịch, xem ngày lễ theo năm, import
  (MERGE / REPLACE_YEAR), xoá một ngày. Ghi: chỉ ADMIN.
- Lan truyền sau khi sửa: xoá cache biểu đồ của Epic dùng lịch, đánh dấu
  `dirty:epics` cho Epic ACTIVE để worker tự tính lại.
- Worker đọc lại lịch ở đầu mỗi job (bỏ cache RAM vô thời hạn).
- Màn hình "Days off": tab theo lịch, chọn năm, bảng ngày lễ, import bằng dán
  danh sách / nạp CSV có xem trước lỗi từng dòng.

**Ngoài:**
- KHÔNG sửa công thức đường Kế hoạch, không thêm lịch thứ ba, không sửa mask
  ngày làm việc qua UI (vẫn là dữ liệu seed).
- KHÔNG seed sẵn danh sách ngày lễ quốc gia — danh sách đổi theo năm và cần
  người thật xác nhận (lễ bù, nghỉ liền kề).

## Đầu vào đã có

- Bảng `work_calendar` + `calendar_holiday` (T-02), seed `VN_STANDARD` /
  `JP_STANDARD` (`packages/db/src/seed/work-calendar.seed.ts`).
- `getCalendar` + `CalendarCache` (`packages/db/src/repositories/calendar.repository.ts`).
- Hàng đợi `dirty:epics` (`createDirtyEpicQueue`) và job quét của worker.
- `ChartCache.invalidateEpic` (`apps/api/src/adapters/chart-cache.js`).

## Việc phải làm

1. `packages/shared/src/api-calendar.ts` — schema zod: `calendarSummary`,
   `holiday`, `importHolidaysRequest` (tối đa 500 dòng; REPLACE_YEAR bắt buộc
   `year` và mọi ngày nằm trong năm đó), các schema phản hồi.
2. Repository `calendar-holiday.repository.ts`: import trong MỘT transaction
   (xoá-rồi-chèn ≙ upsert), khử trùng lặp input (dòng sau thắng), đếm
   inserted/updated/deleted; list theo năm; xoá một ngày; `epicKeysUsingCalendar`.
3. Route + adapter: quyền ADMIN cho ghi; lỗi schema trả TỪNG DÒNG và không ghi
   gì; sau ghi thành công gọi `invalidateChart` cho mọi Epic dùng lịch và
   `dirty.add` cho Epic ACTIVE.
4. Worker: `loadEpicContext` invalidate entry lịch trước khi `getCalendar` —
   mỗi job đọc lịch mới, trong job vẫn dùng chung.
5. Màn hình web + hook TanStack Query; sau mutate làm mới cả cache client của
   burndown và plan-conflicts.

## Quy ước bắt buộc

- **C-6** — idempotent: import chạy lại cùng danh sách không nhân đôi.
- **C-10** — không đoán bừa, không im lặng: dòng sai chặn cả lần import và nói
  rõ dòng nào; năm chưa có ngày lễ hiện cảnh báo đỏ ngay trên màn hình.
- **C-1** — ngày thuần dùng `DATE`/chuỗi `YYYY-MM-DD`, không đổi múi giờ.
- Mỗi card một file trong `packages/shared`, thêm đúng một dòng export.

## Checklist đầu ra

- [x] Typecheck: `pnpm typecheck` xanh
- [x] Test API: `pnpm test` xanh (calendars.routes.test.ts, calendar-holiday.repository.test.ts, parse-holiday-lines.test.ts)
- [x] Không đụng file ngoài `touches` (trừ điểm lắp ráp `server.ts`, nav/routes web)
- [x] Cập nhật `status: review` + `finished_at`
- [x] Ghi "Đã làm gì" cuối card

## Test phải viết

1. `PM/VIEWER không import được — 403, store không bị gọi`
2. `dòng sai trả lỗi từng dòng và không ghi gì cả`
3. `REPLACE_YEAR thiếu năm hoặc lẫn ngày năm khác đều bị chặn`
4. `import hợp lệ lan truyền: xoá cache chart mọi Epic dùng lịch, dirty Epic ACTIVE`
5. `xoá ngày không tồn tại là no-op, không lan truyền`
6. `MERGE đếm riêng ngày mới/ghi đè; ngày trùng trong input dòng sau thắng`
7. `REPLACE_YEAR đếm đúng ngày bị xoá thật`
8. `ngày ghi vào DB giữ nguyên ngày dương lịch (mốc nửa đêm UTC)`
9. `parse dán từ Excel: phẩy/chấm phẩy/tab; dòng sai không chặn dòng đúng; bắt 2026-02-30`

## Định nghĩa "xong"

Admin dán danh sách ngày lễ 2026 cho lịch VN và lịch JP trên màn hình Days
off; sau lần sync kế tiếp, đường Kế hoạch của Epic dùng lịch đó đi ngang qua
các ngày lễ vừa nhập.

## Cạm bẫy đã biết

- **Cache là lỗi im lặng số một của card này.** Ba tầng phải làm mới: cache
  biểu đồ Redis (server), cache lịch RAM của worker (process khác — không gọi
  invalidate trực tiếp được, nên worker phải tự đọc lại mỗi job), và cache
  TanStack Query phía client. Sót tầng nào thì import xong màn hình vẫn hiện
  số cũ — trông y hệt "chức năng hỏng".
- **Đổi múi giờ ngày lễ** làm 17/02 lùi thành 16/02 ở mọi múi giờ phía đông —
  T-12 đã ghi, nhắc lại vì code mới rất dễ "sửa cho đúng".
- `createMany` không update — muốn đổi nhãn ngày đã có phải xoá-rồi-chèn trong
  cùng transaction.

## Đã làm gì

- Nhóm API `/api/calendars` (4 endpoint) + adapter Prisma + schema zod chung.
- Repository import transaction với hai chế độ, đếm inserted/updated/deleted.
- Lan truyền: ChartCache.invalidateEpic + dirty:epics sau import/xoá; worker
  invalidate lịch đầu mỗi job trong `loadEpicContext`.
- Màn hình Days off (tab lịch, năm, bảng, import dán/CSV có preview) + hook.
- 22 test mới phủ quyền, kiểm dữ liệu, lan truyền, transaction, parser.
