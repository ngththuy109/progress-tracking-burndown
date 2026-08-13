---
id: T-40
title: Cảnh báo task đã đóng nhưng chưa log giờ (Data quality)
status: review
model: opus
effort: medium
depends_on: ["T-13", "T-14", "T-27", "T-33"]
touches:
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

# T-40 · Cảnh báo task đã đóng nhưng chưa log giờ (Data quality)

## Mục tiêu
Cho PM thấy được — ở màn hình Giám sát, khu **Data quality** — những Sub-task đã
đóng mà **không có worklog nào**. Đây là tập task khiến đường Thực tế trông như bị
trễ, và là điểm mù mà engine không thể tự sửa.

## Ngữ cảnh cần biết

**Vì sao tập task này gây hiểu nhầm "trễ"** (nối tiếp thảo luận quanh PRD §4.3.2):
khối lượng còn lại của một Sub-task chỉ bị ép về 0 bởi **Quy tắc 1** khi status
vào nhóm `done` — tức đúng **thời điểm bấm đóng ticket**, không phải thời điểm làm
xong thật. Nếu ticket được đóng trễ hơn ngày làm thật, đường Thực tế giữ nguyên
phần dư ước lượng cho tới ngày bấm đóng rồi mới rơi thẳng đứng → biểu đồ đọc ra
thành "task về đích muộn".

**Vì sao KHÔNG sửa được bằng engine cho tập này:** một hướng sửa (tạm gọi "Quy tắc
1b") là backdate mốc về 0 về *ngày worklog cuối* — nhưng nó chỉ chạy được khi
**có worklog**. Task đóng mà chưa từng log giờ thì không có mốc nào để suy ra "làm
xong thật lúc nào" (đúng tinh thần C-10: không có dữ liệu thì không đoán). Với tập
này chỉ còn một việc làm được: **cho nó lộ ra** để PM nhắc đội log giờ, hoặc đóng
ticket đúng ngày. Đó là việc của card này.

**Quan hệ với các số đo Data quality sẵn có** (T-27/T-33): đây là số đo **thứ năm**,
dùng chung khung `HEALTH_THRESHOLD` → `levelOf` → `DATA_METRICS` với bốn số đo cũ,
nên tự xuất hiện ở cả `/api/ops/health` (dashboard) lẫn endpoint sức khoẻ per-Epic.

## Phạm vi

**Trong:**
- Cờ mỗi Sub-task: `status = done` **VÀ** `original_estimate_s > 0` **VÀ** không còn
  worklog nào `is_deleted = FALSE`.
- Số đo `closedNoWorklogRatio` (toàn cục + per-Epic) ở khu Data quality, kèm ngưỡng.
- Ticket dính cờ hiện trong bảng chi tiết + file CSV, tái dùng cơ chế **exempt**.

**Ngoài:**
- **KHÔNG** đổi ngữ nghĩa engine (Quy tắc 1/2/3 giữ nguyên) — "Quy tắc 1b" là quyết
  định sản phẩm riêng, cần PO chốt, không nằm trong card này.
- **KHÔNG** thêm push-alert ở worker (`evaluate-thresholds`) — đây là số đo
  data-quality hiển thị, không phải cảnh báo P1–P3 của T-27.
- Không đụng đường Burndown, đường Kế hoạch, Signboard.

## Đầu vào đã có
- `HEALTH_THRESHOLD` / `levelOf` / `HealthMetricName` — T-27, `packages/shared/src/api-epic-ops.ts`.
- Khung `DATA_METRICS` + `buildOpsHealth` + `dataQualityMetrics` — T-33, `ops-health.service.ts`.
- `loadHealthRatios` (per-Epic) — `packages/db/src/repositories/explain.repository.ts`.
- Cơ chế `dq_exempt` + danh sách `dataQualityIssues` — T-33, `ops.adapters.ts`.
- Bảng `worklog_entry` có index `idx_worklog_issue_started` trên `(issue_key, started_at)`.

## Việc phải làm
1. `HEALTH_THRESHOLD.closedNoWorklogRatio = { warn: 0.1, critical: 0.3 }` (cùng thang
   với `missingEstimateRatio`). `HealthMetricName` tự có thêm khoá.
2. `DQ_PROBLEMS += 'CLOSED_NO_WORKLOG'`; `PROBLEM_LABEL` thêm nhãn tiếng Anh.
3. Đếm bằng SQL ở **ba** query (`ops.adapters` toàn cục + per-Epic, `loadHealthRatios`):
   thêm cột `closed_no_worklog` bằng `COUNT(*) FILTER (... NOT EXISTS worklog còn sống)`.
4. Cờ per-ticket ở `dataQualityIssues`: thêm biểu thức vào SELECT **và** điều kiện OR
   vào WHERE (SQL không cho tham chiếu alias SELECT trong WHERE).
5. Câu chữ per-Epic ở `MESSAGE` (compiler ép, `Record<HealthMetricName>`).

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):
- **C-4** — nhận diện `done` qua `statusCategory`, **không** qua `status.name`.
- **C-10** — không đoán khi thiếu dữ liệu: task không worklog thì chỉ *báo*, không
  tự suy ngày; số đo khi chưa có Sub-task nào là `null`/UNKNOWN, không phải 0.
- **C-11** — worklog `is_deleted` không được tính là "có log".

## Checklist đầu ra
- [x] `pnpm typecheck` xanh
- [x] `pnpm lint` xanh
- [x] `pnpm test` xanh (1216 test)
- [x] SQL validate end-to-end trên PostgreSQL thật với 6 ca biên
- [x] Cập nhật `status: review` + `finished_at`

## Test phải viết
1. `task đóng + có ước lượng + không worklog → số đo tính vào, mức theo ngưỡng 0.1/0.3`
2. `chưa có Sub-task nào → closedNoWorklog là null/UNKNOWN, không phải 0/OK`
3. `mỗi Epic có bộ số đo riêng gồm cả closedNoWorklog` (đã phủ bởi test byEpic sẵn có)

Các ca ngữ nghĩa SQL (validate trực tiếp trên DB, không unit-test được vì cần Postgres):
`worklog chỉ còn bản đã xoá vẫn tính là "chưa log"`; `est = 0 rơi vào MISSING_ESTIMATE,
KHÔNG double-flag`; `đang làm (không done) không bị gắn cờ`; `ticket exempt bị loại
khỏi số đo nhưng vẫn hiện trong danh sách kèm cờ`.

## Định nghĩa "xong"
Một Sub-task đã đóng, ước lượng 8h, chưa log giờ nào thì hiện ở khu Data quality với
nhãn "Closed without logged work"; log bù giờ hoặc mở lại ticket rồi resync thì cờ
tự tắt ở lượt sau.

## Cạm bẫy đã biết
- **`original_estimate_s > 0` là cố ý, không phải thừa.** Nó loại (a) task 0 ước
  lượng — đã bị `MISSING_ESTIMATE` bắt, và không tạo "vách đá" trên đường Thực tế nên
  không thuộc diện này; và (b) `NULL` (vì `NULL > 0` là false). Bỏ điều kiện này thì
  một ticket dính hai cờ trùng ý nghĩa.
- **Mẫu số dùng THỐNG NHẤT = tổng Sub-task active**, không phải "số task đã done".
  Đổi mẫu số cho riêng một số đo sẽ khiến phần trăm trong cùng bảng không so được với
  nhau, và phải chế đặc biệt ở ba nơi tính ratio. Danh sách chi tiết vẫn liệt kê **đủ
  mọi** ticket dính cờ bất kể ratio, nên không giấu ca nào.
- **Điều kiện `NOT EXISTS` lặp ở SELECT và WHERE của `dataQualityIssues`** — bốn lỗi
  cũ cũng đang lặp đúng kiểu này; SQL không cho tham chiếu alias SELECT trong WHERE.
- **`dq_exempt` sống sót qua resync**: `upsertIssues` không đụng cột này, nên ticket
  đã đánh dấu "không cần sửa" không bị bật cảnh báo lại sau mỗi lượt đồng bộ.
- **Đây là số đo data-quality, KHÔNG phải AlertCode của T-27.** Đừng thêm vào
  `evaluate-thresholds`/dispatcher — hai enum khác nhau.

## Đã làm gì

Thêm số đo Data quality thứ năm `closedNoWorklogRatio` + loại lỗi `CLOSED_NO_WORKLOG`.
Tái dùng trọn khung sẵn có: chỉ cần thêm một khoá vào `HEALTH_THRESHOLD` là compiler
kéo theo (ép) mọi chỗ còn thiếu — `MESSAGE` per-Epic, `RawDataQualityRatios`,
`loadHealthRatios`, `PROBLEM_LABEL`. Web layer render generic nên tự hiện, chỉ thêm nhãn.

**SQL validate riêng:** ba query đếm + một query danh sách chi tiết được chạy trên một
PostgreSQL thật (dựng từ migration thật) với 6 ca biên — khẳng định `NOT EXISTS` +
`FILTER`, việc loại worklog đã xoá, việc tách khỏi `MISSING_ESTIMATE`, và việc exempt
chỉ ảnh hưởng số đo chứ không ảnh hưởng danh sách. Toàn bộ 1216 test unit vẫn xanh.

Không đổi ngữ nghĩa engine: đường Burndown giữ nguyên. Card này chỉ làm tập task "đóng
chay" **lộ ra**, phần còn lại (backdate hay không) là quyết định sản phẩm để ngỏ.
