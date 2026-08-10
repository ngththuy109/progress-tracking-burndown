# Nhận diện Phase — cơ chế mapping & thời điểm dữ liệu được cập nhật

> Tài liệu này là bản đồ **hiện trạng mã nguồn**: ticket lấy Phase từ đâu, kết quả
> lưu ở cột nào, và sau khi đổi Phase settings thì **bao lâu — và bằng thao tác
> nào** — các màn hình mới phản ánh. Quy tắc gốc nằm ở PRD §2.2 (nhận diện Phase)
> và §2.9 (tiêu đề Sub-task); thao tác từng bước nằm ở RUNBOOK quy trình 1 và 6.
>
> Dành cho: PM chỉnh luật phân loại, và người trực phải trả lời câu hỏi *"đổi
> Phase settings rồi mà sao Signboard chưa đổi?"*.

## 1. Ai có Phase, và Phase đến từ đâu

```
EPIC      → không có Phase (phase_code = NULL)
TASK      → suy ra TỪ TITLE của chính nó — nơi DUY NHẤT việc "mapping" xảy ra
SUB-TASK  → kế thừa 100% Phase của Task cha; title của nó KHÔNG có tiếng nói
```

Ba nguyên tắc đã chốt trong PRD, mã nguồn làm đúng như vậy:

- **TASK = PHASE** (§2.1) — mỗi Task con của Epic đại diện một giai đoạn.
- **Cây Jira là cấu trúc thật, tiêu đề chỉ là chữ** (§2.9.2) — Sub-task luôn lấy
  Phase của Task cha (`apps/worker/src/pipeline/persist-issues.ts`). Chữ `[Phase]`
  trong title Sub-task chỉ để **đối chiếu**: lệch với Phase cha thì ghi cảnh báo
  `PHASE_MISMATCH`, nhưng kết quả **vẫn theo cha**. Cha không xác định được
  (không tìm thấy, hoặc chính cha là `UNCLASSIFIED`) thì con là `UNCLASSIFIED`.
- **Toàn bộ quy tắc là cấu hình** (§2.2) — PM sửa qua màn hình **Phase settings**,
  không cần dev, không cần deploy. Mã cứng duy nhất: `UNCLASSIFIED`.

Việc parse title Sub-task vẫn tồn tại, nhưng để phục vụ **Signboard** (bóc
`{function}` và `{task}`), không phục vụ phân loại Phase.

## 2. Task: hai tầng mapping

Mã: `packages/engine/src/parser/parse-task-title.ts`.

```
Title Task: "[Phase] 基本設計"
     │
     ▼
┌─ TẦNG 1: MẪU TIÊU ĐỀ ──────────────────────────────────────────┐
│ Thử từng mẫu theo sort_order, TỪ TRÊN XUỐNG; mẫu đầu tiên      │
│ khớp thì DỪNG.   "[Phase] {name}" → bóc ra "基本設計"           │
│                                                                 │
│ Không mẫu nào khớp?                                             │
│   ☑ "tìm từ khoá trên toàn bộ tiêu đề" (mặc định BẬT)          │
│      → lấy CẢ TITLE làm chuỗi tìm kiếm cho tầng 2               │
│   ☐ nếu tắt → UNCLASSIFIED, dừng luôn                          │
└─────────────────────────────────────────────────────────────────┘
     │  "基本設計"
     ▼
┌─ TẦNG 2: LUẬT TỪ KHOÁ ─────────────────────────────────────────┐
│ Chuẩn hoá cả hai phía rồi so (CONTAINS hoặc REGEX):             │
│   "基本設計" chứa keyword "基本設計" → DESIGN ✓                 │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
phase_code = "DESIGN"
```

**Chuẩn hoá trước khi so** (áp cho cả title lẫn keyword — vì vậy không lo
hoa/thường hay chữ toàn giác):

| Bước | Việc làm | Ví dụ |
|---|---|---|
| 1 | NFKC | `ﾃｽﾄ` → `テスト`, `Ａ` → `A` |
| 2 | Về chữ thường | `Design` → `design` |
| 3 | Gộp khoảng trắng liên tiếp | `Thiết   kế` → `Thiết kế` |
| 4 | Cắt hai đầu | ` Design ` → `Design` |

**Không luật nào khớp** → Task mang `UNCLASSIFIED`; phần chữ đã bóc được lưu vào
`raw_phase_label` và hiện ở panel **Unmatched** của màn hình Phase settings — PM
nhìn vào đó biết cần thêm từ khoá gì, bấm *+ Add rule* là keyword được điền sẵn.

**Ví dụ thực tế:** muốn Task chứa `FUT_TestCase` thuộc Phase `FUT` — chỉ cần
(1) khai Phase `FUT` ở khu *Phase definitions*, (2) thêm luật
`FUT_TestCase / contains / FUT` ở khu *Keyword matching rules*. Không cần thêm
mẫu tiêu đề: title trần không khớp mẫu nào sẽ rơi xuống lưới an toàn "tìm trên
toàn bộ tiêu đề" và vẫn trúng.

## 3. Độ ưu tiên khi mapping — ba lớp xếp chồng

**Lớp A — chọn bộ cấu hình nào** (PRD §2.2.6, `packages/engine/src/config/merge-inheritance.ts`):

```
Bản ghi đè của PROJECT (version đang active)  >  bộ Mặc định GLOBAL
```

Các phần kế thừa **độc lập nhau** (mẫu tiêu đề, danh sách Phase, luật từ khoá…):
project ghi đè phần nào thì chỉ phần đó, phần còn lại vẫn theo Global.

**Lớp B — trong tầng 1 (mẫu tiêu đề):**

```
sort_order nhỏ → thử trước; MẪU ĐẦU TIÊN KHỚP THẮNG (dừng ngay)
```

**Lớp C — trong tầng 2 (luật từ khoá)** (PRD §2.2.3):

```
1. match_priority NHỎ hơn thắng            (10 thắng 50)
2. Bằng nhau → keyword DÀI hơn thắng       ("Design Review" thắng "Design";
                                            đo trên chuỗi ĐÃ chuẩn hoá)
3. Vẫn hoà mà trỏ hai Phase khác nhau → lấy luật đầu
   + cảnh báo AMBIGUOUS_PHASE_RULE để PM chỉnh lại
```

⚠️ `match_priority` (ưu tiên **khi khớp**) khác hẳn `display_order` (thứ tự
**hiển thị** trên biểu đồ) — hai trường độc lập, đừng lẫn.

## 4. Lưu trữ: cột nào giữ gì

Kết quả mapping nằm trên **bảng `jira_issue`**, ghi MỘT LẦN lúc đồng bộ:

| Cột | Giữ gì |
|---|---|
| `phase_code` | **Nguồn sự thật DUY NHẤT** về Phase của ticket. Task = kết quả parse; Sub-task = copy từ cha; Epic = NULL |
| `raw_phase_label` | Chữ bóc từ title Task khi **không** khớp luật nào — nuôi panel Unmatched |
| `sb_phase_raw` | Chữ `[Phase]` trong title Sub-task — **chỉ để đối chiếu**, không bao giờ dùng phân loại |

Quy tắc mapping nằm ở bộ bảng cấu hình có version (`phase_config_set` +
`phase_title_pattern`, `phase_match_rule`, `phase_definition`,
`subtask_title_pattern` — schema ở `packages/db/prisma/schema.prisma`).

**Mọi thứ phía sau chỉ ĐỌC `phase_code`, không parse lại:** `phase_rollup` gom
ngày kế hoạch theo Phase, `daily_snapshot.per_phase` giữ số liệu từng Phase mỗi
ngày, Signboard truy vấn Sub-task theo Phase, màn hình health đếm tỉ lệ
`UNCLASSIFIED` — tất cả từ đúng một cột này.

## 5. Mapping chạy khi nào — và bao lâu thì thay đổi cấu hình mới "ăn"

Mapping **chỉ** xảy ra ở giai đoạn 3 của luồng đồng bộ (`buildRecords` trong
`apps/worker/src/pipeline/persist-issues.ts`) — tức là lúc đọc dữ liệu từ Jira
về. Đọc biểu đồ / Signboard **không** parse lại.

Điểm quyết định tốc độ lan truyền nằm ở cách đọc cây issue
(`apps/worker/src/pipeline/fetch-epic-tree.ts`), cố ý tách hai tầng:

```
Tầng Epic + Task  → LUÔN đọc lại toàn bộ (không lọc updated)
                    → mọi Task được phân loại lại theo config mới ở MỌI lần sync
Tầng Sub-task     → lượt tăng dần CHỈ đọc sub-task có updated >= watermark
                    → sub-task không ai đụng trên Jira thì KHÔNG được ghi lại,
                      cột phase_code của nó giữ nguyên giá trị CŨ
```

Trong khi đó Signboard và biểu đồ theo Phase xếp nhóm theo `phase_code` **lưu
trên từng Sub-task** (`apps/api/src/adapters/signboard.adapters.ts`). Ghép hai
điều trên lại ra bảng lan truyền sau khi **Lưu Phase settings**:

| Đường cập nhật | Thời điểm | Task re-map? | Sub-task re-map? | Signboard đúng chưa? |
|---|---|---|---|---|
| Ngay khi Lưu | 0 giây | ✗ | ✗ | ✗ — chưa có gì đổi |
| **Job quét `dirty:epics`** (tự động sau khi Lưu) | **tối đa ~1 giờ** (phút 15 mỗi giờ) | ✓ | ✓ toàn bộ | **✓ hoàn chỉnh** |
| Job đêm 00:01 (tăng dần) | tối đa ~24h | ✓ | ✗ nếu sub-task không đổi trên Jira | ✗ phần lớn vẫn cũ |
| Resync mức *Nhanh* / *Một dải ngày* | ~4–10 giây | ✓ | ✗ (như job đêm) | ✗ |
| **Resync mức *Toàn bộ*** `{"full":true}` | **~40 giây/Epic** | ✓ | ✓ toàn bộ | **✓ hoàn chỉnh** |

> **Quy tắc vàng:**
> - Đổi **cấu hình nhận diện Phase** ⇒ không cần làm gì: job quét `dirty:epics`
>   tự backfill toàn bộ các Epic bị ảnh hưởng trong vòng một giờ (mục 7). Muốn
>   thấy **ngay** thì Resync mức **Toàn bộ** cho các Epic liên quan (RUNBOOK quy
>   trình 6). Riêng chờ job đêm **không** giải quyết được — nó là lượt tăng dần.
> - Đổi **ticket** hằng ngày trên Jira ⇒ không cần làm gì (job đêm tự xử lý);
>   muốn thấy ngay thì Resync mức *Nhanh* là đủ, vì ticket vừa đổi luôn được đọc lại.

Màn hình **Preview** của Phase settings là cách xem trước kết quả phân loại
Task theo cấu hình nháp **ngay lập tức, không cần chờ sync** — dùng nó để kiểm
chứng luật trước khi Lưu.

## 6. Cache — sau khi job chạy xong thì thấy ngay chưa?

- **Signboard**: truy vấn thẳng database, không cache → đúng ngay khi job ghi xong.
- **Biểu đồ Burndown**: có cache (~15 phút), nhưng job dựng lại chủ động xoá
  cache sau khi ghi (`invalidateChartCache` trong
  `apps/worker/src/jobs/reconstruct-epic.job.ts`) → cũng thấy ngay sau khi job xong.

## 7. Cơ chế tự động `dirty:epics` — cách hoạt động

Khi Lưu cấu hình, API đẩy key các Epic bị ảnh hưởng vào Redis set `dirty:epics`
(`apps/api/src/services/phase-config.service.ts`) và màn hình hiện *"X Epics
will be recomputed"*. Pipeline đồng bộ (worklog lùi ngày — E-03) và job dựng lại
(mất khoá — E-19) cũng ghi vào cùng set này.

Job quét `dirty-epics-sweep` (`apps/worker/src/jobs/dirty-epics-sweep.job.ts`,
nối dây ở `apps/worker/src/wire.ts`) chạy **mỗi giờ ở phút 15** (`DIRTY_SWEEP_CRON`
trong `apps/worker/src/main.ts`): nhặt toàn bộ Epic khỏi set (SPOP), bỏ Epic đã
gỡ khỏi sổ theo dõi, rồi đẩy mỗi Epic một job **backfill toàn bộ** (`{"full":true}`)
lên hàng đợi `backfill`. Phải là backfill chứ không phải chỉ dựng lại snapshot:
`phase_code` nằm trên dữ liệu thô và chỉ được gán lúc đọc Jira về (mục 5). Đẩy
job thất bại thì Epic được trả về set để lượt sau thử lại — yêu cầu tính lại
không bao giờ bị mất im lặng.

Kết quả: sau khi Lưu Phase settings, mọi màn hình phản ánh cấu hình mới **trong
vòng tối đa một giờ** mà không cần thao tác tay. Resync mức *Toàn bộ* thủ công
(RUNBOOK quy trình 6) vẫn là đường đi khi cần thấy ngay lập tức. Theo dõi qua
log: `dirty-sweep.done` (số Epic nhặt/đẩy), `dirty-sweep.enqueue-failed` (đẩy
thất bại, đã trả về set).

## Tệp mã nguồn tham chiếu

| Việc | Tệp |
|---|---|
| Parse title Task (2 tầng, ưu tiên, cảnh báo) | `packages/engine/src/parser/parse-task-title.ts` |
| Parse title Sub-task (Signboard; đối chiếu Phase) | `packages/engine/src/parser/parse-subtask-title.ts` |
| Chuẩn hoá chuỗi | `packages/engine/src/parser/normalize.ts` |
| Dịch mẫu `{name}` sang regex | `packages/engine/src/parser/compile-pattern.ts` |
| Gộp kế thừa GLOBAL/PROJECT | `packages/engine/src/config/merge-inheritance.ts` |
| Gán `phase_code` lúc đồng bộ (giai đoạn 3) | `apps/worker/src/pipeline/persist-issues.ts` |
| Đọc cây issue 2 tầng (chỗ quyết định lan truyền) | `apps/worker/src/pipeline/fetch-epic-tree.ts` |
| Dựng lại rollup + snapshot (giai đoạn 4–5) | `apps/worker/src/jobs/reconstruct-epic.job.ts` |
| Signboard truy vấn theo `phase_code` của Sub-task | `apps/api/src/adapters/signboard.adapters.ts` |
| Lưu config + đánh dấu `dirty:epics` | `apps/api/src/services/phase-config.service.ts` |
| Quét `dirty:epics` → đẩy backfill toàn bộ | `apps/worker/src/jobs/dirty-epics-sweep.job.ts` + `apps/worker/src/wire.ts` |
| Schema các bảng cấu hình & `jira_issue` | `packages/db/prisma/schema.prisma` |
