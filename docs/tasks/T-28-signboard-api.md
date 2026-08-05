---
id: T-28
title: API bảng Signboard và khu "chưa lên được bảng"
status: review
model: sonnet
effort: high
depends_on: ["T-11", "T-22", "T-24"]
touches:
  - apps/api/src/routes/signboard.routes.ts
  - apps/api/src/services/signboard.service.ts
  - apps/api/src/adapters/signboard.adapters.ts
  - apps/api/src/routes/signboard.routes.test.ts
  - apps/api/src/server.ts
  - packages/shared/src/api-signboard.ts
prd_refs: ["§6.1", "§6.4", "§6.5", "§6.6", "E-27", "E-29", "E-31"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-28 · API bảng Signboard và khu "chưa lên được bảng"

## Mục tiêu
Ba endpoint cung cấp đủ dữ liệu cho bảng Signboard. Sau card này, màn hình (T-31) chỉ việc vẽ.

## Ngữ cảnh cần biết

**Signboard KHÔNG có bảng snapshot** (PRD §9.1 ghi rõ). Trạng thái ô phụ thuộc **hôm nay là ngày nào**, nên phải tính lúc đọc. Dữ liệu nguồn (`wbs_*`, ngày thực tế, `statusCategory`, `function_key`, `task_type`) đã có sẵn trong `jira_issue` từ T-11.

Đó là lý do Signboard **rẻ hơn nhiều** so với Burndown: một truy vấn cộng một hàm thuần đã có sẵn từ T-22.

**Cấu trúc bảng** (PRD §6.1):

```
            │ Create │ BALReview │ FixCommentBAL │ JMReview │ Tổng
  Login     │  ✅    │    🟦     │      —        │   ⬜     │  🟦
  決済      │  ✅    │    🟥     │      🟨       │   ⬜     │  🟥
```

- **Hàng** = Function (gộp theo `function_key`, đã chuẩn hoá NFKC + chữ thường)
- **Cột** = loại task, thứ tự lấy từ cấu hình (`signboard_column`)
- **Ô** = `plan_start → plan_end` + trạng thái; ngày thực tế nằm trong tooltip

**Sáu trạng thái + ô trống.** `present: false` (ô trống) **khác hẳn** `NO_PLAN` (có ticket, thiếu ngày). Gộp hai thứ này làm thanh tóm tắt đếm sai (PRD §6.6).

## Phạm vi

**Trong:**
- `GET /api/signboard/epic/:key/phase/:phaseCode` — dữ liệu bảng đầy đủ
- `GET /api/signboard/epic/:key/phase/:phaseCode/unparsed` — Sub-task chưa lên được bảng
- `GET /api/config/signboard-columns?project=KEY` — danh sách cột đang hiệu lực
- Thanh tóm tắt: đếm ô theo từng trạng thái
- `asOfDate` nhận qua query, mặc định là hôm nay theo múi giờ của lịch Epic

**Ngoài:**
- Không tính lại gì cả — chỉ đọc và gọi hàm thuần của T-22
- Không cache (xem "Cạm bẫy")
- Không làm giao diện (T-31 làm)

## Đầu vào đã có
- `resolveCellStatus`, `mergeCell` từ **T-22**
- `function_key`, `task_type`, `sb_parse_status` trong `jira_issue` từ **T-11**
- `wbs_*` và ngày thực tế từ **T-15**
- Khung route + cổng của `apps/api` từ **T-09**, **T-10**

## Việc phải làm

1. `signboard.repository.ts` — **một** truy vấn lấy mọi Sub-task của `(epicKey, phaseCode)` kèm `function_key`, `function_name`, `task_type`, `wbs_*`, ngày thực tế, `statusCategory`. Dùng index `(epic_key, phase_code, function_name, task_type)` từ T-02.
2. `signboard.service.ts`:
   - Nhóm theo `function_key` → hàng; theo `task_type` → cột
   - Mỗi ô gọi `mergeCell` của T-22
   - Ô không có ticket nào → `{ present: false }`
   - Tên hàng hiển thị lấy **dạng gặp đầu tiên** của `function_name` (E-31)
   - Cột "Tổng" mỗi hàng = `mergeCellStatus` của các ô có mặt trong hàng
3. Thanh tóm tắt: đếm theo trạng thái, **không đếm ô trống**.
4. `/unparsed` trả về hai nhóm riêng, kèm lý do và link Jira:
   - `sb_parse_status = UNPARSED` — tiêu đề sai định dạng
   - `task_type = NULL` — `TaskName` lạ
   Nếu cùng một `TaskName` lạ xuất hiện **≥ 3 lần** thì gợi ý thêm cột mới (E-29).
5. Nếu **> 30%** Sub-task của Phase không phân tách được tiêu đề → trả cờ `parseHealthWarning` để UI hiện banner (E-27).
6. Sắp cột theo `display_order` của cấu hình đang hiệu lực; `task_type` không nằm trong cấu hình thì **không tạo cột mới**.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — `asOfDate` là chuỗi `'YYYY-MM-DD'` theo múi giờ của lịch Epic, không phải UTC.
- **C-3** — JSON `camelCase`.
- **C-4** — trạng thái đọc qua `statusCategory`.
- **C-9** — thông báo lỗi tiếng Việt, nói cả cách khắc phục.
- **C-10** — không đoán bừa: thiếu ngày thì `NO_PLAN`, không suy diễn.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Dựng bảng:**
1. `ba Sub-task cùng Function khác hoa/thường gộp thành MỘT hàng`
2. `tên hàng hiển thị theo dạng gặp đầu tiên, không phải dạng đã chuẩn hoá`
3. `Function không có Sub-task nào cho một cột thì ô đó là present false`
4. `hai Sub-task cùng ô thì ô mang trạng thái xấu nhất và ticketCount = 2`
5. `cột trả về đúng thứ tự display_order của cấu hình`
6. `task_type lạ KHÔNG sinh thêm cột mới`

**Thanh tóm tắt:**
7. `ô trống không được đếm vào bất kỳ trạng thái nào`
8. `tổng số ô đếm được cộng ô trống bằng số hàng nhân số cột`

**Phụ thuộc vào hôm nay:**
9. `đổi asOfDate làm đổi trạng thái nhưng KHÔNG đổi plan_* và actual_*`
10. `không truyền asOfDate thì lấy hôm nay theo múi giờ của lịch Epic, không phải UTC`

**Chưa lên được bảng:**
11. `Sub-task UNPARSED xuất hiện ở /unparsed kèm lý do đọc được`
12. `TaskName lạ xuất hiện 3 lần thì có gợi ý thêm cột`
13. `hơn 30% Sub-task không parse được thì trả cờ cảnh báo`

## Định nghĩa "xong"
Gọi `GET /api/signboard/epic/PAY-1/phase/DESIGN` trả về đủ hàng, cột, ô và thanh tóm tắt để T-31 vẽ bảng mà không cần gọi thêm endpoint nào khác.

## Cạm bẫy đã biết
- **Đừng cache kết quả Signboard.** Trạng thái phụ thuộc "hôm nay"; cache qua nửa đêm sẽ trả về trạng thái của hôm qua và **không ai nhận ra** — biểu đồ vẫn hiện, chỉ là sai. Nếu buộc phải cache thì khoá cache **phải chứa `asOfDate`**.
- **`asOfDate` mặc định phải theo múi giờ của lịch Epic.** Lấy `new Date()` của máy chủ (thường là UTC) sẽ làm bảng đổi trạng thái lúc 7 giờ sáng giờ Việt Nam thay vì lúc nửa đêm.
- **Đừng dùng `function_name` làm khoá gộp hàng.** Phải dùng `function_key` (đã NFKC + lowercase). Dùng nhầm thì `Login`, `login` và `Ｌｏｇｉｎ` thành ba hàng riêng và bảng vô dụng (E-31).
- **Ô trống và `NO_PLAN` là hai thứ khác nhau.** Trộn lẫn thì thanh tóm tắt đếm sai và PM tưởng có hàng chục việc thiếu ngày kế hoạch.
- **Một truy vấn, không phải N+1.** Một Phase có thể có 200 Sub-task; gọi từng ticket một sẽ làm API chậm gấp trăm lần mà nhìn code không thấy gì bất thường.

## Đã làm gì

**24 test xanh** (card yêu cầu 13), chạy qua `fastify.inject()` với cổng giả.

### Đồng hồ đi qua cổng, và đó là test đắt nhất của card

Trạng thái ô phụ thuộc "hôm nay là ngày nào", nên `now` được truyền vào như một cổng. Nhờ vậy có được test này:

> **"nửa đêm giờ Việt Nam đã sang ngày mới dù UTC còn hôm trước"** — đóng băng đồng hồ ở `2026-03-09T17:30:00Z`, tức 00:30 ngày 10/03 ở Việt Nam, và đòi `asOfDate` phải là `2026-03-10`.

Lấy `new Date()` trực tiếp trong route thì test này không viết được, và lỗi "bảng đổi trạng thái lúc 7 giờ sáng thay vì lúc nửa đêm" sẽ chỉ lộ ra khi có người dùng thật để ý.

### Không cache, và lý do được ghi ngay đầu file

Cache biểu đồ (T-24) sống 15 phút vì số liệu chốt theo ngày. Signboard thì **không cache**: cache qua nửa đêm sẽ trả trạng thái của hôm qua và **không ai nhận ra** — bảng vẫn hiện, chỉ là sai. Nếu sau này buộc phải cache thì khoá **phải chứa `asOfDate`**.

### Ô trống và `NO_PLAN` được tách bằng kiểu dữ liệu

`SignboardCell` là kiểu hợp: `{ present: false }` **không có** trường `status`. Trộn hai khái niệm là lỗi biên dịch chứ không phải lỗi lúc chạy.

Kèm test khẳng định phép cộng luôn khớp: `Σ(theo trạng thái) + ô trống = số hàng × số cột`.

### Ba biên được kiểm riêng

| Biên | Kết quả |
|---|---|
| Đúng 30% Sub-task sai tiêu đề | **chưa** cảnh báo (`>` chứ không phải `>=`) |
| `TaskName` lạ xuất hiện 2 lần | **chưa** gợi ý thêm cột |
| Epic chưa có Sub-task nào | **không** cảnh báo — `0/0` không phải là 100% |

Ca cuối là ca dễ tuột nhất: một Epic vừa thêm vào sẽ hiện banner đỏ "hơn 30% Sub-task sai tiêu đề" trong khi nó chưa có Sub-task nào.

### Kiểu trả về khai tay, không lấy từ `z.infer`

zod sinh ra mảng sửa được, còn `SignboardCell` của engine khai `readonly`. Hai bên không khớp, và **`SignboardCell` mới là nguồn sự thật** — nó là thứ T-22 đã kiểm bằng 38 test. Schema zod vẫn giữ để frontend (T-31) kiểm dữ liệu tại biên.

### Chi tiết khác

- **Gộp hàng theo `functionKey`** (đã NFKC + chữ thường), tên hiển thị lấy theo lần gặp **đầu tiên**. Có test với `Login` / `login` / `Ｌｏｇｉｎ` — ba dạng, một hàng.
- **Cột "Tổng" chỉ tính các ô CÓ MẶT.** Function không có khâu đó thì việc thiếu nó không phải là chậm trễ.
- **`taskType` lạ không sinh cột mới** (C-10): cột là do người quyết định, không suy ra từ dữ liệu.
- **Hàng sắp theo tiếng Việt** (`localeCompare(…, 'vi')`) nên `Đăng nhập` đứng trước `Export`.
- **Một truy vấn cho cả bảng**, có test đếm.
