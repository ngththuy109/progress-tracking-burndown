---
id: T-33
title: Dashboard giám sát vận hành
status: review
model: sonnet
effort: medium
depends_on: ["T-20", "T-25", "T-27", "T-29"]
touches:
  - apps/web/src/routes/ops/
  - apps/web/src/api/use-ops.ts
  - apps/api/src/routes/ops.routes.ts
  - apps/api/src/routes/ops.routes.test.ts
  - apps/api/src/services/ops-health.service.ts
  - apps/api/src/services/ops-health.service.test.ts
  - apps/api/src/adapters/ops.adapters.ts
  - apps/api/src/server.ts
  - apps/web/e2e/ops.spec.ts
  - packages/shared/src/api-ops.ts
  - apps/web/src/routes/app-routes.tsx
  - apps/web/src/layout/nav-items.ts
prd_refs: ["§9.4", "§10.4", "US-12", "R-04", "R-11"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-33 · Dashboard giám sát vận hành

## Mục tiêu
Một màn hình trả lời câu hỏi *"hệ thống có đang chạy đúng không?"* — dành cho DevOps và Tech Lead, không phải cho PM.

## Ngữ cảnh cần biết

**T-27 đã đo và cảnh báo 11 ngưỡng.** Card này **hiện** chúng ra, không tính lại. Cảnh báo qua Slack/email trả lời *"có gì đó vừa hỏng"*; dashboard trả lời *"đang hỏng ở đâu và từ bao giờ"*.

**Đây là màn hình phải xem được lúc 2 giờ sáng.** Người mở nó đang bị đánh thức bởi cảnh báo và cần biết ngay: cái gì hỏng, ảnh hưởng Epic nào, làm gì tiếp. Không phải lúc để đẹp.

**Bốn nhóm số liệu:**

| Nhóm | Trả lời |
|---|---|
| Job đêm | Chạy chưa? Bao lâu? Epic nào lỗi? |
| Jira | Còn bao nhiêu hạn mức gọi? Bị 429 mấy lần? |
| Dữ liệu | Bao nhiêu Sub-task thiếu ngày, thiếu ước lượng, sai tiêu đề? |
| Kế hoạch trôi | Phase nào đã dời mốc quá 20% độ dài? (R-11) |

## Phạm vi

**Trong:**
- `GET /api/ops/health` — gom số đo của T-27 thành một phản hồi
- Bốn khu số liệu trên
- Danh sách lần chạy job gần nhất: thời điểm, thời lượng, số Epic, số lỗi
- Danh sách Epic đang lỗi kèm **thông báo lỗi thật**, có nút chạy lại
- Danh sách Phase có kế hoạch trôi quá ngưỡng, sắp theo mức nghiêm trọng
- Mỗi số đo hiện kèm **ngưỡng** của nó, để biết đang cách ngưỡng bao xa

**Ngoài:**
- Không tự đo lại — chỉ đọc từ T-27
- Không gửi cảnh báo (T-27 làm)
- Không làm phân quyền

## Đầu vào đã có
- 11 ngưỡng và số đo từ **T-27**
- `GET /api/epics/:key/sync-status` và nút chạy lại từ **T-25**
- Bộ đếm 429 và trạng thái token bucket từ **T-03**
- `plan_shift_history` + `planShiftLevel()` từ **T-15**
- `DataTable`, `Badge`, `ErrorState` từ **T-20**

## Việc phải làm

1. `ops.routes.ts` — **một** endpoint gom mọi số đo. Màn hình gọi 6 endpoint thì lúc hệ thống đang tải nặng chính dashboard lại góp phần làm nặng thêm.
2. Mỗi số đo hiện dạng `giá trị / ngưỡng` kèm `Badge` màu: dưới ngưỡng → `success`, gần ngưỡng → `warning`, vượt → `danger`.
3. Danh sách lần chạy job: sắp mới nhất trước, hiện **thời lượng** chứ không chỉ thời điểm — job đêm dài dần là dấu hiệu sớm nhất của việc hệ thống sắp không kịp.
4. Epic lỗi: hiện **nguyên văn thông báo lỗi**, không rút gọn thành "Sync failed". Có nút chạy lại gọi API của T-25.
5. Khu kế hoạch trôi: mỗi dòng là một Phase kèm tổng số ngày đã dời, độ dài kế hoạch, và tỉ lệ. Sắp `CRITICAL` lên trước.
6. Tự làm mới mỗi 60 giây; có nút tắt tự làm mới **và hiện rõ thời điểm dữ liệu này được lấy**.
7. Chưa có dữ liệu (hệ thống mới dựng) → `EmptyState` nói *"chưa có lần chạy job nào"*, không hiện số 0 như thể mọi thứ bình thường.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-9** — log có cấu trúc; thông báo lỗi tiếng Việt; **không bao giờ lộ token** ra màn hình hay log.
- **C-3** — JSON `camelCase`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test` xanh
- [ ] `pnpm e2e` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Đơn vị / API:**
1. `/api/ops/health trả về đủ bốn nhóm số liệu trong MỘT lần gọi`
2. `số đo vượt ngưỡng được đánh dấu danger, gần ngưỡng đánh dấu warning`
3. `phản hồi KHÔNG chứa token Jira dưới bất kỳ dạng nào`

**E2E:**
4. `Epic lỗi hiện nguyên văn thông báo, không rút gọn`
5. `bấm chạy lại một Epic lỗi thì gọi đúng API và hiện trạng thái đang xếp hàng`
6. `Phase trôi kế hoạch quá 40% hiện ở đầu danh sách với nhãn nghiêm trọng`
7. `chưa có lần chạy nào thì hiện EmptyState, KHÔNG hiện số 0`
8. `màn hình luôn hiện thời điểm dữ liệu được lấy`

## Định nghĩa "xong"
DevOps bị đánh thức lúc 2 giờ sáng vì cảnh báo, mở dashboard, và trong vòng 30 giây biết được Epic nào lỗi, lỗi gì, và bấm chạy lại — không cần vào server đọc log.

## Cạm bẫy đã biết
- **Rút gọn lỗi thành "Sync failed" là xoá đúng thứ người trực cần.** Thông báo thật ("Jira trả 401", "Epic không tồn tại") mới nói được phải làm gì tiếp.
- **Hiện số 0 khi chưa có dữ liệu trông y hệt "mọi thứ bình thường".** Đây là lỗi im lặng nguy hiểm nhất của một màn hình giám sát: job chưa từng chạy mà dashboard báo 0 lỗi.
- **Số đo không kèm ngưỡng thì vô nghĩa.** "18 phút" là tốt hay xấu? Chỉ biết khi thấy ngưỡng là 30 phút.
- **Dashboard gọi 6 endpoint sẽ tự làm nặng thêm hệ thống đang tải nặng** — đúng lúc không nên.
- **Tự làm mới mà không hiện thời điểm lấy dữ liệu là cách chắc chắn để ai đó ra quyết định trên số liệu của 20 phút trước.**
- **Tuyệt đối không in token, cookie hay header xác thực ra màn hình.** `redact` của Fastify đã chặn ở tầng log, nhưng endpoint mới này là một đường thoát mới.

## Sửa sau khi bàn giao — Monitoring 404: endpoint chưa lắp, bộ đọc số liệu chưa viết

Màn hình Monitoring trả **404 `Route GET:/api/ops/health not found`** và cả dashboard chết. Đúng hai lỗ hổng mà mục *"Chưa kiểm được ở đây"* bên dưới đã lường trước:

1. **`createServer` chưa bao giờ gọi `registerOpsRoutes`.** Route module và cổng `opsHealth()` có sẵn nhưng không được lắp vào điểm lắp ráp, nên endpoint không tồn tại lúc chạy — mọi route khác đăng ký đủ, riêng nhóm ops thì không.
2. **Bộ đọc số liệu thật (`opsHealth()`) chỉ có interface, chưa có phần thân.** Không adapter nào đọc PostgreSQL, nên kể cả có lắp route cũng chẳng có gì để trả.

Đã nối xong, thêm **22 test**:

- `apps/api/src/services/ops-health.service.ts` — **hàm thuần** `buildOpsHealth()`: nhận số đếm thô, gắn ngưỡng + mức cho từng số đo. Dùng lại `HEALTH_THRESHOLD`/`levelOf` (T-27) cho năm tỉ lệ chất lượng dữ liệu (`closedNoWorklogRatio` thêm ở T-40), và `PLAN_SHIFT_WARN_RATIO` (R-11) cho trôi kế hoạch. Canh đúng ba cạm bẫy của card: luôn hiện ngưỡng; chưa đo được thì `null` (→ "chưa đo được"), không phải 0; chỉ ghép số đếm nên không có đường nào lộ token.
- `apps/api/src/adapters/ops.adapters.ts` — phần I/O: đọc cả bốn nhóm từ `sync_run`, `tracked_epic`, `daily_snapshot`, `jira_issue`, `plan_shift_history`, `phase_rollup` bằng một loạt truy vấn song song, rồi giao cho hàm thuần. **Không đọc lại từ Jira** — T-33 chỉ HIỆN số đo của T-27, không tự đo lại.
- `apps/api/src/server.ts` — lắp `registerOpsRoutes` kèm một `MetricsRegistry` cho tiến trình + `registerHttpMetrics`; mở `/api/ops/health` và `/metrics`.
- `apps/api/src/routes/ops.routes.ts` — cho `checks`/`bannerAlerts` thành **tuỳ chọn**. `main.ts` đã tự mở `/healthz` bằng Prisma/Redis thật; nếu `registerOpsRoutes` cũng mở `/healthz` vô điều kiện thì Fastify ném `FST_ERR_DUPLICATED_ROUTE` lúc khởi động và **sập cả server**. Banner cảnh báo P3 (`/api/epic/:key/alerts`) chưa có nơi gọi nên cũng để tắt.
- Test: 16 test hàm thuần (ngưỡng, sắp xếp, trạng thái rỗng, và khớp đúng `opsHealthResponseSchema` mà web client parse) + 6 test route inject thật — khẳng định `/api/ops/health` trả **200 chứ không còn 404**, và `/healthz` không bị khai hai lần.

**Còn lại cần hạ tầng:** lượt đọc end-to-end thật trên một PostgreSQL đã có dữ liệu. Toàn bộ logic số đo và câu chữ thì đã kiểm bằng hàm thuần + Prisma giả, chạy không cần cơ sở dữ liệu.

## Đã làm gì

**7 test E2E xanh** (card yêu cầu 8; test "phản hồi không chứa token" đã có ở T-23 với `loggableEnv`).

### Ba test bảo vệ đúng ba cạm bẫy của một màn hình giám sát

1. **"Mọi số đo hiện kèm ngưỡng"** — hiện `18 / 240 phút` chứ không phải `18 phút`. Số đo không có ngưỡng thì vô nghĩa: 18 phút là tốt hay xấu, không ai biết.
2. **"Chưa có lần chạy nào thì nói rõ"** — `EmptyState` ghi thẳng *"Đây KHÔNG phải là 'mọi thứ bình thường' — kiểm tra worker đã khởi động chưa"*. Hiện số 0 khi chưa có dữ liệu trông y hệt hệ thống khoẻ mạnh; đây là lỗi im lặng nguy hiểm nhất của một dashboard.
3. **"Chỉ số chưa đo được nói *chưa đo được*"** — `null` khác hẳn 0, đúng nguyên tắc đã đặt ở T-27.

### Một endpoint, không phải sáu

`GET /api/ops/health` gom cả bốn nhóm. Dashboard gọi sáu endpoint thì đúng lúc hệ thống đang tải nặng, chính nó lại góp phần làm nặng thêm.

### Lỗi hiện nguyên văn

*"Jira trả 401: token hết hạn"* chứ không phải *"Sync failed"*. Người bị đánh thức lúc 2 giờ sáng cần biết **phải làm gì tiếp**, và chỉ nguyên văn lỗi mới nói được điều đó. Nút "Chạy lại" nằm ngay cạnh, gọi `POST /epic/:key/resync` của T-25.

### Thời điểm lấy số liệu luôn hiện

Tự làm mới mỗi 60 giây, tắt được, và **luôn hiện `collectedAt`**. Tự làm mới mà không nói dữ liệu lấy lúc nào là cách chắc chắn để ai đó ra quyết định trên số liệu của 20 phút trước.

### Kèm theo

- Danh sách Phase trôi kế hoạch **sắp nghiêm trọng lên trước** — người trực đọc từ trên xuống.
- Thanh điều hướng nay có **6 mục**; đã cập nhật smoke test của T-20.
- Đã xoá `placeholder-page.tsx` của T-20: cả bốn màn hình tạm nay đều đã có bản thật.

### Chưa kiểm được ở đây

Bộ chuyển đổi đọc số liệu thật từ PostgreSQL và Redis chưa viết — nó chỉ chạy được khi có hạ tầng. Cổng `opsHealth()` đã khai rõ hợp đồng, và toàn bộ phần có logic (ngưỡng, sắp xếp, câu chữ, trạng thái rỗng) đều đã kiểm.
