---
id: T-15
title: Tổng hợp ngày Phase từ Sub-task và ghi lịch sử dịch chuyển kế hoạch
status: review
model: opus
effort: high
depends_on: ["T-05", "T-12", "T-14"]
touches:
  - packages/engine/src/rollup/compute-phase-rollups.ts
  - packages/engine/src/rollup/detect-plan-shift.ts
  - packages/engine/src/rollup/index.ts
  - packages/db/src/repositories/phase-rollup.repository.ts
  - packages/db/src/repositories/plan-shift.repository.ts
  - packages/shared/src/phase-rollup.ts
prd_refs: ["§2.7.1", "§2.7.3", "E-15", "E-24", "E-30", "R-11"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-15 · Tổng hợp ngày Phase từ Sub-task và ghi lịch sử dịch chuyển kế hoạch

## Mục tiêu
Tính `plan_start`, `plan_end`, `actual_start`, `actual_end` cho từng Phase bằng cách tổng hợp từ Sub-task. Không có card này thì T-16 không vẽ được đường Kế hoạch.

## Ngữ cảnh cần biết

**Bốn công thức** (PRD §2.7.1):

```
Phase.plan_start   = MIN( wbs_start_date của các Sub-task )
Phase.plan_end     = MAX( wbs_end_date   của các Sub-task )
Phase.actual_start = MIN( actual_start của các Sub-task )
Phase.actual_end   = MAX( actual_end   của các Sub-task )
```

Chỉ tính trên Sub-task **đang hoạt động** — đã tạo và chưa bị gỡ khỏi Epic.

**Ví dụ số** — Phase "Thiết kế" có 3 Sub-task:

| Sub-task | `wbs_start_date` | `wbs_end_date` | actual_start | actual_end |
|---|---|---|---|---|
| PAY-111 | 02/03 | 04/03 | 03/03 | 05/03 |
| PAY-112 | 03/03 | 06/03 | 03/03 | 09/03 |
| PAY-113 | 02/03 | 05/03 | 04/03 | (chưa xong) |

→ `plan_start` = **02/03**, `plan_end` = **06/03**, `actual_start` = **03/03**, `actual_end` = **09/03** *(tạm tính)*

**Ngày Phase tổng hợp lại LIÊN TỤC, không đóng băng.** Hệ thống này không dùng baseline. Thêm một Sub-task có `wbs_end_date` muộn hơn sẽ đẩy `plan_end` ra xa và làm đường Kế hoạch dịch chuyển.

**Đó là lý do `plan_shift_history` tồn tại** — tuyến phòng thủ chính cho rủi ro **R-11**:

> Vì kế hoạch tự trôi nên độ trễ bị "hấp thụ" âm thầm — nhìn biểu đồ vẫn thấy bình thường. Mỗi lần `plan_end` bị đẩy lùi phải ghi một dòng lịch sử.

**Thiếu ngày thì không đoán bừa** (PRD §2.7.3, E-30) — Sub-task thiếu `wbs_*` bị bỏ qua khi tính MIN/MAX và cộng vào `missing_date_count`. Cả Phase thiếu hết → `plan_start`/`plan_end` = `null`, **không vẽ** đường Kế hoạch.

## Phạm vi

**Trong:**
- `computePhaseRollups(subtasks, calendar)` — hàm thuần, tính 4 mốc + `plan_workdays` + `total_original_s` + `subtask_count` + `missing_date_count`
- `detectPlanShift(oldRollup, newRollup, causedByKeys)` — so với lần trước, sinh bản ghi `plan_shift_history` khi mốc bị dịch
- Repository UPSERT `phase_rollup` và INSERT `plan_shift_history`

**Ngoài:**
- Không tính đường Kế hoạch (T-16 làm)
- Không dựng snapshot (T-17 làm)
- Không hiển thị lịch sử dịch chuyển (card GĐ 4)
- Engine không đọc DB

## Đầu vào đã có
- `readWbsDates()` từ **T-05**
- `countWorkdays()` từ **T-12**
- `resolveSubtaskActualDates()` từ **T-14**
- Bảng `phase_rollup`, `plan_shift_history` từ **T-02**

## Việc phải làm

1. `computePhaseRollups(subtasks, calendar)`:
   - Nhóm Sub-task theo `phase_code` (**lấy từ Task cha**, không lấy từ tiêu đề Sub-task)
   - Lọc `removed_at IS NULL`
   - `plan_start` = MIN các `wbs_start_date` **không null**; không có cái nào → `null`
   - `plan_end` = MAX các `wbs_end_date` **không null**
   - `actual_start` / `actual_end` = MIN/MAX từ T-14; `actualEndIsProvisional` = true nếu **bất kỳ** Sub-task nào chưa Done
   - `plan_workdays` = `countWorkdays(plan_start, plan_end, calendar)`; thiếu mốc → `null`
   - `missing_date_count` = số Sub-task thiếu `wbs_start_date` **hoặc** `wbs_end_date`
2. Ca `plan_start > plan_end` (dữ liệu Jira sai): cảnh báo `INVALID_PHASE_PERIOD`, dùng `plan_start` cho cả hai (Phase 1 ngày).
3. `detectPlanShift(old, next, causedBy)`:
   - `plan_end` mới muộn hơn cũ → bản ghi `END_MOVED`, `shifted_workdays` = `countWorkdays(cũ, mới)` (số dương)
   - `plan_end` sớm lên → cũng ghi, `shifted_workdays` **âm**
   - `plan_start` đổi → `START_MOVED`
   - `causedByKeys` = các Sub-task có `wbs_end_date` bằng đúng mốc mới
   - Lần đầu tính (chưa có bản cũ) → **không sinh** bản ghi nào
4. Repository: UPSERT `phase_rollup` theo `(epic_key, phase_code)`; INSERT `plan_shift_history`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — ngày thuần là chuỗi `'YYYY-MM-DD'`; so sánh bằng chuỗi được vì định dạng ISO sắp xếp đúng thứ tự.
- **C-2** — `total_original_s` là **giây**.
- **C-6** — UPSERT theo `(epic_key, phase_code)`.
- **C-9** — mã cảnh báo `INVALID_PHASE_PERIOD`.
- **C-10** — thiếu ngày thì `null`, **không đoán bừa**. Cả Phase thiếu hết → không vẽ đường Kế hoạch.
- **C-11** — Sub-task `UNPARSED` **vẫn được cộng** vào `total_original_s` và `subtask_count`.
- **C-12** — `computePhaseRollups` và `detectPlanShift` là hàm thuần.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] `pnpm test -- packages/db` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Công thức tổng hợp:**
1. `tái hiện đúng ví dụ 3 Sub-task của PRD §2.7.1` — ra 02/03, 06/03, 03/03, 09/03
2. `actualEndIsProvisional = true khi còn ít nhất một Sub-task chưa Done`
3. `actualEndIsProvisional = false khi mọi Sub-task đã Done`
4. `Sub-task đã bị gỡ khỏi Epic không tham gia tính MIN/MAX`

**Thiếu ngày:**
5. `Sub-task thiếu wbs_start_date bị bỏ qua khi tính MIN nhưng vẫn đếm vào missing_date_count`
6. `toàn bộ Sub-task thiếu ngày thì plan_start và plan_end đều null, plan_workdays null`
7. `Sub-task UNPARSED vẫn được cộng vào total_original_s và subtask_count`

**Dữ liệu sai:**
8. `plan_start muộn hơn plan_end thì cảnh báo INVALID_PHASE_PERIOD và Phase thành 1 ngày`

**Lịch sử dịch chuyển — tuyến phòng thủ R-11:**
9. `thêm Sub-task có wbs_end_date muộn hơn thì sinh 1 bản ghi END_MOVED với shifted_workdays đúng`
10. `bản ghi END_MOVED ghi đúng caused_by_keys là Sub-task gây ra thay đổi`
11. `plan_end kéo sớm lên thì shifted_workdays là số ÂM`
12. `plan_start đổi thì sinh bản ghi START_MOVED`
13. `lần tính đầu tiên (chưa có bản cũ) KHÔNG sinh bản ghi dịch chuyển nào`
14. `plan_end không đổi thì không sinh bản ghi nào`

**Số ngày làm việc:**
15. `plan_workdays loại đúng cuối tuần và ngày lễ`

## Định nghĩa "xong"
Cho 3 Sub-task của ví dụ PRD §2.7.1, hàm trả đúng 4 mốc; và thêm một Sub-task có ngày muộn hơn thì sinh đúng một bản ghi `plan_shift_history` với số ngày dịch chuyển chính xác.

## Cạm bẫy đã biết
- **Bỏ qua `plan_shift_history` là bỏ mất tuyến phòng thủ duy nhất cho R-11.** Không có nó thì kế hoạch trôi âm thầm và không ai phát hiện dự án đang trễ — đúng thứ mà cả hệ thống này sinh ra để chống.
- **`MIN` trên tập rỗng.** `Math.min()` không tham số trả `Infinity`, không phải `null`. Lọc `null` trước rồi kiểm tra mảng rỗng.
- **Nhóm Sub-task theo `phase_code` của Task cha**, không theo `sb_phase_raw` trong tiêu đề. Đây là quyết định đã chốt ở PRD §2.9.2.
- **`actualEndIsProvisional` là "bất kỳ Sub-task nào chưa Done", không phải "Sub-task có actual_end muộn nhất chưa Done".** Nhầm chỗ này cho ra `provisional = false` sai khi Sub-task xong sớm nhưng còn cái khác đang dở.
- **Sub-task chuyển sang Phase khác thì phải tính lại CẢ HAI Phase** (E-24). Card này chỉ cung cấp hàm; T-18 chịu trách nhiệm gọi cho đúng cả hai. Ghi rõ điều đó trong tài liệu hàm.
- **So sánh ngày bằng chuỗi chỉ đúng với định dạng `'YYYY-MM-DD'`.** Nếu có chỗ nào lỡ đưa vào `'2026-3-9'` thì so sánh sai im lặng. Validate định dạng ở biên.

## Đã làm gì

**28 test xanh** (card yêu cầu 15). Ví dụ 3 Sub-task của PRD §2.7.1 ra đúng 4 mốc: `02/03 → 06/03`, `03/03 → 09/03` *(tạm tính)*.

### Quyết định quan trọng nhất: đếm dịch chuyển theo ngày LÀM VIỆC

Card ghi `shifted_workdays = countWorkdays(cũ, mới)` nhưng không nói rõ vì sao. Khi làm mới thấy nó quyết định cả ngưỡng cảnh báo R-11: lùi từ **thứ Sáu sang thứ Hai** là **1 ngày làm việc**, không phải 3 ngày lịch. Đếm theo ngày lịch sẽ thổi phồng mọi lần dịch qua cuối tuần, và ngưỡng 20% sẽ kêu sai liên tục cho tới lúc không ai đọc nữa. Có test riêng cho đúng ca này.

### `summarizePlanShifts` chỉ cộng phần LÙI RA XA

Không để lần kéo sớm bù trừ cho lần lùi. Một Phase lùi 10 ngày rồi **cắt bớt phạm vi** cho sớm lại 10 ngày sẽ hiện "không dịch chuyển gì" — trong khi thực tế kế hoạch đã đổi hai lần và độ trễ được giấu đi bằng cách cắt việc. Đó đúng là kiểu che giấu mà R-11 sinh ra để bắt.

### Hai thứ thêm ngoài card

- **`deleteObsoleteRollups`** — Sub-task cuối cùng chuyển sang Phase khác thì Phase cũ phải biến mất khỏi biểu đồ. Không xoá thì nó ở lại như một Phase rỗng với số liệu cũ đông cứng (E-24). Card chỉ nói "tính lại cả hai Phase", không nói ca Phase rỗng hẳn.
- **`planShiftLevel()`** — ngưỡng `OK` / `WARN` / `CRITICAL` theo R-11, để T-24 và T-27 dùng chung một chỗ thay vì mỗi nơi tự đặt lại con số 20%.

### Một chỗ va vào ràng buộc schema

`plan_shift_history.from_date` / `to_date` là cột **NOT NULL**, nhưng có một ca thật: Phase chuyển từ "mọi Sub-task đều thiếu `wbs_*`" sang "đã có ngày". Engine vẫn phát ra bản ghi đó (nó là sự kiện thật), còn repository lọc ra và **trả về `skippedNullBoundary`** để chỗ gọi ghi log — thay vì bỏ qua im lặng.

Lý do không đổi schema: đó là kế hoạch vừa **xuất hiện**, không phải bị **dịch chuyển**. Ghi vào bảng "lịch sử dịch chuyển" với `shiftedWorkdays = 0` sẽ làm nhiễu đúng cái bảng dùng để đối chứng.

### Một cạm bẫy của card được kiểm chứng riêng

*"KHÔNG đảo ngầm hai mốc."* Dữ liệu Jira sai (`plan_start` muộn hơn `plan_end`) rất dễ bị "sửa hộ" bằng cách hoán đổi — kết quả là một Phase 5 ngày trông hoàn toàn hợp lý, và **không ai đi sửa dữ liệu gốc trên Jira nữa**. Đã chọn: co Phase về 1 ngày + cảnh báo `INVALID_PHASE_PERIOD`, và có test khẳng định `planWorkdays` **không** bằng 4.
