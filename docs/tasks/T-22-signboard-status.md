---
id: T-22
title: Cây quyết định trạng thái Signboard và quy tắc gộp ô
status: review
model: opus
effort: medium
depends_on: ["T-14"]
touches:
  - packages/engine/src/signboard/resolve-cell-status.ts
  - packages/engine/src/signboard/merge-cell.ts
  - packages/engine/src/signboard/status-rank.ts
  - packages/engine/src/signboard/index.ts
  - packages/shared/src/signboard.ts
prd_refs: ["§6.3", "§6.4", "§6.5", "§6.6", "E-30"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-22 · Cây quyết định trạng thái Signboard và quy tắc gộp ô

## Mục tiêu
Cho một Sub-task và một ngày, trả về một trong 6 trạng thái tiến độ. Khi nhiều Sub-task rơi vào cùng một ô thì gộp lấy trạng thái xấu nhất. Đây là toàn bộ logic của bảng Signboard; card GĐ 4 chỉ dựng giao diện quanh nó.

## Ngữ cảnh cần biết

**Cây quyết định** (PRD §6.3) — xét lần lượt, gặp điều kiện nào khớp thì dừng:

```
1. statusCategory == Done                       → Completed
2. thiếu plan_start hoặc plan_end               → NoPlan
3. Chưa có actual_start
      hôm nay <= plan_start                      → NYS
      hôm nay >  plan_start                      → Delay Start
4. Đã có actual_start (đang làm)
      hôm nay > plan_end                         → Delay End     ← xét TRƯỚC
      actual_start > plan_start                  → Delay Start
      còn lại                                    → OnSchedule
```

**Hai điểm dễ hiểu nhầm:**

> **Bước 4 xét `Delay End` trước `Delay Start`.** Task vừa bắt đầu trễ vừa quá hạn sẽ hiện `Delay End`, vì quá hạn kết thúc nghiêm trọng hơn.
>
> **Bắt đầu trễ nhưng vẫn còn trong hạn thì vẫn là `Delay Start`.** Không "tha" thành `OnSchedule` — PM cần biết sớm để can thiệp.

**Sáu ca ví dụ số** (PRD §6.3, giả sử hôm nay là **10/03**):

| # | Plan | Thực tế | statusCategory | Kết quả | Vì sao |
|---|---|---|---|---|---|
| 1 | 02/03 → 06/03 | bắt đầu 02/03, xong 09/03 | `Done` | **Completed** | Bước 1 — dù kết thúc trễ 3 ngày |
| 2 | (trống) | bắt đầu 05/03 | `In Progress` | **NoPlan** | Bước 2 |
| 3 | 12/03 → 15/03 | chưa bắt đầu | `To Do` | **NYS** | Bước 3 |
| 4 | 05/03 → 08/03 | chưa bắt đầu | `To Do` | **Delay Start** | Bước 3 |
| 5 | 05/03 → 08/03 | bắt đầu 06/03 | `In Progress` | **Delay End** | Bước 4 — `Delay End` thắng |
| 6 | 09/03 → 15/03 | bắt đầu 10/03 | `In Progress` | **Delay Start** | Bước 4 |

**`NoPlan` là trạng thái thứ 6, thêm ngoài 5 trạng thái ban đầu** (PRD §6.4):

> Thiếu mốc kế hoạch thì không có gì để so sánh. Không được ép vào `NYS` (sai nghĩa, task có thể đang làm dở) cũng không được ép vào `OnSchedule` (bịa kết luận không căn cứ).

**Bảng thứ hạng khi gộp ô** (PRD §6.5) — số lớn hơn = xấu hơn:

| Thứ hạng | Trạng thái |
|---|---|
| 0 | `Completed` |
| 1 | `NYS` |
| 2 | `OnSchedule` |
| 3 | `NoPlan` |
| 4 | `Delay Start` |
| 5 | `Delay End` |

> Ô có 1 ticket `Completed` và 1 ticket `NYS` sẽ ra **`NYS`**. Đúng như vậy — ô đó chưa xong, không được hiện màu xanh làm PM tưởng đã hoàn tất.

## Phạm vi

**Trong:**
- `resolveCellStatus(input, asOfDate)` — cây quyết định 4 bước, 6 trạng thái
- `STATUS_RANK` và `mergeCellStatus(statuses)` — lấy thứ hạng xấu nhất
- `mergeCell(subtasks, asOfDate)` — gộp ngày (`MIN` plan_start, `MAX` plan_end) + trạng thái
- Type `SignboardStatus`, `SignboardCell` trong shared

**Ngoài:**
- Không dựng cả bảng Signboard (card GĐ 4)
- Không làm API (card GĐ 4)
- Không phân tách tiêu đề (T-08 đã làm)
- Không đọc DB, **không đọc đồng hồ** — `asOfDate` nhận qua tham số

## Đầu vào đã có
- `resolveSubtaskActualDates()` từ **T-14**
- `readWbsDates()` từ **T-05** (qua dữ liệu đã lưu trong `jira_issue`)
- Enum `SignboardStatus` từ **T-02**

## Việc phải làm

1. Type trong shared:
   ```typescript
   type SignboardStatus =
     | 'COMPLETED' | 'ON_SCHEDULE' | 'NYS'
     | 'DELAY_START' | 'DELAY_END' | 'NO_PLAN';

   interface CellStatusInput {
     statusCategory: StatusCategory;
     planStart: string | null;
     planEnd: string | null;
     actualStart: string | null;
   }
   ```
2. `resolveCellStatus(input, asOfDate)` — cài đúng cây quyết định 4 bước ở trên. **Không đảo thứ tự bước 4.**
3. `status-rank.ts`:
   ```typescript
   const STATUS_RANK: Record<SignboardStatus, number> = {
     COMPLETED: 0, NYS: 1, ON_SCHEDULE: 2,
     NO_PLAN: 3, DELAY_START: 4, DELAY_END: 5,
   };
   ```
4. `mergeCell(subtasks, asOfDate)`:
   - `planStart` = MIN các `planStart` **không null**
   - `planEnd` = MAX các `planEnd` **không null**
   - `status` = trạng thái có `STATUS_RANK` lớn nhất
   - `ticketCount` = số Sub-task
   - Giữ danh sách từng ticket kèm trạng thái riêng (cho tooltip)
5. Ô trống (`present: false`) — không có Sub-task nào → **không** có trường `status`. Đây là khái niệm **khác hẳn** `NoPlan`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — ngày là chuỗi `'YYYY-MM-DD'`; **`asOfDate` nhận qua tham số**, cấm `new Date()`.
- **C-4** — nhận diện Done qua `statusCategory`, không qua `status.name`.
- **C-10** — thiếu ngày kế hoạch → `NoPlan`, **không đoán bừa**.
- **C-12** — hàm thuần; test phụ thuộc ngày phải đóng băng đồng hồ hoặc truyền `asOfDate`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh — kiểm tra không có `new Date()`
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Sáu ca ví dụ trong PRD — bắt buộc:**
1. `tái hiện đúng cả 6 ca của bảng PRD §6.3 với asOfDate = 2026-03-10` — một test bảng

**Thứ tự ưu tiên bước 4:**
2. `task vừa trễ bắt đầu vừa quá hạn kết thúc thì ra Delay End, KHÔNG ra Delay Start`
3. `task bắt đầu trễ nhưng còn trong hạn vẫn ra Delay Start, KHÔNG được tha thành OnSchedule`

**Done thắng tất cả:**
4. `task Done kết thúc trễ 3 ngày vẫn ra Completed`
5. `task Done mà thiếu ngày kế hoạch vẫn ra Completed` — bước 1 trước bước 2

**NoPlan:**
6. `thiếu plan_start thì ra NoPlan, KHÔNG ra NYS`
7. `thiếu plan_end thì ra NoPlan, KHÔNG ra OnSchedule`
8. `NoPlan áp dụng cả khi task đang làm dở`

**Gộp ô:**
9. `ô có Completed và NYS thì ra NYS, KHÔNG ra Completed`
10. `ô có Completed và Delay End thì ra Delay End`
11. `ô gộp lấy MIN của plan_start và MAX của plan_end`
12. `ô gộp giữ đủ danh sách từng ticket kèm trạng thái riêng`
13. `ô có đúng 1 ticket thì trạng thái ô bằng trạng thái ticket đó`

**Ô trống khác NoPlan:**
14. `ô không có Sub-task nào thì present = false và KHÔNG có trường status`

**Không đọc đồng hồ:**
15. `gọi hàm với hai asOfDate khác nhau cho hai kết quả khác nhau, dữ liệu đầu vào không đổi`

## Định nghĩa "xong"
Chạy hàm qua bảng 6 ca của PRD §6.3 cho ra đúng 6 trạng thái; ô gộp 1 Completed + 1 NYS ra `NYS`; và hàm không đọc đồng hồ hệ thống ở bất kỳ đâu.

## Cạm bẫy đã biết
- **Đảo thứ tự bước 4 là lỗi im lặng.** Xét `Delay Start` trước sẽ giấu mất việc task đang quá hạn — PM nhìn thấy màu vàng thay vì đỏ và không ưu tiên xử lý. Test 2 tồn tại chính vì lỗi này không tự lộ.
- **Đọc `new Date()` trong hàm này làm test xanh hôm nay và đỏ tuần sau.** Đây là nguồn test dễ vỡ nhất trong dự án (PRD §8.1). Lint rule đã chặn, nhưng đừng tìm cách lách bằng cách nhận `Date` object rồi gọi `.getTime()`.
- **`Completed` xếp hạng 0 nghĩa là nó THUA mọi trạng thái khác khi gộp.** Trực giác dễ nghĩ ngược lại ("xong rồi thì tốt nhất"). Nhưng ô có 1 xong 1 chưa bắt đầu thì ô đó **chưa xong** — hiện xanh là nói dối.
- **Ô trống và `NoPlan` là hai thứ khác nhau** (PRD §6.6). Ô trống = Function vốn không cần khâu này, bình thường, không đếm vào thống kê. `NoPlan` = có ticket nhưng thiếu ngày, là vấn đề cần sửa. Gộp hai cái làm một sẽ khiến thanh tóm tắt đếm sai.
- **`MIN` trên mảng toàn `null` phải trả `null`, không trả `Infinity`.**
- **So sánh ngày bằng chuỗi chỉ đúng với `'YYYY-MM-DD'`.** Validate định dạng ở biên hàm.

## Đã làm gì

**38 test xanh** (card yêu cầu 15). Cả 6 ca ví dụ PRD §6.3 tái hiện đúng với `asOfDate = 2026-03-10`.

### Ba test biên thêm ngoài card

Cây quyết định có ba chỗ so sánh ngày, và mỗi chỗ đều có một **ranh giới đúng bằng nhau** mà card không nêu:

- **Hôm nay đúng bằng `plan_end`** → chưa quá hạn (`ON_SCHEDULE`). Dùng `>=` thay `>` sẽ báo đỏ sớm một ngày cho mọi task.
- **Hôm nay đúng bằng `plan_start` mà chưa bắt đầu** → vẫn là `NYS`, chưa trễ.
- **Bắt đầu SỚM hơn kế hoạch** → `ON_SCHEDULE`, không phải một trạng thái riêng.

### Chặn định dạng ngày ngay ở biên hàm

Card ghi trong cạm bẫy: *"so sánh ngày bằng chuỗi chỉ đúng với `YYYY-MM-DD`"*. Tôi cho **ném lỗi** thay vì chỉ ghi chú, vì `'2026-3-9' < '2026-03-10'` cho ra `false` — so từng ký tự thì `'3'` lớn hơn `'0'`. Kết quả là trạng thái **đảo ngược lặng lẽ**, không có gì báo. Có 2 test cho ca này.

### Hai điểm về gộp ô

- **`actualEnd` của ô lấy MAX**, không phải MIN: ô chỉ thật sự kết thúc khi ticket muộn nhất kết thúc. Card không nêu trường này nhưng Phụ lục B có nó trong phản hồi API.
- **Thêm test khẳng định 6 trạng thái có 6 thứ hạng khác nhau.** Nếu ai đó thêm trạng thái thứ 7 mà quên xếp hạng, hoặc gán trùng hạng, thì thứ tự gộp trở nên phụ thuộc thứ tự mảng đầu vào — một lỗi không tất định và cực khó tái hiện.

### Ô trống và `NoPlan` được tách ở tầng kiểu dữ liệu

`SignboardCell` là union: `{ present: false }` **không có** trường `status`. Nghĩa là không thể lỡ tay đọc trạng thái của một ô trống — TypeScript chặn ngay lúc biên dịch, không cần trông vào test.
