---
id: T-14
title: Ngày bắt đầu và kết thúc thực tế của một Sub-task
status: review
model: opus
effort: medium
depends_on: ["T-04", "T-12"]
touches:
  - packages/engine/src/rollup/subtask-actual-dates.ts
  - packages/shared/src/actual-dates.ts
prd_refs: ["§2.7.2", "E-13"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-14 · Ngày bắt đầu và kết thúc thực tế của một Sub-task

## Mục tiêu
Suy ra `actual_start` và `actual_end` của một Sub-task từ lịch sử. Jira **không có sẵn** hai trường này. T-15 (tổng hợp ngày Phase) và T-22 (trạng thái Signboard) đều dựa vào đây.

## Ngữ cảnh cần biết

**Cách tính đã chốt** (PRD §2.7.2) — worklog là nguồn ưu tiên, trạng thái là dự phòng:

| Mốc | Cách tính |
|---|---|
| `actual_start` | Ngày worklog **sớm nhất** (theo `started`). Không có worklog → lần đầu chuyển sang `In Progress` (changelog). Vẫn không có mà đã Done → lấy đúng ngày Done |
| `actual_end` | Chưa Done → **chưa tính** (`null`), không tạm tính từ worklog. Đã Done → ngày worklog **muộn nhất**; không có worklog → lần **CUỐI CÙNG** chuyển sang `Done` |

**Vì sao lấy lần Done cuối cùng** — ca mở lại (E-13), task không log giờ:

| Ngày | Sự kiện | Ghi chú |
|---|---|---|
| 09/03 | `未対応` → `対応中` | ← `actual_start` = 09/03 |
| 12/03 | `対応中` → `完了` | Lần Done thứ nhất |
| 13/03 | `完了` → `対応中` | Mở lại vì phát hiện lỗi |
| 16/03 | `対応中` → `完了` | ← `actual_end` = **16/03** |

> Nếu lấy lần Done đầu tiên (12/03) thì mất trắng 4 ngày làm lại — báo cáo sẽ sai.

**Vì sao worklog là nguồn ưu tiên:** giờ được log là việc đã thật sự làm, còn thời điểm bấm chuyển trạng thái thường trễ so với lúc làm thật. Changelog trạng thái chỉ dùng khi không có worklog nào; task Done mà không có cả hai nguồn thì lấy đúng ngày Done làm cả hai mốc.

## Phạm vi

**Trong:**
- `resolveSubtaskActualDates(sub, statusIdMap, tz)` → `{ actualStart, actualEnd, actualEndIsProvisional }`
- Đổi mốc UTC sang ngày `'YYYY-MM-DD'` theo múi giờ của Epic

**Ngoài:**
- Không tổng hợp lên Phase (T-15 làm)
- Không tính trạng thái Signboard (T-22 làm)
- Không đọc/ghi database
- Không đọc `wbs_start_date` / `wbs_end_date` — đó là ngày **kế hoạch**, không phải thực tế

## Đầu vào đã có
- `resolveStatusCategoryAt()` từ **T-04**
- `endOfDayUtcMs()` và các hàm lịch từ **T-12**
- Type `SubtaskRecord`, `ChangelogEvent`, `WorklogEntry`

## Việc phải làm

1. Type trong shared:
   ```typescript
   interface SubtaskActualDates {
     actualStart: string | null;              // 'YYYY-MM-DD'
     actualEnd: string | null;
     actualEndIsProvisional: boolean;         // true = chưa Done (khi đó actualEnd = null)
   }
   ```
2. `actual_start`:
   - Có worklog (bỏ `is_deleted`) → lấy worklog **sớm nhất** theo `startedAtMs`
   - Không có worklog → sự kiện changelog `status` **đầu tiên** có `to` thuộc nhóm `indeterminate`
   - Vẫn không có mà đã Done → lấy mốc Done cuối cùng; còn lại → `null`
3. `actual_end`:
   - Chưa từng Done → `null`, `isProvisional = true` — KHÔNG tạm tính từ worklog
   - Đã Done, có worklog → worklog **muộn nhất**, `isProvisional = false`
   - Đã Done, không có worklog → sự kiện changelog `status` **cuối cùng** có `to` thuộc nhóm `done`, `isProvisional = false`
4. Đổi mốc UTC sang ngày theo `tz` của Epic: `DateTime.fromMillis(ms, { zone: tz }).toISODate()`.
5. Hàm **thuần**, nhận `tz` qua tham số, không đọc đồng hồ.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — worklog theo `started`; đổi UTC sang ngày phải dùng luxon với `zone`, cấm cắt chuỗi ISO.
- **C-4** — nhận diện `In Progress` / `Done` qua `statusCategory`, **không** qua `status.name`.
- **C-10** — không có dữ liệu thì trả `null`, không đoán ngày.
- **C-12** — hàm thuần, engine không đọc DB, không đọc đồng hồ.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Ca mở lại — quan trọng nhất:**
1. `task không log giờ: start = lần đầu In Progress 09/03, end = lần Done cuối 16/03` — chuỗi `未対応 → 対応中 → 完了 → 対応中 → 完了`
2. `actual_end lấy lần Done CUỐI CÙNG, không lấy lần Done đầu tiên`

**Worklog là nguồn ưu tiên:**
3. `đã có worklog thì actual_start = ngày worklog SỚM NHẤT, kể cả khi chuyển In Progress sớm hơn`
4. `log giờ ngày 08/03 nhưng chuyển In Progress ngày 09/03 thì actual_start = 08/03`
5. `chỉ có worklog, chưa từng chuyển In Progress thì vẫn có actual_start`
6. `chỉ chuyển In Progress, chưa log giờ nào thì actual_start lấy từ changelog`

**Chưa Done thì không tạm tính:**
7. `Sub-task chưa Done thì actual_end = null dù đã có worklog — KHÔNG lấy tạm worklog cuối`
8. `Sub-task đã Done thì actualEndIsProvisional = false; đã Done có worklog thì actual_end = ngày worklog MUỘN NHẤT`
9. `Sub-task Done mà không có worklog lẫn In Progress thì start = end = ngày Done`

**Chưa bắt đầu:**
10. `Sub-task chưa động vào thì actual_start và actual_end đều null`

**Múi giờ:**
11. `mốc UTC 2026-03-09T17:30:00Z ra ngày 2026-03-10 theo giờ Việt Nam` — chứng minh không cắt chuỗi ISO
12. `cùng mốc UTC cho ra ngày khác nhau giữa giờ Việt Nam và giờ Nhật`

**Worklog bị xoá:**
13. `worklog đã bị xoá không được tính vào actual_start hay actual_end`

## Định nghĩa "xong"
Chạy hàm trên bảng ví dụ 5 sự kiện của PRD §2.7.2 cho ra `actual_start = 09/03` và `actual_end = 16/03`, và Sub-task chưa xong được đánh dấu tạm tính.

## Cạm bẫy đã biết
- **Lấy lần Done đầu tiên là lỗi im lặng.** Con số vẫn ra, biểu đồ vẫn vẽ, chỉ là mất mấy ngày làm lại. Test 2 tồn tại chính vì lỗi này không tự lộ.
- **Cắt chuỗi ISO để lấy ngày là sai.** `'2026-03-09T17:30:00Z'.slice(0, 10)` cho `2026-03-09`, nhưng theo giờ Việt Nam đó đã là **10/03**. Lệch một ngày ở ranh giới, và chỉ sai với worklog buổi tối — cực khó phát hiện.
- **`actual_start` phải tìm lần chuyển sang `indeterminate` ĐẦU TIÊN, `actual_end` phải tìm lần sang `done` CUỐI CÙNG.** Hai hướng duyệt ngược nhau. Dùng cùng một hướng cho cả hai là lỗi hay gặp.
- **Đừng nhầm `actual_end` với "ngày worklog cuối" khi task đã Done.** Task Done ngày 16/03 nhưng worklog cuối ngày 14/03 → `actual_end` là **16/03**, không phải 14/03.
- **Sub-task chuyển thẳng `To Do → Done` không qua `In Progress`** là chuyện có thật. Lúc đó `actual_start` phải lấy từ worklog; không có worklog thì `null` — **đừng** lấy tạm ngày Done làm ngày bắt đầu.

## Đã làm gì

**19 test xanh** (card yêu cầu 13). Bảng ví dụ 5 sự kiện của PRD §2.7.2 tái hiện đúng: `start = 09/03`, `end = 16/03`.

### Ba test thêm ngoài card

1. **`actual_start` lấy lần chuyển In Progress ĐẦU TIÊN, không phải lần cuối.** Card đã có test cho hướng duyệt của `actual_end` (lần Done *cuối*), nhưng không có test nào khoá hướng ngược lại. Chuỗi `In Progress → To Do → In Progress` sẽ lộ ngay nếu ai đó dùng cùng một hướng duyệt cho cả hai.
2. **Chuyển thẳng To Do → Done nhưng CÓ worklog.** Card có ca "không qua In Progress" nhưng chỉ ở nhánh không có worklog. Nhánh có worklog mới là ca thường gặp hơn.
3. **Mọi worklog đều bị xoá** — phải cho kết quả y hệt như không có worklog nào.

### Một chỗ dùng `null` thay vì `Math.min`

`Math.min(null, x)` trả về `0` vì `null` bị ép thành số 0 — tức ngày 1970-01-01. Nếu Sub-task chỉ có worklog mà chưa từng chuyển In Progress, cách viết đó sẽ cho `actual_start` là 1970 và biểu đồ kéo dài 56 năm. Đã tách thành `minDefined()` xử lý `null` tường minh.

### Dùng lại T-04 và T-12, không viết lại

`findFirstInProgressMs` / `findLastDoneMs` đã có sẵn ở T-04 với đúng hướng duyệt cần thiết, và `localDateOf` vừa thêm ở T-12. Card này chỉ ghép ba mảnh đó lại — nên chỗ duy nhất còn có thể sai là quy tắc *chọn nguồn nào*, và đó đúng là chỗ tôi dồn test vào.
