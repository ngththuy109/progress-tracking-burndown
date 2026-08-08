# Runbook vận hành

**Ai đọc file này:** người đang trực và vừa nhận cảnh báo. Có thể là 2 giờ sáng.

**Cách dùng:** tìm mã cảnh báo trong Slack hoặc email, nhảy thẳng tới mục tương ứng. Không cần đọc từ đầu.

| Tài liệu khác | Dành cho ai |
|---|---|
| [ONBOARDING.md](./ONBOARDING.md) | Lập trình viên mới, ngày đầu vào dự án |
| [UAT-CHECKLIST.md](./UAT-CHECKLIST.md) | PM, buổi nghiệm thu |

---

## Trước tiên: khi nào KHÔNG nên tự sửa

Người trực lúc nửa đêm có xu hướng thử mọi thứ. Ba việc dưới đây **làm hỏng dữ liệu**, và dọn lại mất cả ngày:

1. **Đừng chạy lại backfill trong lúc job đêm đang chạy.** Hai job cùng ghi một Epic sẽ tranh nhau khoá Redis; cái thua bị bỏ qua cả lượt. Xem `/ops` có lần chạy nào đang `RUNNING` không, chờ xong rồi mới bấm.
2. **Đừng sửa thẳng bảng `daily_snapshot` bằng SQL.** Snapshot là kết quả tính toán, không phải nguồn dữ liệu. Sửa tay xong lần đồng bộ sau sẽ ghi đè, và trong lúc đó số liệu mâu thuẫn với chính nó.
3. **Đừng xoá Epic để "làm sạch".** Bỏ theo dõi xoá toàn bộ lịch sử và không hoàn tác được. Muốn dừng đồng bộ thì dùng **Pause (keep data)**.

Không chắc thì gọi Tech Lead. Một cuộc gọi lúc 2 giờ sáng rẻ hơn một ngày dọn dữ liệu.

---

## Bảng tra nhanh: "số liệu trông sai"

PM báo số liệu sai — đây là thứ tự kiểm tra:

| Bước | Làm gì | Nếu thấy gì |
|---|---|---|
| 1 | Mở màn hình Biểu đồ của Epic đó, bấm vào **đúng ngày** PM nói sai | Bảng *Where the … number comes from* hiện ra |
| 2 | Xem cột **Rule** của từng Sub-task | Có dòng nào ghi **Rule 2** không? |
| 3 | Nếu có: đó là **nguyên nhân phổ biến nhất** | Ai đó sửa tay ô *Remaining Estimate* trên Jira; bảng hiện rõ **ai** và **lúc nào** |
| 4 | Xem khối **Stored number differs from the recomputed one** | Có nghĩa snapshot đã cũ — bấm **Resync** ở màn hình Epic |
| 5 | Ngày sai **cũ hơn 7 ngày** | Mức *Nhanh* chỉ dựng lại 7 ngày gần nhất. Bấm **Resync** rồi chọn mức *A specific date range* (xem quy trình 1) |
| 6 | Vẫn không ra | Gọi Tech Lead, kèm mã Epic và ngày |

Đây cũng là cách trả lời rủi ro **R-07** (PM không tin số liệu): không tranh luận, mở bảng giải thích ra.

---

## Trang hiện lỗi 500, hoặc API/worker không khởi động được

**Triệu chứng.** Mọi `/api/*` trả 500 rỗng, màn hình chỉ hiện **SERVER_ERROR** chung chung; hoặc `pnpm dev` chạy nhưng API **không bao giờ "ready"**.

**Nguyên nhân số một: Redis "treo".** Redis accept TCP nhưng **không trả lời lệnh nào** (thường do OOM / `maxmemory`, hoặc `BGSAVE` kẹt khi đĩa đầy). Bước nạp status map lúc khởi động gọi `redis.get()`; Redis không trả lời thì API **không bind được cổng 3000**, và Vite proxy trả 500 rỗng cho mọi `/api/*`.

**Kiểm tra ngay — API còn lắng nghe không:**

```bash
pnpm smoke
curl -s localhost:3000/healthz | jq      # treo hoặc "connection refused" = API chưa bind cổng
```

**Đọc log `api.fatal` / `worker.fatal`.** Từ nay khởi động **KHÔNG treo vô hạn**: quá `REDIS_READY_TIMEOUT_MS` (mặc định 10s) hoặc `BOOTSTRAP_TIMEOUT_MS` (mặc định 60s) thì tiến trình **thoát hẳn (exit 1)** kèm dòng log có `hint` chỉ thẳng nguyên nhân — để trình giám sát dựng lại thay vì để PID "sống mà không lắng nghe". Ba `hint` hay gặp:

| `hint` trong log | Nguyên nhân | Xử lý |
|---|---|---|
| "…Redis treo… `redis-cli … ping`" | Redis không phản hồi | Xem khối Redis bên dưới |
| "Cổng 3000 đang bận…" | Tiến trình API cũ chưa nhả cổng | `kill` tiến trình cũ rồi chạy lại |
| "…quá 60000ms…" (không nêu Redis) | DB / Jira / phụ thuộc khác treo | Kiểm DB qua `/healthz`, rồi tới Jira |

**Xác nhận & sửa Redis treo:**

```bash
redis-cli -u "$REDIS_URL" ping        # phải trả PONG NGAY; treo hơn 1 giây = Redis hỏng
```

Nếu lệnh trên **treo**: kill instance Redis đang treo rồi bật lại, sau đó khởi động lại API/worker (hoặc để trình giám sát tự làm):

```bash
redis-cli -u "$REDIS_URL" shutdown nosave   # hoặc kill PID Redis rồi khởi động lại dịch vụ Redis
```

Kiểm chứng: `redis-cli -u "$REDIS_URL" ping` trả `PONG`, rồi `curl -s localhost:3000/api/epics` trả JSON (ví dụ `{"epics":[]}`).

**Nếu trang vẫn 500 sau khi API đã ready:** nhiều khả năng **trình duyệt cache** bản 500 cũ qua Vite proxy. Thử **Ctrl+Shift+R** (hard refresh) hoặc mở cửa sổ ẩn danh.

**Môi trường khởi động chậm:** nới `REDIS_READY_TIMEOUT_MS` / `BOOTSTRAP_TIMEOUT_MS` — xem `.env.example`.

---

## [P1] `JOB_FAILED` — Job đêm thất bại

**Triệu chứng.** Slack và email báo Epic nào đó thất bại sau khi đã thử hết 5 lần.

**Ảnh hưởng.** Biểu đồ của Epic đó dừng ở số liệu hôm qua. Các Epic khác không bị ảnh hưởng.

**Kiểm tra ngay:**

```bash
pnpm smoke                                   # hệ thống còn sống không
curl -s localhost:3000/healthz | jq          # Postgres + Redis còn không
curl -s localhost:3000/api/epic/PAY-1/health | jq '.status, .lastError'
```

Bình thường `healthz` trả `{"status":"ok","components":{"postgres":"ok","redis":"ok"}}`.

**Ba nguyên nhân thường gặp:**

| Dấu hiệu trong `lastError` | Nguyên nhân | Cách xử lý |
|---|---|---|
| `401` hoặc `403` | Token Jira hết hạn hoặc bị thu hồi | Đổi token — xem quy trình bên dưới |
| `Epic không tồn tại` | Ai đó xoá hoặc đổi key Epic trên Jira | Bỏ theo dõi Epic đó |
| `timeout` / `ECONNRESET` | Jira chậm hoặc mạng chập chờn | Bấm **Run again** ở `/ops`; thường qua ngay |

**Khi nào gọi Tech Lead:** chạy lại hai lần vẫn hỏng với cùng một lỗi.

---

## [P1] `SNAPSHOT_MISSING` — Thiếu snapshot

**Triệu chứng.** Sau 02:00 mà vẫn còn ngày chưa có snapshot.

**Ảnh hưởng.** Biểu đồ có **lỗ thủng nhìn thấy được** — cố ý, không phải lỗi hiển thị.

**Kiểm tra ngay:**

```bash
curl -s localhost:3000/api/epic/PAY-1/health | jq '.missingSnapshotDays'
```

**Xử lý.** Bấm **Resync** ở màn hình Epic, hoặc:

```bash
curl -X POST localhost:3000/api/epic/PAY-1/resync -d '{"full":false}' -H 'content-type: application/json'
```

Không cần `{"full":true}` ở đây: lượt tăng dần **tự nới dải ngày** về tận ngày thiếu sớm nhất, nên lỗ thủng cũ hơn 7 ngày cũng được vá. Xem dòng log `rebuild.range` để biết nó đã nới tới đâu.

**Đừng làm gì.** Đừng chèn snapshot bằng SQL. Ngày thiếu là **triệu chứng cần nhìn thấy** rằng job đêm đang hỏng.

---

## [P2] `RATE_LIMIT_HIGH` — Bị Jira chặn nhiều lần

**Triệu chứng.** Hơn 10 lần bị Jira trả 429 trong 24 giờ.

**Ảnh hưởng.** Đồng bộ chậm dần. Nếu tiếp tục, Jira có thể chặn **cả tổ chức** (rủi ro R-04, mức "Rất cao").

**Kiểm tra ngay:**

```bash
curl -s localhost:3000/metrics | grep jira_rate_limit_hits_total
redis-cli GET ratelimit:jira:tokens        # bucket còn bao nhiêu token
```

**Nguyên nhân số một:** bộ giới hạn tốc độ đang dùng kho **in-memory** thay vì Redis. Khi đó mỗi worker tự giữ 40 request/giây riêng, bốn worker thành 160.

Kiểm tra: `redis-cli EXISTS ratelimit:jira:tokens` phải trả `1`. Trả `0` nghĩa là bucket không hề chạm Redis → **dừng worker ngay** và gọi Tech Lead.

**Tắt khẩn cấp việc gọi Jira:**

```bash
redis-cli SET killswitch:jira 1            # worker dừng gọi Jira ở vòng kế tiếp
redis-cli DEL killswitch:jira              # bật lại
```

---

## [P2] `DATA_DRIFT` — Dữ liệu lệch so với Jira

**Triệu chứng.** Job đối soát Chủ nhật thấy chênh hơn 0,5%.

**Ảnh hưởng.** Số liệu sai một cách **im lặng** — biểu đồ vẫn vẽ, vẫn hợp lý.

**Kiểm tra ngay:**

```bash
pnpm reconcile -- --epic=PAY-1             # in kết quả, KHÔNG tự sửa
```

Đọc cột loại lệch:

| Loại | Nghĩa | Thường do |
|---|---|---|
| `MISSING_IN_DB` | Jira có, ta không | Đồng bộ tăng dần bỏ sót |
| `MISSING_IN_JIRA` | Ta có, Jira không | Issue bị xoá hoặc chuyển Epic |
| `VALUE_DIFFERS` | Số khác nhau | Worklog bị xoá hoặc sửa |

**Xử lý.** Job đối soát **đã tự đẩy chạy bù**. Theo dõi lượt Chủ nhật sau; còn lệch thì gọi Tech Lead.

Muốn chạy bù ngay: `pnpm reconcile -- --epic=PAY-1 --fix`

---

## [P2] `API_SLOW` — API chậm

**Triệu chứng.** p95 vượt 2 giây trong 10 phút.

**Kiểm tra ngay:**

```bash
curl -s localhost:3000/metrics | grep -E 'http_request_duration_seconds|chart_cache'
```

Tính tỉ lệ trúng cache: `chart_cache_hits_total / (hits + misses)`. Dưới 50% là bất thường.

**Ba nguyên nhân thường gặp:**

1. **Redis chết** → cache trượt hết, mọi request chạm database. Kiểm `/healthz`.
2. **Vừa có người lưu cấu hình** → cache bị xoá sạch, vài phút đầu chậm là bình thường.
3. **Một Epic có quá nhiều snapshot** → xem `http_request_duration_seconds` theo nhãn `route`.

---

## [P2] `PLAN_SHIFT_HIGH` — Kế hoạch bị lùi nhiều

**Triệu chứng.** Tổng số ngày lùi của một Phase vượt 20% độ dài kế hoạch.

**Đây KHÔNG phải lỗi hệ thống.** Nó là tín hiệu nghiệp vụ: kế hoạch đang trôi và độ trễ bị hấp thụ âm thầm (rủi ro **R-11**).

**Kiểm tra:**

```bash
curl -s localhost:3000/api/epic/PAY-1/plan-shift-history | jq
```

**Xử lý.** Chuyển cho PM, không phải việc của người trực. Cảnh báo này gửi cả cho PM qua email.

---

## [P2] `EPIC_STUCK_ERROR` — Epic kẹt ở trạng thái lỗi

**Triệu chứng.** Một Epic ở `ERROR` quá 24 giờ.

**Kiểm tra ngay:** mở `/ops`, xem khu **Epics in error** — có nguyên văn lỗi và nút **Run again**.

**Xử lý.** Giống `JOB_FAILED`. Chạy lại vẫn hỏng thì tạm dừng Epic đó để nó khỏi kêu mỗi ngày, rồi tạo ticket điều tra.

---

## [P3] `DIRTY_PHASE_DATA` — Nhiều Task chưa phân loại

**Triệu chứng.** Hơn 20% Task rơi vào *Unclassified*.

**Ảnh hưởng.** Biểu đồ theo Phase thiếu dữ liệu. Biểu đồ tổng Epic **vẫn đúng**.

**Xử lý.** Việc của PM, không phải người trực: mở màn hình **Phase settings**, xem khu *Unrecognised*, thêm luật khớp. Không cần dev.

---

## [P3] `MISSING_ESTIMATE` — Nhiều Sub-task thiếu ước lượng

**Triệu chứng.** Hơn 10% Sub-task không có Original Estimate.

**Ảnh hưởng.** Khối lượng trên biểu đồ **thấp hơn thực tế**.

**Xử lý.** PM nhờ đội điền ước lượng trên Jira. Hệ thống không tự đoán (rủi ro **R-02**).

---

## [P3] `MISSING_WBS_DATE` — Nhiều Sub-task thiếu ngày kế hoạch

**Triệu chứng.** Hơn 10% Sub-task thiếu `wbs_start_date` hoặc `wbs_end_date`.

**Ảnh hưởng.** Không so được sớm/trễ cho phần đó; ô Signboard hiện `No planned dates` (rủi ro **R-08**).

**Xử lý.** Mở màn hình Epic, bấm vào số ở cột **Missing dates** để xem danh sách cụ thể, gửi cho đội.

---

## [P3] `UNPARSED_SUBTASK` — Tiêu đề Sub-task chưa chuẩn

**Triệu chứng.** Hơn 30% Sub-task của một Phase có tiêu đề sai định dạng.

**Ảnh hưởng.** Chúng không lên được bảng Signboard, nhưng **vẫn được tính vào Burndown**.

**Xử lý.** Mở Signboard của Phase đó, xem khu *Not on the board*. Nếu cùng một loại task lạ xuất hiện nhiều lần, hệ thống gợi ý thêm cột — bấm là sang thẳng màn hình cấu hình.

---

## Bốn quy trình vận hành thường dùng

### 1. Dựng lại lịch sử một Epic

**Cách thường dùng — trên giao diện.** Màn hình *Danh sách Epic* → nút **Resync** ở dòng Epic đó → chọn một trong ba mức. Đây là đường đi đủ cho gần như mọi trường hợp; không cần mở dòng lệnh.

**Bằng dòng lệnh**, khi cần chạy hàng loạt hoặc nối vào script:

```bash
curl -X POST localhost:3000/api/epic/PAY-1/resync \
     -H 'content-type: application/json' -d '{"full":true}'
```

Mất khoảng 40 giây mỗi Epic. Theo dõi ở `/ops`.

**Ba mức, chọn đúng mức mình cần:**

| Trên giao diện | Thân yêu cầu | Đọc lại Jira | Tính lại snapshot |
|---|---|---|---|
| *Nhanh* (mặc định) | `{"full":false}` hoặc để rỗng | chỉ phần đổi từ lần trước (~15 lần gọi) | 7 ngày gần nhất, **tự nới ra** nếu có ngày thiếu snapshot cũ hơn |
| *Toàn bộ* | `{"full":true}` | **toàn bộ** (~135 lần gọi) | từ ngày đầu tiên có dữ liệu tới hôm nay |
| *Một dải ngày* | `{"from":"2026-03-01","to":"2026-03-11"}` | chỉ phần đổi | đúng dải ngày đã gõ |

Vài lưu ý dễ vấp:

- `full` phải là `true` / `false`. Gõ `"true"` có nháy kép sẽ bị từ chối kèm thông báo — cố ý như vậy, vì ép kiểu ngầm sẽ biến cả `"false"` thành đúng.
- Ngày phải có dạng `YYYY-MM-DD`. `01/03/2026` bị chặn ngay ở API, không để job chết sau đó.
- `to` ở tương lai bị kẹp về hôm nay. Snapshot ghi số liệu **thực tế** của một ngày; dựng cho ngày chưa tới chỉ tạo ra bản sao của hôm nay.
- Epic chưa từng đồng bộ mà đòi `full` sẽ báo lỗi thay vì đoán bừa ngày bắt đầu. Thêm Epic ở màn hình danh sách trước, hoặc gõ kèm `from`.

Mỗi lượt chạy ghi một dòng log `rebuild.range` nói rõ nó dựng lại **từ ngày nào tới ngày nào và vì sao**:

```json
{"event":"rebuild.range","epicKey":"PAY-1","scope":"FULL","from":"2026-01-05","to":"2026-03-11","notes":[]}
```

Đây là chỗ tra đầu tiên khi ai đó báo "chạy đồng bộ lại rồi mà số vẫn cũ".

### 2. Đổi token Jira

Làm được **cả khi token cũ đã hết hạn** — hệ thống không cần token cũ để đổi:

```bash
# 1. Tạo token mới tại https://id.atlassian.com/manage-profile/security/api-tokens
# 2. Cập nhật biến môi trường JIRA_API_TOKEN
# 3. Khởi động lại worker (tắt sạch, chờ job đang chạy xong)
kill -TERM $(pgrep -f "@app/worker")
# 4. Kiểm chứng
pnpm smoke
```

Worker chờ tối đa 30 giây cho job đang chạy. Quá hạn nó thoát với mã khác 0 và ghi log rõ ràng.

### 3. Tắt khẩn cấp việc gọi Jira

```bash
redis-cli SET killswitch:jira 1
```

Dùng khi Jira báo sắp chặn tổ chức. Worker dừng gọi ở vòng kế tiếp; job đang chạy vẫn hoàn tất.

### 4. Quay lại một version cấu hình

Làm trên giao diện: **Phase settings → tab History → Roll back to vN**.

Quay lại **không xoá** version mới hơn — nó tạo thêm một version nữa có nội dung giống bản cũ. Nhờ vậy quay lại nhầm cũng quay lại được lần nữa.

---

## Bảng tra mã cảnh báo

| Mã | Mức | Gửi tới | Mục |
|---|---|---|---|
| `JOB_FAILED` | P1 | Slack + email | [↑](#p1-job_failed--job-đêm-thất-bại) |
| `SNAPSHOT_MISSING` | P1 | Slack | [↑](#p1-snapshot_missing--thiếu-snapshot) |
| `RATE_LIMIT_HIGH` | P2 | Slack | [↑](#p2-rate_limit_high--bị-jira-chặn-nhiều-lần) |
| `DATA_DRIFT` | P2 | Slack + email | [↑](#p2-data_drift--dữ-liệu-lệch-so-với-jira) |
| `API_SLOW` | P2 | Slack | [↑](#p2-api_slow--api-chậm) |
| `PLAN_SHIFT_HIGH` | P2 | Slack + email | [↑](#p2-plan_shift_high--kế-hoạch-bị-lùi-nhiều) |
| `EPIC_STUCK_ERROR` | P2 | Slack | [↑](#p2-epic_stuck_error--epic-kẹt-ở-trạng-thái-lỗi) |
| `DIRTY_PHASE_DATA` | P3 | Email cho PM | [↑](#p3-dirty_phase_data--nhiều-task-chưa-phân-loại) |
| `MISSING_ESTIMATE` | P3 | Banner | [↑](#p3-missing_estimate--nhiều-sub-task-thiếu-ước-lượng) |
| `MISSING_WBS_DATE` | P3 | Banner + email | [↑](#p3-missing_wbs_date--nhiều-sub-task-thiếu-ngày-kế-hoạch) |
| `UNPARSED_SUBTASK` | P3 | Banner + email | [↑](#p3-unparsed_subtask--tiêu-đề-sub-task-chưa-chuẩn) |
