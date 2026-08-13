---
id: T-16
title: Đường Kế hoạch — tính từ dữ liệu hiện tại, không dùng baseline
status: review
model: opus
effort: medium
depends_on: ["T-12", "T-15"]
touches:
  - packages/engine/src/planned/compute-planned-remaining.ts
  - packages/engine/src/planned/index.ts
prd_refs: ["§4.3", "§4.3.1", "E-01", "R-11"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-16 · Đường Kế hoạch — tính từ dữ liệu hiện tại, không dùng baseline

> **Cập nhật 2026-08-13 — đã đổi thuật toán.** Đường Kế hoạch nay tính **ramp theo TỪNG Sub-task**: mỗi Sub-task rải đều khối lượng của chính nó trên cửa sổ `wbs_start_date → wbs_end_date` của riêng nó, rồi cộng dồn — thay cho rải đều theo Phase mô tả bên dưới. Sub-task thiếu một trong hai ngày thành **mức sàn** (không bao giờ bị trừ). `PhaseRollup` mang thêm `plannedItems` (lịch ramp per-Sub-task), lưu ở cột `phase_rollup.planned_items`; `computePlannedRemaining` giữ nguyên chữ ký nên worker và API không phải đổi. Xem PRD §4.3.1 (đã cập nhật). Phần mô tả bên dưới **giữ lại làm bối cảnh lịch sử** của bản T-16 gốc.

## Mục tiêu
Tính "nếu làm đúng kế hoạch thì cuối ngày X còn lại bao nhiêu giờ" cho mọi ngày trong dải. Đây là đường thứ hai của biểu đồ Burndown.

## Ngữ cảnh cần biết

**Công thức** (PRD §4.3.1):

$$
PlannedRemaining(T_d) = TotalScope(now) - \sum_{i \in Phases} \min\left( \frac{OriginalEstimate_i(now)}{PlannedWorkdays_i(now)} \times DaysElapsed_i(T_d),\ OriginalEstimate_i(now) \right)
$$

Ký hiệu `(now)` nhấn mạnh: các giá trị này lấy tại **thời điểm chạy job**, không phải tại `T_d`.

**Hệ quả bắt buộc phải hiểu** (PRD §4.3):

| | Đường Kế hoạch | Đường Thực tế |
|---|---|---|
| Sau mỗi lần đồng bộ | **Vẽ lại TOÀN BỘ**, kể cả lịch sử | Giữ nguyên lịch sử |
| Điểm ngày 05/03 hôm nay so với hôm qua | **Có thể khác** | Giống nhau |
| Thêm Sub-task có ngày muộn hơn | Dịch sang phải | Không ảnh hưởng |

> Hệ thống này **không dùng baseline**. Đây là quyết định đã chốt, hệ quả theo dõi ở **R-11**. Đừng "sửa" nó thành đóng băng.

**Ví dụ số** (PRD §4.3.1) — Epic 200 giờ, 3 Phase:

| Phase | Ước lượng | Bắt đầu | Kết thúc | Ngày làm việc | Tốc độ |
|---|---|---|---|---|---|
| Design | 40h | 02/03 | 06/03 | 5 | 8 h/ngày |
| Development | 120h | 09/03 | 27/03 | 15 | 8 h/ngày |
| Testing | 40h | 23/03 | 27/03 | 5 | 8 h/ngày |

Tại hết ngày **10/03**:

| Phase | Ngày đã qua | Phần đáng lẽ đã cháy |
|---|---|---|
| Design | 5 (đã xong) | `min(8 × 5, 40)` = **40h** |
| Development | 2 | `min(8 × 2, 120)` = **16h** |
| Testing | 0 (chưa bắt đầu) | **0h** |
| | **Tổng** | **56h** |

→ `PlannedRemaining(10/03)` = 200 − 56 = **144 giờ**

**Phase thiếu ngày kế hoạch thì BỎ QUA**, không đoán bừa (PRD §2.7.3).

## Phạm vi

**Trong:**
- `computePlannedRemaining(phaseRollups, totalScopeSeconds, dateStr, calendar)`
- Hàm `min` chặn một Phase "cháy" quá khối lượng của chính nó
- Bỏ qua Phase có `planStart` hoặc `planEnd` bằng `null`
- Kẹp `max(0, ...)` ở kết quả cuối

**Ngoài:**
- Không tính đường Thực tế (T-13 làm)
- Không dựng snapshot (T-17 làm)
- Không tính `TotalScope` — nhận qua tham số
- Không đọc DB, không đọc đồng hồ

## Đầu vào đã có
- `PhaseRollup` từ **T-15** (đã có `planStart`, `planEnd`, `planWorkdays`, `totalOriginalSeconds`)
- `countWorkdays()` từ **T-12**

## Việc phải làm

1. Cài đúng hàm trong PRD §4.4:
   ```typescript
   function computePlannedRemaining(
     phaseRollups: readonly PhaseRollup[],
     totalScopeSeconds: number,
     dateStr: string,
     calendar: WorkCalendar,
   ): number {
     let burned = 0;

     for (const phase of phaseRollups) {
       // Phase chưa có ngày kế hoạch → KHÔNG đoán bừa, bỏ qua
       if (!phase.planStart || !phase.planEnd) continue;

       const elapsed = countWorkdays(phase.planStart, dateStr, calendar);
       if (elapsed <= 0) continue;                    // Phase chưa bắt đầu

       const perDay = phase.totalOriginalSeconds / phase.planWorkdays;
       burned += Math.min(perDay * elapsed, phase.totalOriginalSeconds);
     }

     return Math.max(0, totalScopeSeconds - burned);
   }
   ```
2. `planWorkdays = 0` → bỏ qua Phase đó (tránh chia cho 0), ghi cảnh báo.
3. Giữ phép tính ở kiểu `number` (giây). Làm tròn **chỉ ở tầng API/UI**.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — `dateStr` là `'YYYY-MM-DD'`; không đọc đồng hồ.
- **C-2** — mọi giá trị là **giây**; không đổi sang giờ trong engine.
- **C-10** — Phase thiếu ngày thì bỏ qua, **không đoán bừa**.
- **C-12** — hàm thuần; `pnpm test:engine` < 10 giây.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Ví dụ trong PRD:**
1. `tái hiện đúng ví dụ PRD §4.3.1: ngày 10/03 ra 144 giờ`
2. `ngày đầu tiên của Epic bằng đúng TotalScope`
3. `ngày cuối cùng của mọi Phase bằng 0`

**Hàm min chặn cháy quá:**
4. `Phase đã kết thúc không cháy quá khối lượng của chính nó` — Design 40h, hỏi ngày 20/03 vẫn chỉ cháy 40h
5. `Phase chưa tới ngày bắt đầu thì cháy 0`

**Thiếu dữ liệu:**
6. `Phase có planStart null bị bỏ qua, KHÔNG làm hỏng phép tính các Phase khác`
7. `Phase có planWorkdays = 0 bị bỏ qua và ghi cảnh báo, không sinh Infinity`
8. `mọi Phase đều thiếu ngày thì kết quả bằng đúng TotalScope cho mọi ngày`

**Biên:**
9. `kết quả không bao giờ âm` — tổng ước lượng các Phase lớn hơn TotalScope vẫn trả ≥ 0
10. `ngày lễ và cuối tuần không làm cháy thêm giờ nào`

**Đường Kế hoạch trôi — hành vi mong muốn:**
11. `thêm Sub-task làm plan_end muộn hơn thì đường Kế hoạch của các ngày CŨ cũng đổi` — khẳng định đây là hành vi đúng, không phải bug
12. `hàm cho cùng kết quả khi gọi lại với cùng đầu vào` — thuần, không phụ thuộc thời điểm gọi

## Định nghĩa "xong"
Chạy hàm trên ví dụ 3 Phase của PRD §4.3.1 cho ra đúng 144 giờ tại ngày 10/03, và Phase thiếu ngày kế hoạch không làm hỏng kết quả của các Phase còn lại.

## Cạm bẫy đã biết
- **Cám dỗ lớn nhất: "sửa" đường Kế hoạch thành đóng băng.** Việc điểm lịch sử đổi sau mỗi lần đồng bộ trông như bug. Nhưng đó là quyết định đã chốt (PRD §4.3, mục 1.4 ghi rõ "Không làm: Baseline"). Test 11 tồn tại để chặn người sau "sửa" nó.
- **Chia cho `planWorkdays = 0` cho ra `Infinity`, rồi `Math.min(Infinity, x)` = `x`** — kết quả trông vẫn hợp lý nên lỗi này hoàn toàn im lặng. Phải chặn tường minh.
- **`countWorkdays` tính cả hai đầu.** Phase 5 ngày hỏi đúng ngày cuối phải ra `elapsed = 5`, không phải 4. Sai một đơn vị ở đây làm đường Kế hoạch không bao giờ chạm 0.
- **Đừng làm tròn trong engine.** Cộng dồn nhiều Phase rồi mới làm tròn ở API — làm tròn sớm thì sai số tích lũy và test golden dataset sẽ lệch vài giây.
- **`elapsed <= 0` phải dùng `<=`, không phải `< 0`.** `countWorkdays` trả 0 khi `dateStr` trước `planStart`; dùng `< 0` sẽ cho Phase chưa bắt đầu cháy `perDay × 0 = 0` — vô hại ở đây, nhưng che mất ca `planStart` bằng `null` lọt qua.

## Đã làm gì
(agent điền khi xong)
