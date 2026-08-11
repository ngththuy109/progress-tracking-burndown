---
id: T-30
title: Biểu đồ Burndown — ba chế độ xem và dấu mốc phát sinh
status: review
model: opus
effort: high
depends_on: ["T-20", "T-24", "T-25", "T-29"]
touches:
  - apps/web/src/routes/burndown/
  - apps/web/src/api/use-burndown.ts
  - apps/web/src/components/chart/
  - apps/web/e2e/burndown.spec.ts
  - apps/web/src/routes/app-routes.tsx
prd_refs: ["§5.1", "§5.2", "§4.3", "US-03", "US-04", "US-05", "US-11", "R-07", "R-11"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-30 · Biểu đồ Burndown — ba chế độ xem và dấu mốc phát sinh

## Mục tiêu
Màn hình chính của sản phẩm. PM nhìn một lần là biết Epic đang trễ hay không, trễ ở Phase nào, và **vì sao**.

## Ngữ cảnh cần biết

**Ba chế độ xem** (PRD §5.1):

| Chế độ | Hiện gì | Trả lời câu hỏi |
|---|---|---|
| Tổng Epic | 2 đường: Kế hoạch và Thực tế | Cả Epic đang thế nào? |
| Một Phase | 2 đường của riêng Phase đó | Phase này đang thế nào? |
| So sánh | Nhiều đường Thực tế chồng nhau | Phase nào đang kéo tụt cả Epic? |

> **Cập nhật 2026-08:** chế độ **So sánh** đã được GỠ khỏi giao diện — màn hình chỉ
> còn *Tổng Epic* và *Một Phase*. `ChartMode` trong hợp đồng API vẫn giữ `COMPARE`
> (backend không đổi). Cùng đợt này: vạch lưới mỗi ngày, đường Kế hoạch đậm hơn,
> ngày nghỉ lẻ giữa tuần hiện rõ dải xám, và ngày làm bù (T-39) không bị bôi xám.
> Chi tiết ở PRD Phụ lục C.6.

**Đổi Phase KHÔNG được tải lại trang.** T-17 đã tính sẵn đường Kế hoạch của từng Phase vào `per_phase` chính vì lý do này.

**Dấu mốc trên biểu đồ** — thứ biến biểu đồ từ "một đường cong" thành "một câu chuyện":

- **Phát sinh việc**: ngày có `scope_added_s > 0` → mũi tên đi lên, tooltip nói thêm bao nhiêu giờ và Sub-task nào
- **Dịch chuyển kế hoạch**: mốc trong `plan_shift_history` → cờ hiệu, tooltip nói mốc dời từ ngày nào sang ngày nào và ai gây ra (R-11)

**Đường Kế hoạch được vẽ lại sau mỗi lần đồng bộ**, kể cả phần lịch sử — đây là **thiết kế**, không phải lỗi (PRD §4.3.1). Màn hình phải nói điều này ra, nếu không PM sẽ tưởng hệ thống hỏng khi thấy điểm hôm qua đổi chỗ.

**Giải thích số liệu (R-07)** — bấm vào một điểm sẽ mở bảng chi tiết từ `GET /api/epics/:key/explain` (T-25): từng Sub-task, khối lượng còn lại và **quy tắc nào trong ba quy tắc** đã được áp dụng.

## Phạm vi

**Trong:**
- Ba chế độ xem, chuyển qua lại không tải lại dữ liệu
- Hai đường Kế hoạch / Thực tế, trục thời gian chỉ có **ngày làm việc**
- Dấu mốc phát sinh việc và dịch chuyển kế hoạch, có tooltip
- Bảng "giải thích số liệu" khi bấm vào một điểm
- Chọn khoảng thời gian
- Chú thích nói rõ đường Kế hoạch được vẽ lại liên tục
- Trạng thái rỗng: Epic chưa có snapshot nào

**Ngoài:**
- Không làm bảng Signboard (T-31)
- Không sửa API
- Không xuất PDF/ảnh

## Đầu vào đã có
- `GET /api/burndown/epic/:key` và `?phase=` từ **T-24**
- `GET /api/epics/:key/explain?date=` từ **T-25**
- `plan_shift_history` qua API của **T-25**
- Recharts đã có trong `apps/web` từ **T-01**

## Việc phải làm

1. `use-burndown.ts` — hook cho dữ liệu biểu đồ và cho phần giải thích. Dữ liệu **một lần cho cả Epic**, ba chế độ xem cùng dùng.
2. `components/chart/` — bọc Recharts lại thành component riêng của dự án. Component nghiệp vụ không được import Recharts trực tiếp: đổi thư viện biểu đồ sau này chỉ phải sửa một thư mục.
3. **Trục thời gian chỉ có ngày làm việc.** Trục theo ngày lịch sẽ tạo những đoạn nằm ngang giả vào mỗi cuối tuần, và biểu đồ trông như đội nghỉ giữa chừng.
4. Dấu mốc:
   - `scope_added_s > 0` → mũi tên lên, tooltip: *"Thêm 30 giờ · PAY-13, PAY-14"*
   - `plan_shift` → cờ hiệu, tooltip: *"Mốc kết thúc dời 04/03 → 10/03 (4 ngày làm việc) · do PAY-17"*
5. Bấm vào một điểm → mở bảng giải thích, mỗi dòng ghi rõ quy tắc 1, 2 hay 3 kèm câu tiếng Việt từ `explainRule()`.
6. Chế độ so sánh: mỗi Phase một màu lấy từ `colorHex` trong cấu hình; Phase không có màu thì lấy màu mặc định theo `displayOrder`.
7. Chú thích cố định dưới biểu đồ: *"Đường Kế hoạch được tính lại sau mỗi lần đồng bộ nên có thể đổi cả ở phần đã qua. Xem dấu ⚑ để biết mốc kế hoạch đã dời khi nào."*
8. Phase thiếu ngày kế hoạch → **không vẽ** đường Kế hoạch cho Phase đó, hiện chú thích nói rõ lý do (C-10).

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-2** — API trả **giây**; đổi sang giờ chỉ ở lớp hiển thị.
- **C-3** — file `kebab-case.tsx`.
- **C-9** — thông báo tiếng Việt.
- **C-10** — thiếu dữ liệu thì không vẽ, không đoán.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:web` xanh
- [ ] `pnpm e2e` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**E2E:**
1. `mở biểu đồ Epic thấy đủ hai đường Kế hoạch và Thực tế`
2. `đổi sang chế độ một Phase KHÔNG gọi lại API`
3. `chế độ so sánh hiện đúng một đường cho mỗi Phase`
4. `bấm vào một điểm mở bảng giải thích có ghi quy tắc đã áp dụng`
5. `ngày có phát sinh việc hiện dấu mốc, rê chuột thấy Sub-task nào gây ra`
6. `Epic chưa có snapshot hiện EmptyState nói rõ đang dựng lịch sử`

**Đơn vị:**
7. `trục thời gian không chứa thứ Bảy và Chủ nhật`
8. `Phase thiếu ngày kế hoạch thì KHÔNG vẽ đường Kế hoạch, có chú thích lý do`
9. `giây đổi sang giờ đúng, không làm tròn sai ở mốc 30 phút`
10. `chú thích về việc vẽ lại đường Kế hoạch luôn hiện, không phải bấm mới thấy`

## Định nghĩa "xong"
PM mở biểu đồ, thấy Epic đang trễ, chuyển sang chế độ so sánh để biết Phase nào gây ra, bấm vào điểm gãy để đọc lý do — không cần hỏi dev một câu nào.

## Cạm bẫy đã biết
- **Trục thời gian theo ngày lịch làm biểu đồ có bậc thang giả mỗi cuối tuần.** Chỉ vẽ ngày làm việc — dữ liệu từ T-18 vốn đã chỉ có ngày làm việc.
- **Đổi chế độ xem mà gọi lại API là hỏng mất công của T-17.** Dữ liệu từng Phase đã nằm sẵn trong `per_phase`.
- **Đường Kế hoạch đi LÊN không phải là lỗi.** Nó nghĩa là khối lượng vừa phình ra. Giấu đi bằng cách làm mượt đường sẽ xoá mất đúng thứ mà cả hệ thống sinh ra để phát hiện (R-11).
- **Không có dấu mốc thì biểu đồ chỉ là một đường cong.** Dấu mốc mới là thứ biến nó thành câu chuyện đọc được, và là câu trả lời cho R-07.
- **Đừng làm tròn ở tầng giao diện rồi cộng lại.** Cộng 5 Phase mỗi cái làm tròn 0,5 giờ sẽ lệch với tổng của Epic, và PM sẽ hỏi vì sao 3 + 3 = 7.
- **Recharts vẽ lại toàn bộ khi props đổi tham chiếu.** Nhớ `useMemo` cho mảng dữ liệu, nếu không biểu đồ giật mỗi lần rê chuột.

## Đã làm gì

**9 test E2E xanh** (card yêu cầu 10; hai test đơn vị về trục thời gian và làm tròn được gộp vào E2E vì chúng chỉ có nghĩa khi biểu đồ vẽ thật).

### Test quan trọng nhất là test ĐẾM SỐ LẦN GỌI API

> **"đổi sang chế độ một Phase KHÔNG gọi lại API"** — máy chủ giả đếm số lần gọi `/burndown/epic/...`, chuyển chế độ rồi đòi con số không đổi.

T-17 đã tính sẵn đường Kế hoạch của từng Phase vào `per_phase` **chính vì lý do này**. Gọi lại là hỏng mất công của card đó, mà nhìn màn hình thì không thấy gì khác biệt — đúng loại hồi quy chỉ có test đếm mới bắt được.

### Một lỗi của chính tôi, khá buồn cười

Tôi đặt hằng số `const URL = '/burndown?epic=PAY-1'` trong spec. Nó **che mất `URL` toàn cục** mà `installApi` đang dùng (`new URL(route.request().url())`), và **8 trên 9 test đỏ** với `TypeError: URL is not a constructor` — một thông báo chẳng liên quan gì tới thứ đang kiểm.

Đã đổi tên thành `PAGE` và ghi lý do ngay tại chỗ.

### Recharts bị bọc lại, và có hai lý do kỹ thuật ghi ngay trong file

1. **Kích thước cố định thay vì `ResponsiveContainer`.** Container đo kích thước phần tử cha lúc chạy; trong môi trường test kích thước đó bằng 0 nên biểu đồ **không vẽ gì cả** — test xanh mà màn hình trống.
2. **`connectNulls={false}`.** Ngày thiếu snapshot phải là lỗ thủng nhìn thấy được. Recharts mặc định cũng vậy, nhưng ghi tường minh để người sau không "sửa" cho đường liền mạch.

Component nghiệp vụ không import Recharts trực tiếp — đổi thư viện biểu đồ sau này chỉ phải sửa `components/chart/`.

### Chế độ so sánh KHÔNG vẽ đường Kế hoạch

Card không nói, nhưng bốn Phase × hai đường là **tám đường chồng nhau** và không ai đọc được. Chế độ so sánh trả lời câu hỏi *"Phase nào đang kéo tụt cả Epic"*, mà câu đó chỉ cần đường Thực tế. Có test khẳng định.

### Ba thứ được đưa lên màn hình chứ không giấu trong tooltip

- **Chú thích về đường Kế hoạch trôi** hiện cố định dưới biểu đồ, không phải rê chuột mới thấy (R-11).
- **Ngày thiếu snapshot** hiện thành khối cảnh báo đỏ liệt kê từng ngày, kèm câu *"KHÔNG được nối tắt"*.
- **Danh sách dấu mốc** hiện thành bảng dưới biểu đồ, vì cờ hiệu trên biểu đồ quá nhỏ để đọc và tooltip thì phải rê đúng chỗ mới thấy.

### Giải thích số liệu chỉ gọi API KHI bấm

`useExplainDay` có `enabled: date !== null`. Nạp sẵn cho cả 10 ngày là gọi thừa 10 request cho một thứ hiếm khi mở. Có test khẳng định số lần gọi bằng 0 trước khi bấm.

Phần `mismatch` (snapshot lệch số tính lại) hiện thành khối đỏ kèm câu *"bấm Đồng bộ lại ở màn hình Epic"* — đúng thứ runbook cần.

---

## Cập nhật sau bàn giao — 2026-08 (nhánh `claude/burndown-chart-missing-day`)

Ba điểm trong card này **không còn đúng** sau loạt chỉnh sửa theo yêu cầu người
dùng thực tế (PRD US-01 đã cập nhật kèm ghi chú cùng ngày):

- ~~"Trục thời gian chỉ có ngày làm việc"~~ → trục vẽ **đủ ngày lịch**; Thứ
  7/CN/ngày lễ nằm trong **dải xám** (`ReferenceArea`). Ngày nghỉ team có log
  giờ thì vẽ số thật y như ngày thường (worker nay chốt snapshot cho mọi ngày
  lịch); nghỉ thật thì kéo phẳng từ ngày liền trước, không chấm dữ liệu.
- Test cũ `trục thời gian không chứa thứ Bảy và Chủ nhật` đã thay bằng bộ test
  mới trong `burndown-chart.test.ts` (chèn ngày nghỉ, kéo phẳng, gom dải xám)
  và `burndown-chart.render.test.tsx` (đo hình học SVG của cầu nối).
- Cạm bẫy "trục theo ngày lịch tạo bậc thang giả" được giải bằng dải xám: đoạn
  nằm ngang qua ngày nghỉ giờ là **chủ đích có chú giải**, không phải hiểu nhầm.

Thêm mới cùng đợt: ngày làm việc thiếu snapshot được nối bằng **nét đứt mờ**
(đường chính vẫn đứt — nét liền chỉ dành cho số đo thật, E-12), và trục Tổng
Epic kéo tới ngày snapshot mới nhất khi Epic trễ hạn qua `plan_end`.
