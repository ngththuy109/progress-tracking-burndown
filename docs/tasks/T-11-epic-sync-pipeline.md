---
id: T-11
title: Đồng bộ một Epic đầu-cuối — từ Jira vào database
status: review
model: opus
effort: high
depends_on: ["T-04", "T-05", "T-07", "T-08", "T-10"]
touches:
  - apps/worker/src/jobs/sync-epic.job.ts
  - apps/worker/src/pipeline/fetch-epic-tree.ts
  - apps/worker/src/pipeline/persist-issues.ts
  - packages/db/src/repositories/issue.repository.ts
  - packages/db/src/repositories/worklog.repository.ts
  - packages/db/src/repositories/changelog.repository.ts
  - packages/db/src/repositories/sync-run.repository.ts
  - apps/worker/src/test-fakes.ts                  # Jira giả ở tầng fetch
  - packages/jira/src/endpoints.ts                 # SỬA LỖI schema — xem "Đã làm gì"
  - packages/jira/src/endpoints.test.ts
prd_refs: ["§4.2", "§4.5", "E-03", "E-17"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-11 · Đồng bộ một Epic đầu-cuối — từ Jira vào database

## Mục tiêu
Chạy một lệnh là toàn bộ cây issue, worklog và changelog của một Epic nằm trong PostgreSQL, đã phân tách tiêu đề sẵn. Đây là cột mốc kết thúc GĐ 1 — mọi card GĐ 2 đọc dữ liệu từ đây.

## Ngữ cảnh cần biết

**Luồng theo PRD §4.2**, card này làm GIAI ĐOẠN 1–3:

```
GIAI ĐOẠN 1  Lấy cây issue      POST /search (parent = Epic) rồi (parent IN các Phase)
GIAI ĐOẠN 2  Worklog + changelog SONG SONG, tối đa 8 request cùng lúc
GIAI ĐOẠN 3  Phân tách tiêu đề  Task (T-07) và Sub-task (T-08), đặt sb_parse_status
```

GIAI ĐOẠN 4 (tổng hợp ngày Phase) và 5 (dựng lịch sử) do **T-15** và **T-18** làm.

**Vấn đề N+1** (PRD §4.5) — đây là lý do card này không tầm thường:

| Cách làm | Số lần gọi API | Thời gian |
|---|---|---|
| Tuần tự | ~1002 | ~200 giây |
| Song song 8 luồng + gộp lô | ~135 | ~18 giây |
| Đồng bộ tăng dần (ngày thường) | ~15 | ~4 giây |

**Ngày của worklog theo trường `started`, không phải `created`** (PRD E-03). Đây là mấu chốt để xử lý log giờ lùi ngày.

## Phạm vi

**Trong:**
- Lấy cây Epic → Task (Phase) → Sub-task qua 2 lần `POST /search`
- Lấy worklog + changelog song song, giới hạn 8 request đồng thời
- Đồng bộ tăng dần: chỉ tải issue có `updated >= watermark`
- Phân tách tiêu đề Task và Sub-task, ghi kết quả vào `jira_issue`
- UPSERT idempotent vào 4 bảng: `jira_issue`, `issue_changelog_event`, `worklog_entry`, `sync_run`
- Phát hiện worklog bị xoá, đặt `is_deleted = true`: đồng bộ tăng dần dùng `/worklog/deleted`; đọc lại toàn bộ **đối soát** tập worklog đầy đủ vừa lấy với các dòng trong DB (`/worklog/deleted` cần watermark nên không dùng được ở lượt full)
- Phát hiện log giờ lùi ngày (`started < created - 1 ngày`) → đẩy Epic vào `dirty:epics`
- Ghi `sync_run`: số lần gọi API, số lần 429, thời lượng, kết quả
- Cập nhật `tracked_epic.last_synced_at` và chuyển `BACKFILLING → ACTIVE`

**Ngoài:**
- Không tổng hợp ngày Phase (T-15 làm)
- Không dựng snapshot (T-17, T-18 làm)
- Không xử lý khoá Redis và heartbeat (T-18 làm)
- Không làm CRON scheduler (T-18 làm)

## Đầu vào đã có
- `packages/jira` client đầy đủ từ **T-03**
- `loadStatusIdMap()` từ **T-04**
- `resolveFieldMapping()`, `readWbsDates()` từ **T-05**
- `parseTaskTitle()` từ **T-07**
- `parseSubtaskTitle()` từ **T-08**
- `tracked_epic` repository và máy trạng thái từ **T-10**
- Bảng `jira_issue` đã có sẵn 6 cột kết quả phân tách từ T-02

## Việc phải làm

1. `fetch-epic-tree.ts`:
   - `POST /search` với `parent = "PAY-100"` → danh sách Task (Phase)
   - `POST /search` với `parent IN (...)` → danh sách Sub-task
   - **Luôn truyền `fields=`**, gồm cả 2 mã field `wbs_*` lấy từ T-05
2. Lấy worklog + changelog **song song** bằng `p-limit(8)`. Ưu tiên `/worklog/updated` + `/worklog/list` theo lô 1000 thay vì gọi từng issue.
3. **Đồng bộ tăng dần**: đọc `tracked_epic.last_synced_at`, thêm `AND updated >= "<watermark - 5 phút>"` vào JQL. Trừ lùi 5 phút để phòng lệch đồng hồ.
4. Phân tách tiêu đề:
   - Task → `parseTaskTitle` → `phase_code`, `raw_phase_label`
   - Sub-task → `parseSubtaskTitle(title, phaseCodeCủaTaskCha, config)` → 6 cột `sb_*`
   - **Sub-task lấy `phase_code` từ Task cha**, không lấy từ tiêu đề của chính nó
5. `persist-issues.ts` — UPSERT theo khoá tự nhiên:
   - `jira_issue` theo `issue_key`
   - `issue_changelog_event` theo `(issue_key, jira_history_id, field_name)`
   - `worklog_entry` theo `worklog_id`
   - Issue biến mất khỏi kết quả truy vấn → đặt `removed_at`, **không xoá cứng**
6. Đánh dấu worklog đã xoá bằng **hai đường**, tuỳ chế độ:
   - Tăng dần: `/worklog/deleted` từ watermark → đặt `is_deleted = true`.
   - Đọc lại toàn bộ (không có watermark, `/worklog/deleted` không dùng được): đối soát tập worklog **đầy đủ** vừa lấy với các dòng còn `is_deleted = false` trong DB — dòng nào không còn trên Jira thì đặt `is_deleted = true` (song song với `removed_at` cho issue). Thiếu bước này thì full resync không bao giờ gỡ được worklog đã xoá, và ngày bắt đầu/kết thúc **thực tế** (suy từ worklog) kẹt ở giá trị cũ.
7. Phát hiện log lùi ngày: query index `idx_worklog_retro`, có kết quả → `SADD dirty:epics`.
8. Ghi `sync_run` đủ các cột thống kê. Lỗi → `status = FAILED`, ghi `error_message`, chuyển Epic sang `ERROR`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — worklog tính theo trường `started`, **không** theo `created`. Mốc lưu UTC.
- **C-2** — thời lượng lưu bằng **giây**.
- **C-6** — mọi ghi dùng UPSERT theo khoá tự nhiên; chạy 2 lần phải cho kết quả byte-for-byte giống nhau.
- **C-7** — song song tối đa 8, luôn truyền `fields=`.
- **C-9** — log JSON có `correlationId`; lỗi dữ liệu ghi cảnh báo rồi chạy tiếp, không làm sập cả job.
- **C-11** — Sub-task `UNPARSED` **vẫn ghi vào DB đầy đủ**, chỉ gắn cờ.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- apps/worker` xanh (Testcontainers + Jira giả lập)
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Lấy dữ liệu:**
1. `lấy đủ cây Epic 3 Phase 25 Sub-task bằng đúng 2 lần gọi search`
2. `worklog và changelog được gọi song song, không quá 8 request đồng thời`
3. `đồng bộ tăng dần chỉ tải issue có updated mới hơn watermark`
4. `watermark bị trừ lùi 5 phút trong JQL`

**Phân tách:**
5. `Sub-task lấy phase_code từ Task cha, KHÔNG lấy từ [Phase] trong tiêu đề của nó`
6. `Sub-task sai format vẫn được ghi vào DB với sb_parse_status = UNPARSED`
7. `Sub-task sai format vẫn có đủ timeoriginalestimate để cộng dồn sau này`

**Idempotency:**
8. `chạy job 2 lần liên tiếp cho ra dữ liệu byte-for-byte giống nhau`
9. `worklog_id trùng không tạo dòng thứ hai`

**Xoá mềm:**
10. `issue biến mất khỏi Jira thì được đặt removed_at, KHÔNG bị xoá cứng`
11. `worklog bị xoá trên Jira thì is_deleted = true, dòng vẫn còn`

**Log lùi ngày:**
12. `worklog có started lùi 3 ngày so với created thì Epic bị đẩy vào dirty:epics`
13. `worklog bình thường KHÔNG đẩy Epic vào dirty:epics`

**Vòng đời và nhật ký:**
14. `đồng bộ xong chuyển Epic từ BACKFILLING sang ACTIVE`
15. `sync_run ghi đúng số lần gọi API và số lần bị 429`
16. `Jira lỗi liên tục thì sync_run = FAILED và Epic chuyển sang ERROR`

## Định nghĩa "xong"
Chạy job cho một Epic thật thì toàn bộ cây issue, worklog, changelog nằm trong PostgreSQL với tiêu đề đã phân tách; chạy lại lần hai không đổi một byte nào.

## Cạm bẫy đã biết
- **Cám dỗ: gọi worklog và changelog tuần tự cho từng Sub-task.** Code đơn giản hơn nhiều nhưng 500 Sub-task thành ~200 giây. Test 2 tồn tại để chặn việc này.
- **Sub-task phải lấy `phase_code` từ Task cha.** Tiêu đề Sub-task cũng có `[Phase]` và trông rất đáng dùng — nhưng quyết định đã chốt là Task cha thắng (PRD §2.9.2). Làm sai thì cộng dồn không khớp cây Jira và lỗi này im lặng.
- **Xoá cứng issue là mất lịch sử vĩnh viễn.** Luôn dùng `removed_at`. Snapshot của những ngày trước đó vẫn phải nhìn thấy issue này.
- **Epic bị xoá hẳn trên Jira thì JQL trả `400`, KHÔNG phải `404`.** `key = "X"` (và `parent = "X"`) tra một key đã xoá bị Jira Cloud trả `400 "An issue with key 'X' does not exist"`. 400 không thuộc diện thử lại nên job đổ ở `FETCH_TREE`, Epic kẹt ở ERROR, và mỗi lần Resync lại lặp đúng lỗi đó. `fetchEpicTree` bắt riêng lỗi này (`isIssueDoesNotExistError`) rồi trả cây rỗng `epicGone`; `syncEpic` xoá mềm **toàn bộ** issue của Epic (E-02, `liveKeys` rỗng) và kết thúc **THÀNH CÔNG** kèm cảnh báo `EPIC_DELETED_IN_JIRA`. Nhánh này **không đọc lịch sử**: issue con cũng đã biến mất nên `/issue/{key}/worklog` sẽ trả 404 và làm job đổ y như cũ.
- **Task/Sub-task bị xoá thì endpoint lịch sử theo key trả `404` (khác Epic).** Issue con đã xoá vẫn nằm trong DB với `removed_at` chưa gắn (chỉ gắn ở `markRemoved` — chạy *sau* bước lấy lịch sử), nên nó vẫn lọt vào `knownIdToKey`. Đọc `/issue/{key}/changelog`, `/worklog` của nó → `404` (không thử lại) → đổ cả lượt ở `FETCH_HISTORY` *trước khi* kịp gỡ. Hai lớp chặn: (1) chỉ bổ sung `knownIdToKey` cho issue **còn trong `liveKeys`** — không bao giờ gọi lịch sử cho issue đã biến mất, cũng khỏi tốn lời gọi 404 vô ích cho mọi issue đã gỡ từ lâu; (2) `fetchHistory` nuốt đúng `404` (`historyOrEmptyOn404`) phòng issue bị xoá **giữa chừng** — sống lúc lấy cây nhưng biến mất trước khi lấy lịch sử. `markRemoved` vẫn gỡ nó ở lượt kế tiếp.
- **Không trừ lùi watermark thì sẽ bỏ sót issue.** Đồng hồ Jira và đồng hồ hệ thống lệch nhau vài giây là bình thường; issue cập nhật đúng khoảnh khắc đó sẽ không bao giờ được tải về. Lỗi im lặng và rất khó tìm.
- **`/worklog/updated` phân trang theo `since`, không theo `startAt`.** Dùng nhầm sẽ lặp vô hạn.
- **`sync_run` phải ghi cả khi job thất bại.** Không có bản ghi thì người vận hành không biết job đã chạy hay chưa chạy.

## Đã làm gì

**29 test xanh** (card yêu cầu 16). Toàn workspace **228 test** xanh. `typecheck` · `lint` xanh. **Kết thúc GĐ 1.**

### Lỗi chặn phát hiện được: bẫy trường tên `toString`

`changelogItemSchema` (T-03) khai một trường tên đúng bằng **`toString`** — trùng với hàm có sẵn trên `Object.prototype`. Khi Jira **không** gửi trường đó, zod đọc `data['toString']`, nhặt phải **hàm kế thừa** rồi báo `Expected string, received function`, và làm hỏng việc parse của **cả trang changelog** chứ không riêng dòng đó.

Trong dữ liệu Jira thật thì phần lớn changelog item đều không có `toString`, nên **toàn bộ việc đồng bộ changelog sẽ hỏng** — mà changelog chính là nguồn dựng lại lịch sử của cả hệ thống.

Lỗi này chỉ lộ ra khi dữ liệu **thiếu** trường; mọi test dựng dữ liệu "đầy đủ" đều xanh. Nó xuất hiện đúng lúc tôi cho Jira giả trả về item không có `toString` — tức là gần với dữ liệu thật hơn.

Đã sửa bằng `z.preprocess` bỏ prototype (`Object.create(null)`). Lưu ý `{...obj}` **không cứu được**: bản sao vẫn mang `Object.prototype`. Thêm `endpoints.test.ts` với 5 test, gồm 2 test khẳng định việc bỏ prototype **không** làm mất khả năng kiểm tra kiểu.

### Sửa thiết kế: xoá mềm không hoạt động ở chế độ tăng dần

Bản đầu tôi chỉ chạy xoá mềm khi đồng bộ toàn bộ, vì ở chế độ tăng dần `liveKeys` chỉ chứa issue vừa đổi — coi phần còn lại là "đã biến mất" sẽ xoá mềm gần như cả Epic mỗi đêm.

Nhưng như vậy thì **sau lần backfill đầu tiên, mọi lần chạy đều là tăng dần**, nên issue gỡ khỏi Jira sẽ **không bao giờ** được đánh dấu. Test bắt được điều này.

Đã thêm **một lần quét chỉ lấy key** (không kèm bộ lọc `updated`) khi đồng bộ tăng dần. Chỉ lấy đúng một trường nên phản hồi rất nhẹ, đổi lại việc xoá mềm hoạt động đúng ở mọi lần chạy. Backfill vẫn đúng **2 lần search**; tăng dần là 3.

### Bốn quyết định

1. **Bộ lọc `updated >=` CHỈ áp cho tầng Sub-task.** Tầng Epic + Task là câu hỏi về *cấu trúc* — lọc ở đó thì một Task không đổi sẽ biến mất khỏi kết quả, kéo theo mọi Sub-task của nó không được truy vấn nữa. Lỗi hoàn toàn im lặng: job vẫn chạy xong, chỉ là thiếu dữ liệu. Số Phase chỉ vài cái nên lấy lại toàn bộ gần như không tốn gì.

2. **Không tự quản lý số luồng.** `JiraClient` đã chặn ở 8 request đồng thời cho *toàn hệ thống* (C-7). Thêm một bộ giới hạn nữa chỉ làm hai lớp chặn nhau và che mất giới hạn thật.

3. **Jira giả ở tầng `fetch`, không phải tầng client.** Nhờ vậy `JiraClient` **thật** vẫn chạy — giãn tốc độ, chặn song song, thử lại, và hai bộ đếm `apiCallsMade` / `rateLimitHits` đều là đồ thật. Giả ở tầng client sẽ bỏ qua đúng những thứ mà test 2 và test 15 cần kiểm chứng.

4. **`sync_run` ghi ngay từ đầu với trạng thái `RUNNING`.** Chỉ ghi lúc kết thúc thì job chết giữa chừng sẽ không để lại dấu vết, và người vận hành không phân biệt được "đã chạy và hỏng" với "chưa từng chạy".

### Một chỗ suýt sai

`/worklog/list` chỉ trả `issueId` (số), **không** trả `issueKey`. Bản đầu tôi lọc danh sách worklog theo `issueKey` — không bao giờ khớp, nên mọi worklog lấy theo lô sẽ **im lặng biến mất**. Đã đổi sang truyền bảng ánh xạ `issueId → issueKey`, ghép thêm cả issue đã có trong DB từ lần đồng bộ trước (chúng không nằm trong kết quả tăng dần nhưng worklog của chúng vẫn có thể vừa đổi).

### Một test của card đã sửa lại cho sát thực tế

Test *"issue xuất hiện lại"*: bản đầu tôi cho issue quay lại mà **không** đổi `updated`, nên đồng bộ tăng dần không tải nó về. Thực tế thì gắn Sub-task trở lại Epic **là** một thay đổi trên Jira và `updated` được đẩy lên mốc mới. Đã sửa dữ liệu test cho đúng, và ghi rõ giả định đó ngay trong test.
