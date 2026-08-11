---
id: T-24
title: API đọc biểu đồ Burndown — 3 chế độ xem và cache Redis
status: review
model: opus
effort: high
depends_on: ["T-17", "T-18"]
touches:
  - apps/api/src/routes/burndown.routes.ts
  - apps/api/src/routes/burndown.routes.test.ts
  - apps/api/src/services/burndown.service.ts
  - apps/api/src/adapters/chart-cache.ts
  - apps/api/src/adapters/burndown.adapters.ts
  - apps/api/src/server.ts
  - packages/db/src/repositories/snapshot-read.repository.ts
  - packages/shared/src/api-burndown.ts
prd_refs: ["§4.7", "§5.1", "§9.1", "Phụ lục B", "E-12", "R-11"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-24 · API đọc biểu đồ Burndown — 3 chế độ xem và cache Redis

## Mục tiêu
Trả dữ liệu vẽ biểu đồ cho frontend ở cả ba chế độ xem: Tổng Epic, một Phase, so sánh nhiều Phase. Đây là API mà toàn bộ màn hình biểu đồ GĐ 4 phụ thuộc vào.

## Ngữ cảnh cần biết

**API này KHÔNG BAO GIỜ tính lịch sử tại chỗ** (PRD §9.1). Đó chính là lý do đạt được mốc p95 ≤ 800ms:

| | Biểu đồ Burndown | Bảng Signboard |
|---|---|---|
| Tính lúc nào | **Trước**, trong job đêm | **Lúc đọc**, mỗi lần gọi API |
| Đọc từ đâu | `daily_snapshot` (đã tính sẵn) | `jira_issue` + hàm thuần |

> Card này chỉ **đọc** `daily_snapshot` rồi định dạng lại. Thấy mình đang gọi tới engine dựng lịch sử là đã đi sai hướng.

**Dữ liệu mọi Phase đã nằm sẵn trong `daily_snapshot.per_phase`** (PRD §5.1):

> Đổi Phase **không phải tải lại trang**. Nghĩa là ba chế độ xem đọc **cùng một tập snapshot**, chỉ khác cách bóc số ra.

**Trục ngang khác nhau theo chế độ:**

| Chế độ | Trục ngang |
|---|---|
| Tổng Epic | `MIN(plan_start)` → `MAX(plan_end)` của mọi Phase |
| Một Phase | Co lại đúng `plan_start` → `plan_end` của Phase đó |
| So sánh | Hợp của các Phase được chọn, **tối đa 4** |

**Đường Kế hoạch trôi theo dữ liệu Jira** — baseline đã bị bỏ (PRD §4.3). Phản hồi **bắt buộc** có `planIsFloating: true` và `planNote`, để frontend nói rõ với PM rằng đường Kế hoạch phản ánh kế hoạch **mới nhất**, không phải cam kết ban đầu. Đây là tuyến phòng thủ cho rủi ro **R-11**.

**Cache Redis** (PRD §4.7):

| Key | TTL |
|---|---|
| `chart:{epicKey}:{from}:{to}` | 15 phút |

> Xoá cache dùng `SCAN`, **không dùng `KEYS`**. Với vài chục nghìn key, một lệnh `KEYS` treo cả Redis vài trăm mili-giây — gồm cả token bucket giới hạn tốc độ Jira.

## Phạm vi

**Trong:** 3 endpoint theo PRD Phụ lục B

| Method | Đường dẫn |
|---|---|
| `GET` | `/api/burndown/epic/:epicKey?from=&to=` |
| `GET` | `/api/burndown/epic/:epicKey/phase/:phaseCode` |
| `GET` | `/api/burndown/epic/:epicKey/phases/compare?codes=DESIGN,DEVELOPMENT` |

Kèm: cache-aside, repository đọc snapshot, dấu mốc (`markers`), phần `dataHealth`.

**Ngoài:**
- Không tính snapshot (T-17, T-18 làm)
- Không làm API Signboard (card GĐ 4)
- Không làm biểu đồ (card GĐ 4)
- Không làm 4 endpoint vận hành (T-25 làm)

## Đầu vào đã có
- Bảng `daily_snapshot` với cột `per_phase` (JSON) từ **T-02**
- Snapshot thật do **T-18** ghi
- `phase_rollup` (ngày plan/actual từng Phase) từ **T-15**
- `plan_shift_history` từ **T-15**
- Mẫu lắp ráp cổng + bộ chuyển đổi của **T-09**: `apps/api/src/services/` dùng cổng, `apps/api/src/adapters/` biết Prisma và Redis
- `ApiError` và mẫu xử lý lỗi HTTP ở [phase-config.service.ts](../../apps/api/src/services/phase-config.service.ts)

## Việc phải làm

1. `packages/shared/src/api-burndown.ts` — zod schema cho phản hồi, **khớp đúng PRD Phụ lục B**. Frontend GĐ 4 đã đặc tả theo cấu trúc đó, đổi tên trường là hỏng card sau.

2. `snapshot-read.repository.ts` — một truy vấn duy nhất dùng index `idx_snapshot_chart`:
   ```sql
   SELECT ... FROM daily_snapshot
   WHERE epic_key = $1 AND snapshot_date BETWEEN $2 AND $3
   ORDER BY snapshot_date ASC
   ```

3. `burndown.service.ts` — **hàm thuần**, nhận danh sách snapshot đã nạp sẵn:
   - Chế độ **Tổng Epic**: đọc `planned_remaining_s` / `actual_remaining_s` ở mức Epic
   - Chế độ **một Phase**: bóc từ `per_phase[phaseCode]`
   - Chế độ **so sánh**: bóc nhiều Phase, mỗi Phase một chuỗi số riêng
   - Đổi giây sang **giờ** ở đúng biên này (C-2: trong hệ thống lưu bằng giây, chỉ đổi khi hiển thị)
   - `variance = plannedRemainingHours − actualRemainingHours`

4. Dấu mốc (`markers`):
   - `SCOPE_ADDED` / `SCOPE_REMOVED` — từ `scope_added_s` / `scope_removed_s` khác 0
   - `PLAN_SHIFTED` — từ `plan_shift_history`
   - `planShiftSummary` — tổng số ngày lùi, số lần, và `warningLevel` (`OK` / `WARN` / `CRITICAL`, ngưỡng 20% độ dài Phase theo R-11)

5. `dataHealth`:
   - `missingSnapshotDays` — so danh sách ngày làm việc với snapshot đã có (E-12). **Trả về mảng ngày cụ thể**, không phải một con số: PM cần biết thủng lỗ ở đâu.
   - `missingEstimateRatio`, `unclassifiedPhaseRatio`, `missingWbsDateRatio`

6. `chart-cache.ts` — cache-aside:
   - Khoá `chart:{epicKey}:{from}:{to}`, TTL 15 phút
   - Trượt cache → đọc DB → ghi cache → trả về
   - Xoá theo mẫu bằng `SCAN`, có `COUNT` hợp lý, lặp tới khi con trỏ về 0
   - Redis chết → **vẫn trả dữ liệu từ DB**, chỉ ghi cảnh báo. Cache là tối ưu, không phải điều kiện để chạy.

7. Phân quyền: người dùng chỉ xem được Epic thuộc project họ có quyền (PRD §9.3). Dùng lại `Principal` của T-09.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-2** — trong hệ thống lưu bằng **giây** (`_s`), chỉ đổi sang giờ ở biên hiển thị.
- **C-3** — JSON API dùng `camelCase`.
- **C-9** — log JSON có `correlationId`; mã lỗi `SCREAMING_SNAKE`.
- **C-10** — không đoán bừa: ngày thiếu snapshot thì **báo là thiếu**, tuyệt đối không nội suy nối hai điểm.
- Xoá cache dùng `SCAN`, **không dùng `KEYS`**.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- apps/api` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Ba chế độ xem:**
1. `chế độ Tổng Epic trả đủ chuỗi số từ MIN(plan_start) tới MAX(plan_end)`
2. `chế độ một Phase co trục ngang đúng plan_start → plan_end của Phase đó`
3. `chế độ một Phase chỉ lấy số từ per_phase, KHÔNG lấy số mức Epic`
4. `chế độ so sánh trả mỗi Phase một chuỗi số riêng`
5. `chế độ so sánh quá 4 Phase bị từ chối HTTP 400`
6. `phaseCode không tồn tại trong Epic trả HTTP 404`

**Không tính tại chỗ:**
7. `API chỉ chạy đúng MỘT truy vấn trên daily_snapshot` — đếm số truy vấn
8. `API KHÔNG gọi tới engine dựng lịch sử`

**Cache:**
9. `lần gọi thứ hai cùng tham số lấy từ cache, không chạm database`
10. `khoảng thời gian khác nhau tạo khoá cache khác nhau`
11. `snapshot được ghi lại thì cache chart:{epicKey}:* bị xoá`
12. `xoá cache dùng SCAN, KHÔNG gọi lệnh KEYS`
13. `Redis chết thì API vẫn trả dữ liệu từ database kèm cảnh báo` — không trả lỗi 500

**Đường Kế hoạch trôi:**
14. `phản hồi luôn có planIsFloating = true và planNote`
15. `planShiftSummary đếm đúng tổng số ngày bị lùi`
16. `Phase bị lùi quá 20% độ dài thì warningLevel = CRITICAL`

**Sức khoẻ dữ liệu:**
17. `thiếu snapshot ngày 12/03 thì missingSnapshotDays chứa đúng ngày đó`
18. `ngày thiếu KHÔNG bị nội suy` — chuỗi số phải có lỗ thủng, không nối tắt

**Dấu mốc và đơn vị:**
19. `scope_added_s khác 0 sinh dấu mốc SCOPE_ADDED`
20. `giá trị trả về là GIỜ, không phải giây`

**Phân quyền:**
21. `người dùng không có quyền trên project của Epic nhận HTTP 403`

## Định nghĩa "xong"
Gọi `GET /api/burndown/epic/PAY-100` trên một Epic đã có snapshot thì nhận đủ hai chuỗi số Kế hoạch/Thực tế, dấu mốc và tình trạng dữ liệu, trong dưới 800ms ở phân vị 95; gọi lại lần hai lấy từ cache; và ghi snapshot mới thì cache tự mất hiệu lực.

## Cạm bẫy đã biết
- **Nội suy ngày thiếu là lỗi nghiêm trọng nhất ở card này.** Vẽ đường nối tắt qua ngày trống trông "đẹp hơn" và không có test nào đỏ, nhưng PM sẽ đọc ra một tiến độ không có thật. Ngày thiếu phải là **lỗ thủng nhìn thấy được** cộng với `missingSnapshotDays` (E-12).
- **Tính lại lịch sử tại chỗ khi thiếu snapshot** là cám dỗ rất lớn — nó làm biểu đồ luôn đầy đủ. Nhưng nó phá mốc 800ms và giấu mất việc job đêm đang hỏng. Thiếu snapshot là **triệu chứng cần nhìn thấy**, không phải thứ để che đi.
- **`KEYS` khoá cả Redis.** Nó cũng khoá luôn token bucket giới hạn tốc độ Jira, nên một lần xoá cache có thể làm job đêm dính 429.
- **Cache không có phần khoảng thời gian trong khoá** sẽ trả nhầm dữ liệu khi người dùng đổi bộ lọc ngày. Lỗi im lặng: số liệu vẫn hợp lý, chỉ là của khoảng khác.
- **Đổi giây sang giờ ở nhiều chỗ khác nhau** sẽ có ngày lệch nhau. Đổi đúng một lần, ở biên trả về.
- **Coi Redis chết là lỗi 500** biến một tối ưu thành một phụ thuộc cứng. Cache trượt phải im lặng lùi về database.
- **Đừng đọc `per_phase` bằng cách cộng dồn các Phase lại để ra số mức Epic.** Sub-task `UNCLASSIFIED` không thuộc Phase nào nhưng **vẫn nằm trong tổng của Epic** (C-11) — cộng dồn sẽ ra số nhỏ hơn thực tế mà không ai nhận ra.

## Đã làm gì

**33 test xanh** (card yêu cầu 21), chạy qua `fastify.inject()` với cổng giả — không cần PostgreSQL lẫn Redis.

### Ba test đắt giá nhất

**"Chỉ chạy đúng MỘT truy vấn trên `daily_snapshot`"** — cổng giả đếm số lần gọi. Đây là cách duy nhất bằng máy để giữ lời hứa *"API này không bao giờ tính lịch sử tại chỗ"*. Ai đó thêm một vòng lặp gọi lại theo từng Phase là đỏ ngay.

**"Ngày thiếu là lỗ thủng `null`, tuyệt đối không nội suy"** — kèm một test nữa khẳng định trục vẫn đủ 10 điểm. Hai test phải đi cùng nhau: bỏ hẳn ngày thiếu đi cũng là một cách nội suy, chỉ khác là làm trục co lại và biểu đồ nhìn như liền mạch.

**"Xoá cache dùng `SCAN`, không dùng `KEYS`"** — Redis giả cài `SCAN` thật có con trỏ, còn phương thức `keys()` thì **ném lỗi ngay khi bị gọi**. Đây là cách chắc chắn hơn nhiều so với một dòng ghi chú: `KEYS` khoá cả Redis vài trăm mili-giây, khoá luôn token bucket giới hạn tốc độ Jira, nên một lần xoá cache có thể làm job đêm dính 429.

### Một chỗ tính lại theo hướng khác với card

Card ghi `planShiftSummary` là *"tổng số ngày lùi"*. Tôi **chỉ cộng phần lùi ra xa**, bỏ qua phần kéo sớm lên, và có test riêng cho việc đó.

Lý do: cộng cả hai chiều thì một Phase về sớm 4 ngày sẽ triệt tiêu một Phase trễ 4 ngày, tổng ra 0 và `warningLevel` báo `OK` — đúng lúc đang có Phase trễ. Đó là thứ **R-11 sinh ra để phát hiện**, không phải thứ để trung bình hoá.

### Chi tiết dễ tuột đã chặn

- **Khoá cache chứa cả khoảng thời gian VÀ chế độ xem.** Thiếu một trong hai thì đổi bộ lọc hoặc đổi Phase sẽ nhận lại dữ liệu cũ — số liệu vẫn trông hợp lý, chỉ là của thứ khác.
- **Epic chưa Phase nào có ngày kế hoạch trả HTTP 409** kèm câu nói rõ phải điền `wbs_start_date` trên Jira, thay vì trả một biểu đồ rỗng trông như hệ thống hỏng.
- **Chia cho 0 khi chưa có ngày kế hoạch** sẽ cho ra `Infinity` và mọi Epic mới đều bị báo `CRITICAL`. Có test riêng.
- **`0/0` trong `loadDataQualityRatios`** cho ra `NaN`, và `NaN` lọt qua JSON thành `null` ở tận màn hình. Epic chưa có Sub-task nào trả về 0.
- **`plannedRemainingS` của Phase giữ nguyên `null`** khi đọc cột JSON. Đổi thành 0 sẽ vẽ ra một đường Kế hoạch chạm đáy giả cho Phase thiếu ngày.

### Phân quyền

`VIEWER` xem được **mọi** Epic; chỉ `PM` mới bị giới hạn theo project. Đây là dữ liệu báo cáo tiến độ, không phải dữ liệu nhạy cảm — chặn `VIEWER` sẽ khiến vai trò đó gần như vô dụng.

### Chưa kiểm được ở đây

Mốc **p95 ≤ 800ms** cần PostgreSQL thật với vài chục nghìn dòng `daily_snapshot`. Phần kiểm được bằng máy ngay bây giờ là *"đúng một truy vấn"* — điều kiện cần để đạt mốc đó. Bài đo thật thuộc về T-27.

---

## Cập nhật sau bàn giao — 2026-08 (nhánh `claude/burndown-chart-missing-day`)

- Trục của phản hồi nay là **mọi ngày lịch** trong khoảng; mỗi điểm kèm cờ
  `isOffDay` (optional trong schema để cache cũ vẫn đọc được). Ngày nghỉ có
  snapshot mang số thật; chưa có thì `null` — API không bịa số, tầng hiển thị
  tự kéo phẳng.
- `missingSnapshotDays` chỉ đếm **ngày làm việc** và chỉ những ngày ≤ snapshot
  cuối cùng (ngày tương lai chưa tới không phải "thiếu").
- Chế độ Tổng Epic nới cận trên của trục tới `max(plan_end, ngày snapshot mới
  nhất)` — Epic trễ hạn không còn bị cắt mất những ngày gần nhất. Chế độ một
  Phase vẫn co đúng khoảng kế hoạch của Phase; `?from/?to` người gọi chỉ định
  luôn được tôn trọng.
