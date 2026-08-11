---
id: T-39
title: Ngày làm bù (make-up workday)
status: review
model: opus
effort: medium
depends_on: ["T-12", "T-36"]
touches:
  - packages/shared/src/calendar.ts
  - packages/shared/src/api-calendar.ts
  - packages/engine/src/calendar/count-workdays.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260811150000_makeup_workday
  - packages/db/src/repositories/calendar-makeup-workday.repository.ts
  - packages/db/src/repositories/calendar.repository.ts
  - apps/api/src/routes/calendars.routes.ts
  - apps/api/src/adapters/calendars.adapters.ts
  - apps/api/src/adapters/burndown.adapters.ts
  - apps/web/src/api/use-calendars.ts
  - apps/web/src/routes/config-holidays/index.tsx
prd_refs: ["§4.4", "§9.4", "E-14"]
owner: null
started_at: 2026-08-11
finished_at: 2026-08-11
---

# T-39 · Ngày làm bù (make-up workday)

## Mục tiêu

Ở VN rất phổ biến việc **làm bù**: một ngày cuối tuần (Thứ 7/CN) được xếp làm
việc để bù cho một ngày nghỉ khác — thường quanh Tết/lễ, khi công ty đổi lịch để
có kỳ nghỉ dài liền mạch. `calendar_holiday` chỉ mô tả được chiều NGƯỢC LẠI (biến
một ngày làm việc thành nghỉ), nên trước card này không có cách nào khai một ngày
cuối tuần là ngày làm việc — đường Kế hoạch đứng yên qua ngày làm bù và biểu đồ
bôi xám nó như ngày nghỉ, dù cả team đang làm.

## Yêu cầu

1. Khai ngày làm bù cho **từng lịch** ngay trong màn hình *Days off* (chung chỗ
   với ngày lễ), theo đúng khuôn import/list/delete của ngày lễ.
2. Engine tính đường Kế hoạch trên ngày làm bù **như ngày làm việc bình thường**
   (đường Kế hoạch vẫn giảm).
3. Biểu đồ Burndown **không** bôi xám ngày làm bù.

## Cách làm

- **Bảng riêng `calendar_makeup_workday`** (calendar_id, work_date, label), song
  song với `calendar_holiday` thay vì thêm cột `kind` — giữ nguyên ngữ nghĩa và
  toàn bộ logic/test ngày lễ hiện có, rủi ro hồi quy thấp.
- **`WorkCalendar.makeupWorkdays`** (optional `ReadonlySet<string>`). `isWorkday`
  xét theo thứ tự: ngày lễ → nghỉ (luôn thắng); ngày làm bù → làm; còn lại theo
  mask. Nhờ đó `listWorkdays`/`countWorkdays`/`addWorkdays` và đường Kế hoạch
  (T-16) tự động tính đúng, và `isOffDay = !workdaySet.has(date)` ở API biểu đồ
  tự động thành `false` cho ngày làm bù → tầng vẽ không bôi xám.
- **Hai chỗ dựng lịch** đều nạp make-up: `getCalendar` (worker/plan-conflicts) và
  `burndown.adapters` (đường đọc biểu đồ dựng lịch riêng bằng SQL thô).
- API: `GET/POST(import)/DELETE /api/calendars/:id/makeup-workdays` — cùng phân
  quyền (chỉ ADMIN ghi) và cùng lan truyền (xoá cache biểu đồ + đánh dấu Epic
  tính lại) như ngày lễ.

## Ngoài phạm vi

- Không có ràng buộc DB chống khai một ngày vừa là lễ vừa là làm bù; nếu lỡ trùng
  thì **ngày lễ thắng** ở `isWorkday` (có test khoá).
- Chưa cảnh báo khi khai ngày làm bù rơi vào một ngày vốn đã là ngày làm việc
  (mask) — vô hại, chỉ thừa dữ liệu.
