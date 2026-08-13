---
id: T-41
title: Cảnh báo đóng ticket trễ so với ngày làm thật (Data quality)
status: review
model: opus
effort: medium
depends_on: ["T-13", "T-14", "T-17", "T-27", "T-33", "T-40"]
touches:
  - packages/db/prisma/migrations/20260813120000_subtask_close_lag/migration.sql
  - packages/db/prisma/schema.prisma
  - packages/engine/src/rollup/subtask-actual-dates.ts
  - apps/worker/src/jobs/reconstruct-epic.job.ts
  - packages/db/src/repositories/subtask-actual-dates.repository.ts
  - packages/shared/src/api-epic-ops.ts
  - packages/shared/src/api-ops.ts
  - apps/api/src/services/epic-health.service.ts
  - apps/api/src/services/ops-health.service.ts
  - apps/api/src/adapters/ops.adapters.ts
  - packages/db/src/repositories/explain.repository.ts
  - apps/web/src/routes/ops/data-quality-csv.ts
prd_refs: ["§2.7.2", "§4.3.2", "§10.4"]
owner: null
started_at: 2026-08-13
finished_at: 2026-08-13
---

# T-41 · Cảnh báo đóng ticket trễ so với ngày làm thật (Data quality)

## Mục tiêu
Cho PM thấy — ở màn hình Giám sát, khu **Data quality** — những Sub-task **đóng
trễ** so với worklog cuối (từ `CLOSE_LAG_MIN_WORKDAYS` ngày làm việc trở lên). Đây
là tín hiệu **thói quen**: đường Thực tế đã được Quy tắc 1b (T-13) sửa đúng, nhưng
việc bấm đóng trễ vẫn nên chỉnh về quy trình.

## Ngữ cảnh cần biết

**Quan hệ với Quy tắc 1b (T-13):** 1b đã dùng đúng con số này (số ngày làm việc
giữa worklog cuối và lúc bấm đóng) để backdate đường Thực tế cho ca đóng-trễ-có-
worklog. T-41 **lưu lại** con số đó per Sub-task để cảnh báo — chart đúng rồi,
nhưng "đội đóng ticket trễ bao lâu" vẫn là thứ PM cần thấy.

**Quan hệ với T-40 (`CLOSED_NO_WORKLOG`):** hai cảnh báo bù nhau đúng phần của
nhau. T-40 bắt task đóng mà **không có** worklog (1b không cứu được). T-41 bắt
task đóng trễ mà **có** worklog. Cùng nhau phủ trọn "close hygiene".

**Vì sao tính trong engine, không tính bằng SQL:** đếm ngày LÀM VIỆC cần lịch
(mask cuối tuần + ngày lễ + ngày làm bù) — không làm được bằng SQL thuần (quy ước
đã có ở `subtask_actual_dates`). Engine tính sẵn `close_lag_workdays` lúc dựng lại
lịch sử, lưu xuống, màn hình chỉ so cột.

## Phạm vi

**Trong:**
- `resolveCloseLagWorkdays(sub, statusIdMap, calendar)` — số ngày làm việc SAU
  worklog cuối tới ngày đóng (lần Done cuối). `null` nếu hiện không Done, không
  worklog, hoặc đang mở lại.
- Cột `subtask_actual_dates.close_lag_workdays`, ghi ở job dựng lại (T-17/T-18).
- Số đo `closeLagRatio` + loại lỗi `CLOSE_LAG` ở Data quality (toàn cục + per-Epic),
  tái dùng khung `HEALTH_THRESHOLD`/`DATA_METRICS`/`dq_exempt` như T-40.

**Ngoài:**
- KHÔNG đổi ngữ nghĩa engine (Quy tắc 1b đã làm ở T-13).
- KHÔNG đo bằng ngày lịch (weekend làm sai lệch) — bắt buộc ngày làm việc.
- KHÔNG thêm push-alert của T-27.

## Đầu vào đã có
- `countWorkdays` / `isWorkday` — T-12, `packages/engine/src/calendar/count-workdays.ts`.
- `currentStatusCategory` / `findLastDoneMs` / `localDateOf` — T-04/T-12.
- Job dựng lại đã có `calendar` + `statusIdMap` tại chỗ tính actual-dates (T-18).
- Khung Data quality (số đo + cờ per-ticket + exempt) — T-33 / T-40.

## Việc phải làm
1. Migration + schema: `subtask_actual_dates.close_lag_workdays INTEGER NULL`.
2. Engine `resolveCloseLagWorkdays`: chỉ tính khi HIỆN Done và CÓ worklog;
   `lag = max(0, countWorkdays(LW, D) − (isWorkday(LW) ? 1 : 0))` với `LW` = ngày
   worklog cuối, `D` = ngày Done cuối. Trừ 1 vì `countWorkdays` bao gồm cả hai đầu.
3. Job dựng lại: `closeLagWorkdays: resolveCloseLagWorkdays(s, statusIdMap, calendar)`
   thêm vào mỗi dòng `saveSubtaskActualDates`.
4. `CLOSE_LAG_MIN_WORKDAYS = 2` (shared), nội suy vào 4 query SQL (3 ở `ops.adapters`
   + 1 ở `loadHealthRatios`); cờ = `close_lag_workdays >= 2`.
5. `closeLagRatio` vào `HEALTH_THRESHOLD` (compiler kéo theo `MESSAGE`,
   `RawDataQualityRatios`, `loadHealthRatios`), `CLOSE_LAG` vào `DQ_PROBLEMS` +
   `PROBLEM_LABEL`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):
- **C-1** — worklog theo `started`; đổi UTC sang ngày phải dùng luxon với `zone`.
- **C-4** — nhận diện Done qua `statusCategory`, không qua tên.
- **C-10** — không đoán khi thiếu dữ liệu: không worklog → `null` (để T-40 lo).
- **C-11** — worklog `is_deleted` không tính là "có log".
- **C-12** — engine thuần, nhận `calendar` qua tham số, không đọc đồng hồ.

## Checklist đầu ra
- [x] `pnpm typecheck` xanh
- [x] `pnpm lint` xanh
- [x] `pnpm test` xanh (1232 test)
- [x] SQL validate end-to-end trên PostgreSQL thật với các ca biên
- [x] `status: review` + `finished_at`

## Test phải viết
Engine (`subtask-actual-dates.test.ts`):
1. `log cuối Thứ 2, đóng Thứ 4 → 2 ngày làm việc`
2. `cuối tuần KHÔNG tính: log Thứ 6, đóng Thứ 2 → 1`
3. `đóng trong ngày làm thật cuối → 0`
4. `ngày lễ giữa chừng KHÔNG tính`
5. `hiện không Done (mở lại) → null`
6. `không worklog → null`; `worklog đã xoá → null`
7. `mở lại rồi Done lại: lấy worklog cuối và lần Done CUỐI`

Service (`ops-health.service.test.ts`): `closeLag 10% → WARN, 30% → CRITICAL`.

Ca ngữ nghĩa SQL (validate trên DB thật, không unit-test được): `>= 2 gắn cờ, 1
không`; `NULL không gắn cờ`; `exempt loại khỏi số đo nhưng còn trong danh sách`.

## Định nghĩa "xong"
Một Sub-task đóng cách worklog cuối 2 ngày làm việc (bỏ cuối tuần/lễ) hiện ở Data
quality với nhãn "Closed late after last work"; log bù/đóng đúng ngày rồi resync
thì cờ tự tắt.

## Cạm bẫy đã biết
- **Phải đo NGÀY LÀM VIỆC, không phải ngày lịch.** Log Thứ 6, đóng Thứ 2 chỉ trễ
  1 ngày làm việc; đo ngày lịch ra 3 và báo động giả. Đây là lý do phải tính trong
  engine (có lịch) rồi lưu, không tính bằng SQL.
- **`countWorkdays` bao gồm cả hai đầu** — phải trừ đi chính ngày worklog cuối
  (nếu nó là ngày làm việc), nếu không lag bị lệch +1.
- **Chỉ tính khi HIỆN Done.** Task đang mở lại không phải "đóng trễ" mà là đang
  làm — trả `null`, đừng tính lag tới lần Done non trước đó.
- **`close_lag_workdays` chỉ đúng sau khi dựng lại lịch sử.** Bật cảnh báo cho Epic
  đã theo dõi cần một lượt resync để cột được ghi (giống mọi giá trị engine-tính).

## Đã làm gì

Thêm số đo Data quality thứ sáu `closeLagRatio` + loại lỗi `CLOSE_LAG`. Con số
close-lag chính là thứ Quy tắc 1b (T-13) đã tính để backdate — ở đây lưu lại per
Sub-task (`subtask_actual_dates.close_lag_workdays`, engine tính lúc dựng lại lịch
sử) để cảnh báo thói quen đóng trễ, dù chart đã đúng.

8 test engine cho `resolveCloseLagWorkdays` (khớp tính tay: cuối tuần/lễ bị loại,
mở lại lấy lần Done cuối). SQL 4 query (3 đếm + 1 danh sách) validate trên
PostgreSQL thật với ca `>= 2`, biên `= 2`, `NULL`, và `exempt`. Toàn bộ 1232 test
xanh. Ngưỡng `CLOSE_LAG_MIN_WORKDAYS = 2`: đóng trong ngày (0) hay ngày làm việc
kế tiếp (1) là bình thường, từ 2 mới tính.
