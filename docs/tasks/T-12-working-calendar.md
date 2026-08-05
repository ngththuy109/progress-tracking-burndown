---
id: T-12
title: Lịch làm việc, đếm ngày làm việc và xử lý múi giờ
status: review
model: opus
effort: medium
depends_on: ["T-02"]
touches:
  - packages/engine/src/calendar/end-of-day.ts
  - packages/engine/src/calendar/count-workdays.ts     # gộp cả listWorkdays — xem "Đã làm gì"
  - packages/engine/src/calendar/index.ts
  - packages/db/src/repositories/calendar.repository.ts
  - packages/shared/src/calendar.ts
prd_refs: ["§9.4", "§4.4", "E-06", "E-14"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-12 · Lịch làm việc, đếm ngày làm việc và xử lý múi giờ

## Mục tiêu
Trả lời chính xác ba câu: *"Mốc chốt sổ của ngày này là lúc nào theo UTC?"*, *"Từ ngày A tới ngày B có bao nhiêu ngày làm việc?"*, *"Liệt kê các ngày làm việc trong khoảng."* Mọi phép tính thời gian trong engine đều gọi vào đây.

## Ngữ cảnh cần biết

**PRD §9.4 gọi đây là nguồn gốc của phần lớn lỗi khó tìm trong hệ thống time-series.**

| Quy tắc | Chi tiết |
|---|---|
| Lưu trữ | `TIMESTAMPTZ`, giá trị UTC |
| Múi giờ hiển thị | Theo từng Epic (`tracked_epic.timezone`), giá trị IANA |
| Mốc chốt sổ | **23:59:59.999 giờ địa phương** của ngày đó, rồi quy về UTC |
| Thư viện | **Bắt buộc `luxon`.** Cấm dùng `new Date()` để tự cộng trừ offset |
| Ranh giới worklog | Worklog thuộc ngày `d` nếu `started` nằm trong `[00:00:00, 23:59:59.999]` giờ địa phương |
| Ngày lễ | Tra bảng `calendar_holiday`, bỏ qua khi đếm (E-14) |

**Về DST** — VN không có, Nhật cũng không (từ 1952). Nhưng **vẫn phải dùng thư viện IANA**, vì: (1) phòng khi mở rộng sang múi giờ khác, (2) chống hồi quy khi có người "tối ưu" bằng cách cộng offset tay.

**E-14** — nếu đường Kế hoạch giảm cả trong Tết thì PM sẽ tưởng team đang chậm nghiêm trọng.

## Phạm vi

**Trong:**
- `endOfDayUtcMs(dateStr, tz)` — mốc chốt sổ
- `countWorkdays(fromDate, toDate, calendar)` — đếm ngày làm việc, bao gồm cả hai đầu
- `listWorkdays(fromDate, toDate, calendar)` — liệt kê
- `isWorkday(date, calendar)`
- Repository đọc `work_calendar` + `calendar_holiday`, gộp thành object `WorkCalendar` truyền vào engine
- Cache lịch trong RAM ở tầng repository (dữ liệu ít đổi)

**Ngoài:**
- Không tính khối lượng còn lại (T-13 làm)
- Không tính đường Kế hoạch (T-16 làm)
- Không nhập ngày lễ (để card vận hành sau)
- Engine **không** đọc DB — nhận `WorkCalendar` qua tham số

## Đầu vào đã có
- Bảng `work_calendar`, `calendar_holiday` và seed 2 lịch từ **T-02**
- `luxon` từ T-01

## Việc phải làm

1. Type `WorkCalendar` trong shared:
   ```typescript
   interface WorkCalendar {
     calendarId: string;
     timezone: string;          // IANA
     workdaysMask: number;      // bitmask 7 bit, T2..CN
     hoursPerDay: number;
     holidays: ReadonlySet<string>;   // 'YYYY-MM-DD'
   }
   ```
2. `endOfDayUtcMs`:
   ```typescript
   DateTime.fromISO(dateStr, { zone: tz }).endOf('day').toUTC().toMillis()
   ```
   **Không** tự ghép chuỗi `+07:00`.
3. `countWorkdays(from, to, cal)` — duyệt từng ngày, bỏ qua ngày không nằm trong `workdaysMask` và ngày có trong `holidays`. `to < from` → trả `0`, không trả số âm.
4. `listWorkdays` — trả mảng `'YYYY-MM-DD'`.
5. Repository `getCalendar(calendarId)` — gộp `work_calendar` + ngày lễ, cache RAM. Thiếu dữ liệu lịch → mặc định T2–T6, ghi cảnh báo (E-14).
6. Mọi hàm engine **nhận `WorkCalendar` qua tham số**, không tự đọc DB, không đọc đồng hồ.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — bắt buộc `luxon`; cấm `new Date()` trong engine; ngày thuần dùng chuỗi `'YYYY-MM-DD'`.
- **C-10** — thiếu dữ liệu lịch thì mặc định T2–T6 và **ghi cảnh báo**, không im lặng.
- **C-12** — hàm thuần, `pnpm test:engine` < 10 giây; engine không import `db`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh — kiểm tra engine không có `new Date()`
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] `pnpm test -- packages/db` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Mốc chốt sổ:**
1. `mốc chốt sổ ngày 2026-03-10 giờ Việt Nam bằng 2026-03-10T16:59:59.999Z`
2. `mốc chốt sổ cùng ngày giờ Nhật bằng 2026-03-10T14:59:59.999Z` — lệch đúng 2 giờ
3. `hai múi giờ khác nhau cho ra hai mốc UTC khác nhau cho cùng một ngày`

**Đếm ngày làm việc:**
4. `từ thứ Hai tới thứ Sáu cùng tuần đếm được 5 ngày`
5. `khoảng vắt qua cuối tuần không đếm thứ Bảy và Chủ nhật`
6. `ngày lễ trong khoảng bị loại khỏi phép đếm`
7. `Epic vắt qua Tết Nguyên đán đếm đúng, không tính 7 ngày nghỉ`
8. `từ ngày và tới ngày trùng nhau và là ngày làm việc thì đếm được 1`
9. `toDate nhỏ hơn fromDate trả 0, KHÔNG trả số âm`

**Chống hồi quy múi giờ:**
10. `khoảng vắt qua ngày DST của một múi giờ có DST vẫn đếm đúng` — dùng `America/New_York` làm ca kiểm chứng, chứng minh không cộng offset tay
11. `listWorkdays trả đúng danh sách ngày, không lệch một ngày ở hai đầu`

**Lịch:**
12. `thiếu dữ liệu lịch thì mặc định T2 tới T6 và ghi cảnh báo`
13. `repository gộp đúng ngày lễ vào WorkCalendar`

## Định nghĩa "xong"
Ba hàm thời gian trả kết quả đúng cho cả múi giờ Việt Nam và Nhật, loại đúng ngày lễ, và không có chỗ nào trong engine tự cộng trừ offset bằng số.

## Cạm bẫy đã biết
- **Cộng tay `+7h` là lỗi kinh điển của bài toán này.** Chạy đúng ở Việt Nam nên rất dễ lọt qua review. Test 10 dùng một múi giờ **có** DST để lộ ngay lỗi này, dù dự án không dùng múi giờ đó.
- **`endOf('day')` phải gọi TRÊN đối tượng đã gắn timezone.** `DateTime.fromISO(d).setZone(tz).endOf('day')` cho kết quả **khác** `DateTime.fromISO(d, { zone: tz }).endOf('day')`. Cái đầu diễn giải chuỗi theo giờ máy chủ rồi mới đổi múi — sai một ngày với máy chủ ở múi giờ khác.
- **`toDate < fromDate` phải trả 0.** Trả số âm sẽ khiến đường Kế hoạch đi lên ở T-16 mà không có lỗi nào.
- **Bitmask ngày làm việc phải chốt rõ bit nào là thứ mấy** và ghi vào comment. Luxon đánh số T2 = 1, Chủ nhật = 7 — không giống `Date.getDay()` của JavaScript (Chủ nhật = 0). Nhầm chỗ này làm lệch cả tuần.
- **Cache lịch trong RAM phải có cách làm mới.** Thêm ngày lễ mà worker chạy suốt không restart thì lịch cũ vẫn được dùng.

## Đã làm gì

**35 test xanh** (28 engine + 7 repository; card yêu cầu 13). `typecheck` · `lint` xanh, `test:engine` vẫn dưới ngưỡng 10 giây.

### Ba quyết định

1. **Gộp `list-workdays.ts` vào `count-workdays.ts`.** Card liệt kê hai file, nhưng `countWorkdays` chính là `listWorkdays().length` — tách ra thì hoặc là hai bản cài đặt có thể lệch nhau, hoặc là một file chỉ có đúng một dòng gọi sang file kia. `touches` đã cập nhật lại.

2. **`WorkCalendar` mang theo `warnings`.** Card nói "ghi cảnh báo"; tôi để cảnh báo đi **kèm dữ liệu** chứ không chỉ nằm trong log, vì tầng API còn phải hiện nó cho người dùng (C-10). Không tìm thấy lịch, hoặc lịch chưa khai ngày lễ nào, đều sinh cảnh báo — ca thứ hai chính là E-14 và nó sẽ xảy ra ngay lần chạy đầu tiên.

3. **Thêm `localDateOf` và `startOfDayUtcMs`** ngoài danh sách card. Xếp worklog vào đúng ngày địa phương là việc T-13 và T-17 chắc chắn cần, và để mỗi nơi tự làm thì sẽ có ngày lệch nhau. Cùng lý do thêm `addWorkdays` — T-16 cần nó để dựng đường Kế hoạch.

### Bốn test thêm ngoài card

- **Mốc chốt sổ trước/sau ngày DST lệch nhau đúng 1 giờ.** Test 10 của card dùng `America/New_York` để bắt lỗi cộng offset tay khi *đếm* ngày; test này bắt cùng lỗi đó ở phép tính *mốc chốt sổ* — hai đường khác nhau, cùng một cạm bẫy.
- **Ngày không hợp lệ ném lỗi thay vì trả NaN.** `DateTime.fromISO('2026-02-30')` trả về đối tượng `invalid`, và `.toMillis()` cho `NaN`. `NaN` lan xuống dưới sẽ thành một mốc thời gian vô nghĩa mà không chỗ nào báo lỗi.
- **Múi giờ không hợp lệ ném lỗi thay vì lặng lẽ dùng UTC** — cùng loại lỗi im lặng.
- **Ngày lễ giữ nguyên ngày dương lịch, không bị đổi múi giờ.** Prisma trả cột `DATE` thành mốc nửa đêm UTC; ai đó "sửa cho đúng" bằng cách đổi sang múi giờ địa phương sẽ làm 17/02 lùi thành 16/02 ở mọi múi giờ phía đông. Đã ghi rõ trong comment vì đây trông như một lỗi cần sửa.

### Một chỗ card cảnh báo và tôi kiểm chứng riêng

Bitmask: bit 0 = thứ Hai theo luxon (`weekday`: T2 = 1 … CN = 7), **không** giống `Date.getDay()` (CN = 0). Có hai test riêng khẳng định bit 0 là thứ Hai và bit 6 là Chủ nhật — nếu ai đó đổi sang `getDay()` thì cả hai đỏ ngay.
