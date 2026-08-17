# Runbook vận hành

**Ai đọc file này:** người đang trực và vừa nhận cảnh báo. Có thể là 2 giờ sáng.

**Cách dùng:** tìm mã cảnh báo trong Slack hoặc email, nhảy thẳng tới mục tương ứng. Không cần đọc từ đầu.

| Tài liệu khác | Dành cho ai |
|---|---|
| [ONBOARDING.md](./ONBOARDING.md) | Lập trình viên mới, ngày đầu vào dự án |
| [UAT-CHECKLIST.md](./UAT-CHECKLIST.md) | PM, buổi nghiệm thu |
| [AUTH.md](./AUTH.md) | Phân quyền: cấp Admin/PM/Viewer, gán PM vào project |

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
| 6 | **Vừa đổi Phase settings** mà Signboard / biểu đồ theo Phase chưa đổi | Bấm **Resync** ở màn hình Epic, chọn mức *Toàn bộ* — mức *Nhanh* không phân loại lại Sub-task cũ (xem quy trình 6) |
| 7 | **Đường Kế hoạch giảm đều qua thứ 7/CN hoặc tuần lễ Tết** | Biểu đồ có hiện cảnh báo 📅 không? Lịch của Epic chưa khai ngày lễ (hoặc Epic trỏ lịch không tồn tại). Xem quy trình 7 — Import ngày nghỉ |
| 8 | **Mất nguyên MỘT THỨ trong tuần** (ví dụ mọi Thứ 2 không có điểm) | `workdays_mask` của lịch sai quy ước bit. Biểu đồ và màn Days off đều hiện cảnh báo 📅. Xem mục *Lịch sai quy ước bit* bên dưới |
| 9 | Vẫn không ra | Gọi Tech Lead, kèm mã Epic và ngày |

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

**Deploy xong một màn hình cấu hình (Signboard columns / Phase settings) nổ `INTERNAL_ERROR`, hoặc `api.fatal` / `worker.fatal` ngay lúc khởi động với `PendingMigrationsError`.** Gần như luôn là **quên `pnpm db:migrate`**: mã mới truy vấn cột/bảng mà database chưa có (ví dụ thiếu cột `signboard_column.side`) → Postgres `42703` (undefined_column) / `42P01` (undefined_table) → route đổi thành 500 trên **từng** request. Message lỗi gốc có thể là **tiếng Nhật bị mojibake** nếu Postgres đặt `lc_messages=ja_JP` — dễ chẩn nhầm thành "lỗi encoding"; cứ nhìn **mã 42703/42P01** là biết thiếu schema. Từ nay khởi động **tự chặn** ca này: còn migration chưa áp thì API và worker **thoát ngay (exit 1)** kèm log nêu **đúng tên migration thiếu** và lệnh phải chạy. Sửa:

```bash
pnpm db:migrate    # áp mọi migration đang thiếu trên ĐÚNG DATABASE_URL của môi trường này
```

Kiểm chứng: khởi động lại, log có `api.ready`; mở lại màn hình là hết 500.

**Màn hình Phase settings / Signboard columns mở nhưng TRỐNG (chưa có bộ Mặc định).** Không còn lỗi 500: hai màn hình vẫn mở với bộ **RỖNG** để admin tự định nghĩa Phase và cột rồi Lưu (tạo bản Mặc định v1) — đó là **cách 3**. Muốn có sẵn bộ **khuyến nghị** (6 Phase + 29 luật + 5 cột), nạp bộ Mặc định theo thứ tự ưu tiên (cả hai idempotent):

```bash
pnpm db:seed                                              # cách 1 (khuyến nghị) — khi có Node
psql "$DATABASE_URL" -f tools/db/seed-default-config.sql  # cách 2 — khi chỉ có psql
```

Kiểm chứng: `curl -s localhost:3000/api/config/phase | jq '.globalVersion'` (0 = chưa có; > 0 = đã có). Chi tiết ba cách và vì sao (1) mạnh nhất: [ONBOARDING.md §3](./ONBOARDING.md).

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
| `Epic không tồn tại` / log `EPIC_DELETED_IN_JIRA` | Epic đã bị xoá trên Jira | Resync (hoặc job đêm) tự **xoá mềm** toàn bộ issue và **giữ nguyên** lịch sử — không còn kẹt ở ERROR. Bỏ theo dõi Epic nếu không cần giữ nữa |
| `timeout` / `ECONNRESET` | Jira chậm hoặc mạng chập chờn | Bấm **Run again** ở `/ops`; thường qua ngay |

**Khi nào gọi Tech Lead:** chạy lại hai lần vẫn hỏng với cùng một lỗi.

---

## [P1] `SNAPSHOT_MISSING` — Thiếu snapshot

**Triệu chứng.** Sau 02:00 mà vẫn còn ngày chưa có snapshot.

**Ảnh hưởng.** Khoảng thiếu trên biểu đồ **không được vẽ nét liền** — chỉ có nét
đứt mờ nối qua, kèm banner đỏ liệt kê đúng những ngày thiếu. Cố ý, không phải
lỗi hiển thị. Chỉ **ngày làm việc** mới bị đếm là thiếu: từ 2026-08 snapshot
được chốt cho cả ngày nghỉ (để giờ log cuối tuần hiện đúng ngày), nhưng ngày
nghỉ trống không phải lỗi và không kích hoạt cảnh báo này.

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

**Xử lý.** Việc của PM, không phải người trực: mở màn hình **Phase settings**, xem khu *Unrecognised*, thêm luật khớp. Không cần dev. Lưu xong, bấm **Resync** ở màn hình Epic, chọn mức *Toàn bộ* để Sub-task cũ được phân loại lại (xem quy trình 6).

---

## [P3] `MISSING_ESTIMATE` — Nhiều Sub-task thiếu ước lượng

**Triệu chứng.** Hơn 10% Sub-task không có Original Estimate.

**Ảnh hưởng.** Khối lượng trên biểu đồ **thấp hơn thực tế**.

**Xử lý.** PM nhờ đội điền ước lượng trên Jira. Hệ thống không tự đoán (rủi ro **R-02**).

---

## [P3] `MISSING_WBS_DATE` — Nhiều Sub-task thiếu ngày kế hoạch

**Triệu chứng.** Hơn 10% Sub-task thiếu `wbs_start_date` hoặc `wbs_end_date`.

**Ảnh hưởng.** Không so được sớm/trễ cho phần đó; ô Signboard hiện `No planned dates` (rủi ro **R-08**).

**Xử lý.** Mở màn hình **Monitoring** → khu *Data quality* → bảng *Planned dates*, bấm vào số ở cột **Missing dates** để xem danh sách cụ thể (kèm câu JQL và file CSV), gửi cho đội.

---

## [P3] `UNPARSED_SUBTASK` — Tiêu đề Sub-task chưa chuẩn

**Triệu chứng.** Hơn 30% Sub-task của một Phase có tiêu đề sai định dạng.

**Ảnh hưởng.** Chúng không lên được bảng Signboard, nhưng **vẫn được tính vào Burndown**.

**Xử lý.** Mở Signboard của Phase đó, xem khu *Not on the board*. Nếu cùng một loại task lạ xuất hiện nhiều lần, hệ thống gợi ý thêm cột — bấm là sang thẳng màn hình cấu hình.

---

## Lịch sai quy ước bit — mất nguyên một thứ trong tuần

**Triệu chứng.** Biểu đồ Burndown của Epic thiếu đúng MỘT thứ trong tuần, tuần
nào cũng vậy (ca thực tế đã gặp: mọi Thứ 2 biến mất, trong khi Chủ nhật lại có
điểm dữ liệu). Banner 📅 trên màn hình Biểu đồ và màn **Days off** nói thẳng
mask đang mô tả những ngày nào.

**Nguyên nhân.** Bản ghi `work_calendar` được sửa/thêm tay với `workdays_mask`
tính theo **số thứ tự ngày 1-indexed** (`T2=1<<1 … CN=1<<7`), trong khi hệ
thống đọc **bit 0 = Thứ 2 … bit 6 = CN** (quy ước luxon, xem
`packages/shared/src/calendar.ts`). Cả tuần trượt một ngày: muốn T2–T7 = 63 mà
ghi 126 thì máy hiểu là T3–CN.

Bảng quy đổi đúng: T2=1, T3=2, T4=4, T5=8, T6=16, T7=32, CN=64.
**T2–T6 = 31**, **T2–T7 = 63**.

**Hệ thống tự phòng thủ** (từ migration `20260811140000_workdays_mask_guard`):
- Lượt `pnpm db:migrate` đầu tiên **tự chữa** các giá trị 1-indexed đã biết
  (62→31, 126→63, 254→127).
- Hai CHECK constraint (`ck_workdays_mask_range`, `ck_workdays_mask_has_monday`)
  khiến database **từ chối** mask ngoài 1..127 hoặc thiếu Thứ 2 ngay lúc ghi —
  kể cả sửa tay bằng psql.
- Database chưa áp migration thì cảnh báo 📅 vẫn hiện trên biểu đồ và màn
  Days off (C-10) — lỗi không còn im lặng.

**Xử lý.** Chạy `pnpm db:migrate` (nếu chưa), rồi Bấm **Resync** ở màn hình
Epic để dựng bù snapshot cho những ngày từng bị mask sai loại khỏi lịch. Nếu
thật sự cần một lịch nghỉ Thứ 2, gỡ `ck_workdays_mask_has_monday` bằng một
migration mới kèm lý do (C-13) — đừng sửa migration cũ.

---

## Bảy quy trình vận hành thường dùng

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

### 2a. Bật đăng nhập LDAP (lần đầu)

Bật app tự đăng nhập bằng LDAP. Toàn bộ cấu hình nằm trên UI (bảng
`auth_ldap_config`), không sửa file. Chi tiết mô hình: xem [AUTH.md §1](./AUTH.md).

Nếu dùng **search-then-bind** (có tài khoản dịch vụ), đặt khoá mã hoá bind password
cho CẢ api lẫn worker trước — direct bind thì bỏ qua bước này:

```bash
# Sinh khoá 32 byte, đặt vào APP_ENCRYPTION_KEY rồi khởi động lại api + worker.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Sau đó, **vẫn đang ở chế độ header** (đăng nhập bằng cổng/dev như thường):

1. Đăng nhập bằng tài khoản **ADMIN**, vào **Admin → LDAP**.
2. Điền `Server URL` (`ldap://` hoặc `ldaps://`) và chọn một cách xác định user:
   - **Direct bind (template DN)** — `Template DN` chứa `{username}`, ví dụ
     `uid={username},ou=users,dc=cty,dc=vn` (hợp OpenLDAP).
   - **Direct bind + email lookup (Active Directory)** — bind bằng CHÍNH mật khẩu
     người dùng: `Template DN` kiểu `cty.com.vn\{username}` (hoặc UPN
     `{username}@cty.com.vn`), rồi khai `Search base` + `User filter` (vd
     `(cn={username})`) để app TỰ TRA email trên chính kết nối đó. KHÔNG cần tài
     khoản dịch vụ (bỏ trống Bind DN/password).
   - **Search then bind (Active Directory)** — `Bind DN` + `Bind password` tài khoản
     dịch vụ, `Search base`, và `User filter` chứa `{username}` (ví dụ
     `(sAMAccountName={username})` cho Active Directory).
3. Đặt `Email attribute` (mặc định `mail`) — danh tính trong hệ thống là email đọc
   từ thuộc tính này, phải khớp `user_id` trong `app_user`.
4. Bấm **Test** cho tới khi cả ba bước (CONNECT → BIND → SEARCH) đều xanh.
5. Tick **Enable LDAP login** rồi bấm **Save**. Server **từ chối bật** nếu Test
   chưa pass — không thể tự khoá mình bằng cấu hình hỏng.

> **Đừng tự khoá:** trước khi bật, bảo đảm CÓ ÍT NHẤT một ADMIN mà email khớp
> attribute email LDAP sẽ trả về (admin mồi `AUTH_BOOTSTRAP_ADMINS` hoặc dòng trong
> `app_user`). Ngay khi bật, header danh tính bị bỏ qua — chỉ đăng nhập bằng LDAP
> mới vào được. Lỡ hỏng thì khôi phục theo 2b.

### 2b. Bật LDAP xong bị khóa ngoài (cấu hình sai / LDAP server hỏng)

Server đã chặn trước phần lớn ca này (từ chối bật khi Test chưa pass), nhưng
LDAP server vẫn có thể hỏng SAU khi bật (đổi mật khẩu tài khoản dịch vụ, đổi
cấu trúc cây LDAP, server sập...). Khi không ai đăng nhập được nữa:

```bash
# 1. Tạm quay về đường header (dev/khôi phục):
AUTH_FORCE_HEADER=1   # đặt vào env của API rồi khởi động lại
# 2. Vào Admin → LDAP với header danh tính x-user-id=<email admin> (đặt qua
#    reverse proxy tạm, hoặc gọi API bằng curl -H). Sửa cấu hình, Test pass, Lưu.
# 3. BỎ AUTH_FORCE_HEADER đi và khởi động lại lần nữa.
```

`AUTH_FORCE_HEADER=1` chỉ dành cho khôi phục — để quên nó là mở lại đường
header vĩnh viễn ngay cả khi LDAP đang bật.

### 3. Tắt khẩn cấp việc gọi Jira

```bash
redis-cli SET killswitch:jira 1
```

Dùng khi Jira báo sắp chặn tổ chức. Worker dừng gọi ở vòng kế tiếp; job đang chạy vẫn hoàn tất.

### 4. Quay lại một version cấu hình

Làm trên giao diện: **Phase settings → tab History → Roll back to vN**.

Quay lại **không xoá** version mới hơn — nó tạo thêm một version nữa có nội dung giống bản cũ. Nhờ vậy quay lại nhầm cũng quay lại được lần nữa.

### 5. Cấp / gỡ quyền người dùng

Phân quyền (`ADMIN` / `PM` / `VIEWER`) nằm ở bảng `app_user`; PM chỉ gán được vào project đã đăng ký ở bảng `project`. Mô hình đầy đủ: [AUTH.md](./AUTH.md).

**Cách thường dùng — trên giao diện** (Admin đăng nhập): màn hình **Projects** để đăng ký project, màn hình **Users** để cấp Admin/PM/Viewer và tick project cho PM.

**Bằng dòng lệnh** (script/CI, hoặc khi chưa mở được app):

```bash
pnpm db:migrate                                               # tạo bảng app_user / project (lần đầu)
pnpm auth:grant --user pm@cty.com --role PM --projects PAY,CRM
pnpm auth:grant --user ai@cty.com --role VIEWER
```

- Admin **đầu tiên** cấp qua biến môi trường `AUTH_BOOTSTRAP_ADMINS` (không cần DB) — xem `.env.example`.
- PM chỉ nhận project **đã đăng ký**; chưa có thì đăng ký trước (màn hình Projects hoặc `INSERT INTO "project"`).
- Gỡ quyền: hạ về VIEWER bằng `pnpm auth:grant … --role VIEWER`, hoặc xoá dòng trong `app_user`.

### 6. Đổi cấu hình nhận diện Phase (và làm nó có hiệu lực)

Sửa luật làm trên giao diện: **Phase settings** → sửa mẫu tiêu đề / danh sách Phase / luật từ khoá → **Preview** (xem Task nào đổi phân loại và luật nào thắng) → **Confirm save**.

Lưu xong, các Epic bị ảnh hưởng được đánh dấu vào `dirty:epics`; **job quét mỗi giờ (phút 15) tự đẩy backfill toàn bộ** cho từng Epic đó — `phase_code` được phân loại lại theo cấu hình mới mà không cần thao tác gì thêm. Muốn thấy kết quả **ngay** (không đợi tới lượt quét): bấm **Resync** ở màn hình Epic cho từng Epic liên quan, chọn mức **Toàn bộ**.

> ⚠️ **Resync tay thì phải là mức *Toàn bộ*, không phải *Nhanh*.** Lượt tăng dần (mức *Nhanh*, và cả job đêm) chỉ đọc lại ticket vừa đổi trên Jira: tầng Task luôn được phân loại lại, nhưng **Sub-task không đổi thì giữ nguyên `phase_code` cũ** — Signboard và biểu đồ theo Phase (xếp nhóm theo `phase_code` lưu trên từng Sub-task) trông như "config không ăn". Vì sao như vậy: xem [PHASE-MAPPING.md](./PHASE-MAPPING.md).

Mất ~40 giây mỗi Epic, theo dõi ở `/ops`. Thông báo *"X Epics will be recomputed"* lúc lưu là số Epic đã được đánh dấu chờ quét; log của lượt quét (`dirty-sweep.done`) là chỗ xác nhận job backfill đã thật sự được đẩy (xem PHASE-MAPPING.md mục 7).

---

### 7. Import ngày nghỉ đầu năm (việc định kỳ MỖI NĂM, hai lịch)

**Khi nào:** đầu mỗi năm, ngay khi nhà nước công bố lịch nghỉ chính thức
(và mỗi khi có nghỉ bù phát sinh). Làm cho **cả hai lịch**: phía VN
(`VN_STANDARD` — người làm) và phía khách hàng (`JP_STANDARD` — người review).

**Cách làm — trên giao diện (cần quyền ADMIN):** màn hình **Days off** → chọn
tab lịch → chọn năm → dán danh sách (`YYYY-MM-DD, tên ngày lễ` — dán hai cột
từ Excel là được) hoặc nạp file CSV → xem preview (dòng sai được chỉ đích
danh, chưa ghi gì cả) → chọn chế độ:

- **Merge** — thêm/ghi đè các ngày trong danh sách, giữ nguyên ngày khác;
- **Replace all of {năm}** — xoá sạch năm đó rồi chèn lại (dùng khi import lại
  danh sách chính thức, tránh sót ngày đã bỏ).

**Điều gì xảy ra sau khi bấm Import:** cache biểu đồ của mọi Epic dùng lịch bị
xoá; Epic ACTIVE được đánh dấu `dirty:epics` — job quét mỗi giờ tự tính lại,
hoặc bấm **Resync** nếu muốn thấy ngay. Worker đọc lại lịch ở đầu mỗi job nên
**không cần restart** gì cả.

**Ngày làm bù (T-39):** cùng màn **Days off**, mục *Make-up workdays (làm bù)* —
khai những ngày Thứ 7/CN mà team **làm bù** cho một ngày nghỉ khác (hay gặp quanh
Tết). Import/xoá y hệt ngày lễ, cùng phân quyền và cùng lan truyền. Engine tính
ngày làm bù như **ngày làm việc bình thường** (đường Kế hoạch vẫn giảm) và biểu
đồ **KHÔNG bôi xám** ngày đó. Lỡ khai một ngày vừa là lễ vừa là làm bù thì **ngày
lễ thắng** (vẫn nghỉ).

**Nếu đường Kế hoạch vẫn sai sau khi import:** kiểm tra Epic đang trỏ lịch
nào (cột **Calendar** ở màn Epics — thấy `(unknown!)` là lịch rác, chọn lại
`VN_STANDARD`). Dữ liệu cũ từ trước T-38 sửa hàng loạt bằng:

```bash
psql "$DATABASE_URL" -f tools/db/fix-epic-calendar.sql
```

Liên quan: cột Signboard nào do phía JP làm (JMReview…) thì đặt **Side = JP**
ở màn **Signboard columns** — báo cáo "plan rơi vào ngày nghỉ" (màn Phase
sub-tasks và cột *On days off* trong khu *Data quality* của màn Monitoring)
dựa vào cờ đó để biết soi bằng lịch nào.

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
