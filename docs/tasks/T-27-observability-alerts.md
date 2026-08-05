---
id: T-27
title: Giám sát và cảnh báo — 11 ngưỡng, metrics và log lần vết được
status: review
model: sonnet
effort: high
depends_on: ["T-18", "T-23", "T-24", "T-26"]
touches:
  - packages/shared/src/alerts.ts
  - packages/engine/src/alerts/evaluate-thresholds.ts
  - packages/shared/src/metrics.ts
  - apps/worker/src/observability/observability.test.ts
  - packages/engine/src/alerts/evaluate-thresholds.test.ts
  - apps/worker/src/observability/alert-dispatcher.ts
  - apps/api/src/observability/http-metrics.ts
  - apps/api/src/routes/ops.routes.ts
prd_refs: ["§9.1", "§9.5", "§10.4", "R-08", "R-11"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-27 · Giám sát và cảnh báo — 11 ngưỡng, metrics và log lần vết được

## Mục tiêu
Biến 11 ngưỡng cảnh báo trong PRD thành thứ chạy được, và phát ra số đo để biết hệ thống có khoẻ không. Không có card này thì tiêu chí nghiệm thu của GĐ 3 — *"job đêm chạy ổn định 7 ngày liên tiếp"* và *"API đạt p95 ≤ 800ms"* — **không có cách nào kiểm chứng**.

## Ngữ cảnh cần biết

**11 ngưỡng cảnh báo** (PRD §10.4) — đây là bảng đầy đủ, không được bớt:

| # | Cảnh báo | Điều kiện | Mức | Gửi tới |
|---|---|---|---|---|
| 1 | Job đêm thất bại | `status = FAILED` sau 5 lần thử | P1 | Slack + email |
| 2 | Thiếu snapshot | Thiếu ≥ 1 ngày sau 02:00 | P1 | Slack |
| 3 | Bị 429 nhiều | > 10 lần trong 24 giờ | P2 | Slack |
| 4 | Dữ liệu lệch | Chênh > 0.5% khi đối soát | P2 | Slack + email |
| 5 | API chậm | p95 > 2 giây trong 10 phút | P2 | Slack |
| 6 | Kế hoạch bị lùi nhiều | Tổng ngày lùi của Phase > 20% độ dài (R-11) | P2 | Slack + email cho PM |
| 7 | Epic ở trạng thái lỗi | `status = 'ERROR'` quá 24 giờ | P2 | Slack |
| 8 | Dữ liệu bẩn | > 20% Task `UNCLASSIFIED` | P3 | Email cho PM |
| 9 | Thiếu ước lượng | > 10% Sub-task thiếu estimate | P3 | Banner trên UI |
| 10 | Thiếu ngày kế hoạch | > 10% Sub-task thiếu `wbs_*` (R-08) | P3 | Banner + email cho PM |
| 11 | Tiêu đề Sub-task chưa chuẩn | > 30% Sub-task một Phase có `sb_parse_status <> 'OK'` | P3 | Banner + email cho PM |

**Ba mức có ba đường đi khác nhau.** P1 gọi người dậy, P3 chỉ hiện banner. Trộn lẫn thì hoặc là làm phiền lúc nửa đêm vì chuyện không gấp, hoặc là bỏ sót chuyện gấp.

**Số đo bắt buộc** (PRD §9.5):

> Prometheus: thời lượng job, số lần 429, số ngày bị thiếu snapshot, độ trễ API.

**Log phải lần vết được** (C-9):

> Log dạng JSON có cấu trúc, kèm `correlationId` cho mỗi lần chạy job. Giữ 30 ngày.

`correlationId` phải đi **xuyên suốt**: từ request HTTP → job đẩy vào hàng đợi → job chạy trong worker → mọi lời gọi Jira. Đứt ở giữa thì không nối được một sự cố thành một câu chuyện.

**Cảnh báo sai còn tệ hơn không có cảnh báo.** Ngưỡng kêu liên tục sẽ bị tắt tiếng, và lúc có chuyện thật thì không ai đọc. Nên phải có **chống lặp**: cùng một cảnh báo cho cùng một Epic chỉ gửi lại sau một khoảng lặng.

## Phạm vi

**Trong:**
- Hàm thuần đánh giá cả 11 ngưỡng, trả về danh sách cảnh báo kèm mức
- Bộ phát cảnh báo: định tuyến theo mức (P1/P2 → Slack, P1/P2/P3 → email theo bảng), chống lặp
- Số đo Prometheus ở worker: thời lượng job, số lần 429, số ngày thiếu snapshot, số Epic `ERROR`
- Số đo ở API: độ trễ theo đường dẫn (histogram), tỉ lệ lỗi, tỉ lệ trúng cache
- `GET /metrics` và `GET /healthz` (kiểm tra Postgres + Redis)
- `correlationId` xuyên suốt request → hàng đợi → worker → Jira
- Cảnh báo P3 trả kèm trong API để frontend hiện banner (GĐ 4 dùng)

**Ngoài:**
- Không dựng dashboard Grafana (GĐ 4 / bàn giao vận hành)
- Không tự sửa lỗi — chỉ phát hiện và báo
- Không làm UI banner (card GĐ 4 làm, card này chỉ **cấp dữ liệu**)

## Đầu vào đã có
- `sync_run` (có `api_calls_made`, `rate_limit_hits`, `status`, `duration_ms`) từ **T-11**
- `tracked_epic.status` và `last_error` từ **T-10**
- `plan_shift_history` từ **T-15**
- Kết quả đối soát từ **T-26**
- `daily_snapshot` và danh sách ngày thiếu từ **T-18** / **T-24**
- Tỉ lệ dữ liệu bẩn tính được từ `jira_issue` (`phase_code`, `sb_parse_status`, `wbs_*`)
- Bộ log JSON của Fastify đã cấu hình `redact` ở [server.ts](../../apps/api/src/server.ts)

## Việc phải làm

1. `packages/shared/src/alerts.ts`:
   ```typescript
   export const ALERT_CODE = [
     'JOB_FAILED', 'SNAPSHOT_MISSING', 'RATE_LIMIT_HIGH', 'DATA_DRIFT',
     'API_SLOW', 'PLAN_SHIFT_HIGH', 'EPIC_STUCK_ERROR', 'DIRTY_PHASE_DATA',
     'MISSING_ESTIMATE', 'MISSING_WBS_DATE', 'UNPARSED_SUBTASK',
   ] as const;
   export const ALERT_LEVEL = ['P1', 'P2', 'P3'] as const;
   ```
   Đúng 11 mã, khớp một-một với bảng trên.

2. `packages/engine/src/alerts/evaluate-thresholds.ts` — **hàm thuần**, nhận số liệu đã nạp sẵn, trả danh sách cảnh báo. Ngưỡng là **hằng số có tên**, không phải số rải rác trong code:
   ```typescript
   export const THRESHOLDS = {
     RATE_LIMIT_PER_DAY: 10,
     DATA_DRIFT_RATIO: 0.005,
     API_P95_MS: 2000,
     PLAN_SHIFT_RATIO: 0.20,
     EPIC_ERROR_HOURS: 24,
     UNCLASSIFIED_RATIO: 0.20,
     MISSING_ESTIMATE_RATIO: 0.10,
     MISSING_WBS_RATIO: 0.10,
     UNPARSED_SUBTASK_RATIO: 0.30,
   } as const;
   ```
   Nằm ở `engine` nên **nhận "bây giờ" qua tham số `asOfDate`**, không đọc đồng hồ (ngưỡng 7 và 2 đều phụ thuộc thời điểm).

3. `alert-dispatcher.ts`:
   - Định tuyến theo đúng cột "Gửi tới" của bảng
   - **Chống lặp**: khoá Redis `alert:sent:{code}:{epicKey}` với TTL — P1 nhắc lại sau 1 giờ, P2 sau 6 giờ, P3 sau 24 giờ
   - Kênh gửi là **cổng** (`AlertChannel`), để test không cần Slack thật
   - Gửi thất bại **không được** làm sập job — ghi log rồi chạy tiếp

4. `metrics.ts` ở worker — Prometheus:
   | Số đo | Kiểu | Nhãn |
   |---|---|---|
   | `sync_job_duration_seconds` | Histogram | `epic_key`, `run_type`, `status` |
   | `jira_rate_limit_hits_total` | Counter | — |
   | `jira_api_calls_total` | Counter | — |
   | `snapshot_missing_days` | Gauge | `epic_key` |
   | `tracked_epics_by_status` | Gauge | `status` |

5. `http-metrics.ts` ở API — hook `onResponse` của Fastify ghi `http_request_duration_seconds` (Histogram, nhãn `route`, `method`, `status_code`) và `chart_cache_hits_total` / `chart_cache_misses_total`.

   **Nhãn `route` phải là mẫu đường dẫn** (`/api/burndown/epic/:epicKey`), **không phải đường dẫn thật**. Dùng đường dẫn thật thì mỗi Epic sinh một chuỗi số đo riêng và Prometheus sẽ nổ vì bùng nổ nhãn.

6. `ops.routes.ts`:
   - `GET /metrics` — định dạng Prometheus
   - `GET /healthz` — kiểm tra Postgres + Redis, trả 503 khi hỏng
   - `GET /api/epic/:epicKey/alerts` — cảnh báo P3 để frontend hiện banner

7. `correlationId` xuyên suốt: Fastify đã sinh sẵn (`genReqId`). Phải **truyền vào dữ liệu job** khi đẩy vào hàng đợi, và worker lấy ra dùng lại cho mọi log lẫn mọi lời gọi Jira của job đó.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-9** — log JSON có `correlationId`; **cấm ghi token vào log**; mã cảnh báo `SCREAMING_SNAKE`.
- **C-12** — `evaluate-thresholds.ts` là hàm thuần, **không đọc đồng hồ** (nhận `asOfDate`), không import `db` hay `jira`.
- **C-10** — không đoán bừa: thiếu số liệu đầu vào thì **không phát cảnh báo**, không mặc định là OK.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] `pnpm test -- apps/api apps/worker` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Đánh giá ngưỡng — đủ 11 mã:**
1. `mỗi mã trong ALERT_CODE đều có ít nhất một test kích hoạt được nó` — chống bỏ sót
2. `job FAILED sau 5 lần thử phát JOB_FAILED mức P1`
3. `thiếu 1 ngày snapshot sau 02:00 phát SNAPSHOT_MISSING mức P1`
4. `thiếu snapshot lúc 01:00 KHÔNG phát cảnh báo` — chưa tới mốc 02:00
5. `11 lần 429 trong 24 giờ phát RATE_LIMIT_HIGH, 10 lần thì không`
6. `Epic ERROR 25 giờ phát EPIC_STUCK_ERROR, 23 giờ thì không`
7. `Phase bị lùi 21% độ dài phát PLAN_SHIFT_HIGH`
8. `31% Sub-task UNPARSED phát UNPARSED_SUBTASK mức P3`
9. `ngưỡng đúng bằng giá trị biên KHÔNG kích hoạt` — dùng `>`, không phải `>=`
10. `hàm đánh giá không đọc đồng hồ` — cùng đầu vào và cùng asOfDate luôn cho cùng kết quả
11. `thiếu số liệu đầu vào thì KHÔNG phát cảnh báo, cũng KHÔNG coi là OK`

**Định tuyến và chống lặp:**
12. `P1 gửi cả Slack lẫn email; P3 chỉ gửi email cho PM`
13. `cùng một cảnh báo cho cùng Epic không gửi lại trong khoảng lặng`
14. `hết khoảng lặng thì cảnh báo được gửi lại`
15. `cảnh báo cho hai Epic khác nhau KHÔNG chặn nhau`
16. `gửi cảnh báo thất bại KHÔNG làm sập job`

**Số đo:**
17. `job chạy xong ghi sync_job_duration_seconds kèm nhãn status`
18. `nhãn route là MẪU đường dẫn, không phải đường dẫn thật` — chống bùng nổ nhãn
19. `trúng cache và trượt cache được đếm riêng`
20. `GET /metrics trả đúng định dạng Prometheus`
21. `GET /healthz trả 503 khi Redis chết`

**Lần vết:**
22. `correlationId của request được truyền vào dữ liệu job`
23. `log của worker dùng lại đúng correlationId đó`
24. `không có log nào chứa chuỗi token`

## Định nghĩa "xong"
Tắt Redis thì `/healthz` trả 503; để một Epic ở `ERROR` quá 24 giờ thì có cảnh báo P2 gửi đi đúng một lần chứ không lặp lại mỗi phút; và lần theo một `correlationId` trong log là dựng lại được toàn bộ đường đi của một lần đồng bộ, từ request tới lời gọi Jira cuối cùng.

## Cạm bẫy đã biết
- **Cảnh báo lặp liên tục sẽ bị tắt tiếng, và sau đó cảnh báo thật cũng không ai đọc.** Chống lặp không phải tính năng phụ — nó là điều kiện để hệ thống cảnh báo còn được tin. Đây là lý do test 13 tồn tại.
- **Bùng nổ nhãn Prometheus.** Dùng `epic_key` làm nhãn cho số đo HTTP, hoặc dùng đường dẫn thật thay vì mẫu, sẽ tạo hàng chục nghìn chuỗi số đo và làm sập Prometheus. Ở worker thì `epic_key` chấp nhận được (tối đa 50 Epic), ở API thì không.
- **Dùng `>=` thay vì `>` ở ngưỡng** làm cảnh báo kêu sớm một bậc. PRD viết "> 10 lần", nghĩa là 10 lần thì im. Nghe nhỏ nhặt, nhưng nó quyết định cảnh báo có bị coi là nhiễu hay không.
- **Thiếu số liệu bị coi là 0 rồi kết luận OK** là lỗi im lặng nguy hiểm nhất ở đây: Epic chưa từng đồng bộ sẽ có "0% dữ liệu bẩn" và trông hoàn hảo. Không có số liệu thì **không kết luận** (C-10).
- **`correlationId` đứt ở ranh giới hàng đợi** là chỗ hay hỏng nhất. Request sinh id, đẩy job, rồi worker tự sinh id mới — lúc điều tra sẽ không nối được hai nửa của cùng một sự cố.
- **Gửi cảnh báo đồng bộ trong đường chạy của job** khiến Slack chậm làm chậm cả job đêm, và Slack chết làm job chết. Phát cảnh báo phải tách rời và không được ném lỗi ra ngoài.
- **Hàm đánh giá ngưỡng đọc `new Date()`** sẽ làm test xanh hôm nay và đỏ tuần sau — đúng lý do `engine` bị lint chặn đọc đồng hồ.

## Đã làm gì

**33 test xanh** (15 cho đánh giá ngưỡng ở engine, 18 cho gửi cảnh báo và số đo).

### Test chống bỏ sót là test đáng giá nhất của card này

Một test duyệt **cả 11 mã** trong `ALERT_CODE`, kích hoạt từng cái, rồi so tập hợp thu được với danh sách gốc. Thêm mã mới mà quên viết nhánh đánh giá là đỏ ngay.

Không có nó thì bảng 11 ngưỡng của PRD rất dễ trở thành "10 ngưỡng cộng một dòng tài liệu" — và cái bị bỏ sót sẽ đúng là cái không ai nhớ.

### Chống bùng nổ nhãn được cài thành lỗi ném ra, không phải ghi chú

Card cảnh báo *"nhãn `route` phải là mẫu đường dẫn, không phải đường dẫn thật"*. Bộ số đo **đếm số tổ hợp nhãn** và ném `LabelExplosionError` khi vượt 200, kèm câu chỉ thẳng nguyên nhân thường gặp.

Cùng lý do đó, `sync_job_duration_seconds` **cố ý không gắn nhãn `epic_key`** — 50 Epic × 2 trạng thái × 3 loại job là 300 chuỗi số đo và con số ấy chỉ có tăng. Có test riêng khẳng định chuỗi `epic_key` không xuất hiện trong bản kết xuất.

### Không kéo thêm `prom-client`

Viết một bộ số đo tối giản (~150 dòng) thay vì thêm phụ thuộc. Lý do: định dạng text của Prometheus rất đơn giản, còn thứ **thật sự cần kiểm** là luật đặt nhãn — và không thư viện nào kiểm hộ được.

Đánh đổi đã ghi ngay trong file: không có histogram theo phân vị dựng sẵn, phải tự khai mốc. Hình dạng API bám sát `prom-client` để đổi sang nó sau này chỉ là việc thay lớp bọc.

### `MetricsRegistry` nằm ở `packages/shared`, không nằm ở worker

Card xếp nó vào `apps/worker/src/observability/metrics.ts`, nhưng **cả API lẫn worker đều phát số đo** và tên số đo phải khớp nhau tuyệt đối. Hai bên tự khai riêng thì sẽ có ngày `http_request_duration` và `http_request_duration_seconds` cùng tồn tại, và biểu đồ giám sát thiếu mất một nửa mà không ai để ý.

### Ba chi tiết dễ tuột

1. **Khoá chống lặp chứa CẢ mã lẫn Epic.** Thiếu phần Epic thì một Epic đang lỗi sẽ chặn cảnh báo của 49 Epic còn lại — sự cố lớn bị che sau sự cố nhỏ. Có test riêng.
2. **`SET NX EX` nguyên tử.** Hai worker cùng phát hiện một sự cố thì chỉ một cái gửi được. Đọc-rồi-ghi bằng hai lệnh sẽ để lọt cảnh báo trùng.
3. **Slack chết không làm sập job đêm.** Kênh gửi lỗi chỉ được ghi vào `failedChannels`; mất một thông báo còn hơn mất cả lượt chốt sổ.

### Ngưỡng dùng `>` chứ không phải `>=`

Có test cho cả ba mốc biên (dưới / đúng / trên) của ba ngưỡng khác nhau. Biên mập mờ khiến hai lần chạy trên cùng dữ liệu cho hai kết luận khác nhau, và người trực mất lòng tin vào toàn bộ hệ thống cảnh báo.

### Thiếu số liệu KHÔNG được coi là OK

`undefined` nghĩa là **chưa đo được**, khác hẳn 0. Hàm đánh giá không phát cảnh báo cho chỉ số chưa đo, và cũng không báo "bình thường" — báo bình thường trong khi chưa đo được gì là kiểu nói dối tệ nhất của một hệ thống giám sát (C-10). Việc phân biệt hai trạng thái đó thuộc về dashboard T-33.

### Chưa kiểm được ở đây

`GET /metrics` và `GET /healthz` đã viết nhưng chỉ chạy thật khi có PostgreSQL và Redis. Phần kiểm được bằng máy là bản kết xuất Prometheus (định dạng, nhãn, thoát ký tự) và luật định tuyến cảnh báo — tức toàn bộ phần có logic.
