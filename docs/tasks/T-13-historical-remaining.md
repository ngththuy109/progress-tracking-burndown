---
id: T-13
title: Ba quy tắc tính khối lượng còn lại tại một mốc quá khứ
status: review
model: opus
effort: high
started_at: 2026-08-03
finished_at: 2026-08-03
depends_on: ["T-04"]
touches:
  - packages/engine/src/remaining/resolve-historical-remaining.ts
  - packages/engine/src/remaining/total-spent-till.ts
  - packages/engine/src/remaining/resolve-original-estimate-at.ts
  - packages/engine/src/remaining/index.ts
prd_refs: ["§4.3.2", "§4.4", "E-04", "E-05", "E-13"]
owner: null
---

# T-13 · Ba quy tắc tính khối lượng còn lại tại một mốc quá khứ

## Mục tiêu
Trả lời câu hỏi trung tâm của cả hệ thống: *"Vào cuối ngày X, Sub-task này còn lại bao nhiêu giờ?"* Đây là hàm cốt lõi tạo ra đường Thực tế — thứ mà biểu đồ Jira mặc định không làm được.

## Ngữ cảnh cần biết

**Ba quy tắc xét theo đúng thứ tự ưu tiên, dừng ngay khi khớp** (PRD §4.3.2):

| Ưu tiên | Điều kiện | Kết quả | Vì sao |
|---|---|---|---|
| **1** | Tại `T_d`, statusCategory = `Done` | **0** | Đã xong thì không còn gì để làm, kể cả Jira còn sót số dư |
| **2** | Có changelog đổi `timeestimate` trước hoặc bằng `T_d` | **Giá trị mới nhất** trong các bản ghi đó | Đây là con số con người tự đánh giá lại — đáng tin nhất |
| **3** | Không rơi vào 2 trường hợp trên | `max(0, OriginalEstimate − TổngGiờĐãLogTới_T_d)` | Suy ra từ khối lượng đã bỏ ra |

**Ví dụ số đầy đủ từ PRD** — Sub-task `PAY-121`, Original Estimate = 40 giờ:

| Ngày | Việc xảy ra | Quy tắc | Còn lại |
|---|---|---|---|
| 09/03 | Chưa làm gì | 3: `max(0, 40 − 0)` | **40h** |
| 10/03 | Log 8h | 3: `max(0, 40 − 8)` | **32h** |
| 11/03 | Log thêm 8h | 3: `max(0, 40 − 16)` | **24h** |
| 12/03 | Dev sửa `timeestimate` = 30h | 2: lấy 30 | **30h** ⚠️ đi lên |
| 13/03 | Log thêm 8h, không sửa `timeestimate` | **2 vẫn thắng**: giá trị log gần nhất vẫn là 30 | **30h** |
| 16/03 | Dev sửa `timeestimate` = 10h | 2: lấy 10 | **10h** |
| 17/03 | Chuyển sang `完了` | 1 | **0h** |

> **Ngày 13/03 con số không giảm dù có log giờ. Đây là hành vi ĐÚNG theo thiết kế** — quy tắc 2 ưu tiên cao hơn quy tắc 3. Ý nghĩa: khi con người đã tự khai "còn 30 giờ", ta tin con người hơn phép trừ máy móc.

**Original Estimate cũng có thể bị sửa giữa chừng** (E-04) — phải tra giá trị **tại thời điểm `T_d`** từ changelog, không dùng giá trị hiện tại.

**`timeestimate` bị xoá trắng (`null`)** (E-05) — coi như "không còn khai báo tường minh", rơi xuống quy tắc 3. **Không** hiểu nhầm `null` = 0.

## Phạm vi

**Trong:**
- `resolveHistoricalRemaining(sub, tMs, statusIdMap)` — 3 quy tắc theo thứ tự
- `totalSpentTill(sub, tMs)` — tổng giờ đã log, lọc theo `started`
- `resolveOriginalEstimateAt(sub, tMs)` — tra Original Estimate tại mốc quá khứ

**Ngoài:**
- Không cộng dồn lên Phase/Epic (T-17 làm)
- Không tính đường Kế hoạch (T-16 làm)
- Không đọc/ghi database — nhận dữ liệu qua tham số
- Không đọc đồng hồ

## Đầu vào đã có
- `resolveStatusCategoryAt()` từ **T-04**
- Type `ChangelogEvent`, `WorklogEntry`, `SubtaskRecord` từ T-02/T-04

## Việc phải làm

1. `totalSpentTill(sub, tMs)` — cộng `timeSpentSeconds` của worklog có `startedAtMs <= tMs`, bỏ qua `is_deleted`. Mảng đã sắp xếp sẵn nên `break` được khi vượt mốc.
2. `resolveOriginalEstimateAt(sub, tMs)` — tua changelog trường `timeoriginalestimate` tới `tMs`. Chưa từng bị sửa → giá trị hiện tại. Không có changelog (issue tạo trước khi bật audit) → giá trị hiện tại + cảnh báo `ESTIMATE_HISTORY_MISSING` (E-04).
3. `resolveHistoricalRemaining(sub, tMs, statusIdMap)`:
   ```typescript
   // ƯU TIÊN 1
   if (resolveStatusCategoryAt(sub.changelog, statusIdMap, tMs) === 'done') return 0;

   // ƯU TIÊN 2
   let latestExplicit: number | null = null;
   for (const ev of sub.changelog) {
     if (ev.field !== 'timeestimate') continue;
     if (ev.createdAtMs > tMs) break;
     latestExplicit = ev.toValue === null ? null : Number(ev.toValue);
   }
   if (latestExplicit !== null) return Math.max(0, latestExplicit);

   // ƯU TIÊN 3
   const originalAtT = resolveOriginalEstimateAt(sub, tMs);
   return Math.max(0, originalAtT - totalSpentTill(sub, tMs));
   ```
4. **Chú ý vòng lặp ưu tiên 2**: `latestExplicit` bị gán lại mỗi lần khớp, kể cả gán về `null` khi `toValue === null`. Đó là cách xử lý E-05 — lần sửa cuối là xoá trắng thì rơi xuống quy tắc 3.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — worklog lọc theo `started`, **không** theo `created`.
- **C-2** — mọi giá trị là **giây**, kiểu `number`.
- **C-10** — không đoán bừa: `timeestimate = null` rơi xuống quy tắc 3, không tự hiểu là 0.
- **C-12** — hàm thuần, không đọc đồng hồ, `pnpm test:engine` < 10 giây.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Bảng ví dụ trong PRD — 7 mốc của PAY-121:**
1. `tái hiện đúng cả 7 dòng của bảng ví dụ PRD §4.3.2` — một test bảng, 7 mốc

**Từng quy tắc:**
2. `Sub-task đã Done thì khối lượng còn lại bằng 0, kể cả khi Jira còn sót số dư`
3. `có changelog timeestimate thì lấy giá trị mới nhất, bỏ qua phép trừ`
4. `không có changelog timeestimate thì lấy Original Estimate trừ giờ đã log`

**Thứ tự ưu tiên — phần dễ sai nhất:**
5. `sau khi sửa timeestimate, log thêm giờ KHÔNG làm giảm con số` — chính là dòng 13/03
6. `Done thắng cả khi có changelog timeestimate khác 0`

**Biên:**
7. `log giờ vượt Original Estimate thì trả 0, KHÔNG trả số âm`
8. `timeestimate bị xoá trắng thành null thì rơi xuống quy tắc 3, KHÔNG hiểu là 0`
9. `sự kiện changelog sau mốc T bị bỏ qua`
10. `worklog có started sau mốc T bị bỏ qua`
11. `worklog đã bị xoá (is_deleted) không được cộng vào`

**Original Estimate đổi giữa chừng:**
12. `Original Estimate bị sửa từ 40 lên 60 thì mốc trước khi sửa vẫn dùng 40`
13. `không có changelog Original Estimate thì dùng giá trị hiện tại và cảnh báo ESTIMATE_HISTORY_MISSING`

**Reopen:**
14. `Sub-task Done rồi mở lại thì mốc sau khi mở lại KHÔNG còn trả 0`

## Định nghĩa "xong"
Chạy hàm qua bảng ví dụ 7 mốc trong PRD §4.3.2 cho ra đúng 7 con số, và ca "log giờ nhưng không giảm" ở dòng 13/03 được test khẳng định là hành vi mong muốn.

## Cạm bẫy đã biết
- **Cám dỗ lớn nhất: "sửa" hành vi ở dòng 13/03.** Nó trông như bug — có log giờ mà số không giảm. Nhưng đó là thiết kế: quy tắc 2 ưu tiên hơn quy tắc 3. Test 5 tồn tại để chặn người sau "sửa" nó.
- **Vòng lặp ưu tiên 2 phải gán lại `latestExplicit` mỗi lần khớp, gồm cả gán về `null`.** Dùng `if (ev.toValue !== null) latestExplicit = ...` là sai — sẽ bỏ qua lần xoá trắng cuối cùng (E-05).
- **Đừng `break` ngay khi tìm thấy `timeestimate` đầu tiên.** Phải tua hết tới `tMs` để lấy giá trị **mới nhất**, không phải giá trị **đầu tiên**.
- **`Math.max(0, ...)` phải áp ở cả quy tắc 2 lẫn 3.** Jira có thể trả `timeestimate` âm trong vài ca hiếm.
- **`Number(ev.toValue)` với chuỗi rỗng cho ra `0`, không phải `NaN`.** Phân biệt rõ `''` và `null` khi đọc changelog, nếu không sẽ hiểu nhầm "xoá trắng" thành "đặt về 0" — hai thứ này cho kết quả khác hẳn nhau.

## Đã làm gì

**31 test xanh** (card yêu cầu 14). Toàn bộ 7 mốc của bảng ví dụ PRD §4.3.2 tái hiện đúng từng con số. `typecheck` · `lint` xanh, `test:engine` 2.3s.

### Ba thứ thêm ngoài card

1. **Kết quả trả về mang theo `rule` và số liệu thô**, không chỉ một con số. T-25 (`/api/.../explain`) phải nói được *"Sub-task này áp dụng Quy tắc 2, có người sửa tay còn 30 giờ lúc 12/03"* — nếu hàm này chỉ trả `number` thì T-25 sẽ phải **tính lại lần nữa** bằng một bản sao logic, và hai bản sẽ có ngày lệch nhau.

2. **`explainRule()`** sinh sẵn câu tiếng Việt cho từng quy tắc. Cùng lý do: câu giải thích phải đi cùng chỗ ra quyết định, không phải viết lại ở tầng API.

3. **`spentBetween()`** — tổng giờ log trong đúng một khoảng, khác `totalSpentTill` là luỹ kế. T-17 cần nó để tính phần giờ bỏ ra trong MỘT ngày.

### Ca đáng chú ý nhất: phân biệt ba kiểu "không có giá trị"

Card cảnh báo `Number('')` cho ra `0` chứ không phải `NaN`. Khi làm mới thấy rõ là có **ba** giá trị khác nhau chứ không phải hai, và mỗi cái cho kết quả khác hẳn:

| `toValue` | Nghĩa | Kết quả |
|---|---|---|
| `null` | Xoá trắng ước lượng | Rơi xuống **Quy tắc 3** |
| `''` | Cũng là xoá trắng | Rơi xuống **Quy tắc 3** |
| `'0'` | Khai tường minh "còn 0 giờ" | **Quy tắc 2**, trả về 0 |

Hai dòng đầu và dòng cuối đều cho ra số 0 trong nhiều ca, nên rất dễ gộp lại. Nhưng khi Original Estimate là 40 giờ và chưa log gì thì `null` cho **40 giờ** còn `'0'` cho **0 giờ** — lệch hẳn. Có test riêng cho cả ba.

### Một chỗ tôi làm khác mã giả trong card

`resolveOriginalEstimateAt` không chỉ tua các sự kiện **trước** mốc T. Nó còn đọc `fromValue` của sự kiện **đầu tiên sau** mốc T — vì đó chính là giá trị đang có tại thời điểm T.

Nếu chỉ tua sự kiện trước T thì Sub-task tạo với OE = 40, sửa lên 60 vào ngày 15/03, sẽ không có sự kiện nào trước ngày 10/03 → phải dùng giá trị **hiện tại** là 60. Sai: ngày 10/03 nó đang là 40. Có test riêng, và một test nữa khẳng định phép trừ ở Quy tắc 3 dùng đúng 40.
