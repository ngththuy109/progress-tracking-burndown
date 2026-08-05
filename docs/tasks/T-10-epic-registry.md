---
id: T-10
title: Sổ đăng ký Epic — vòng đời và 7 API quản lý
status: review
model: sonnet
effort: high
depends_on: ["T-02", "T-03"]
touches:
  - packages/db/src/repositories/tracked-epic.repository.ts
  - apps/api/src/routes/epics.routes.ts
  - apps/api/src/services/epic-registry.service.ts
  - packages/shared/src/tracked-epic.ts
  - apps/api/src/adapters/epic-registry.adapters.ts       # bộ chuyển đổi Prisma + Jira
  - packages/db/prisma/schema.prisma                      # THÊM 2 CỘT wbs_* — xem "Đã làm gì"
  - packages/db/prisma/migrations/20260803120000_add_wbs_dates/
  - docs/ARCHITECTURE.md                                  # nới ràng buộc api → jira
prd_refs: ["§2.6", "E-25", "E-26"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-10 · Sổ đăng ký Epic — vòng đời và 7 API quản lý

## Mục tiêu
PM thêm được Epic vào danh sách theo dõi, tạm dừng, đồng bộ lại, bỏ theo dõi. Bảng `tracked_epic` là **nguồn duy nhất** trả lời "job đêm phải chạy cho Epic nào" — không có card này thì T-11 và T-18 không biết chạy cho ai.

## Ngữ cảnh cần biết

**Hệ thống không tự động theo dõi mọi Epic** (PRD §2.6). PM phải chủ động thêm.

**Vòng đời 5 trạng thái** (PRD §2.6.1):

```
[*] → PENDING → BACKFILLING → ACTIVE ⇄ PAUSED
                     │           │
                     └→ ERROR ←──┘        (PM sửa xong → BACKFILLING)
```

| Trạng thái | Job đêm có chạy? |
|---|---|
| `PENDING` | Không |
| `BACKFILLING` | Không (job backfill đang chạy) |
| `ACTIVE` | **Có** |
| `PAUSED` | Không |
| `ERROR` | Không |

> **Job đêm chỉ lấy Epic có `status = 'ACTIVE'`.**

**Kiểm tra khi thêm** (PRD §2.6.3) — hộp thoại nhận nhiều key một lúc, báo kết quả từng key:

| Kiểm tra | Kết quả khi hỏng |
|---|---|
| Key tồn tại trên Jira | ❌ *"Không tìm thấy PAY-999"* |
| `issuetype` đúng là Epic | ❌ *"PAY-7 là Task, không phải Epic"* |
| Tài khoản dịch vụ có quyền đọc | ❌ *"Không có quyền đọc project HR"* |
| Chưa có trong danh sách | ⚠️ Bỏ qua, *"Đã theo dõi rồi"* |
| Có ít nhất 1 Task con | ⚠️ **Vẫn thêm**, cảnh báo *"Epic chưa có Phase nào"* |

**Bỏ theo dõi có 2 chế độ** (PRD §2.6.4): giữ dữ liệu lịch sử (mặc định) hoặc xoá sạch.

## Phạm vi

**Trong:** 7 endpoint theo PRD Phụ lục B

| Method | Đường dẫn |
|---|---|
| `POST` | `/api/epics/validate` |
| `POST` | `/api/epics` |
| `GET` | `/api/epics` |
| `GET` | `/api/epics/browse?project=KEY` |
| `PATCH` | `/api/epics/:epicKey` |
| `DELETE` | `/api/epics/:epicKey?purge=false` |
| `GET` | `/api/epics/:epicKey/missing-dates` |

Kèm repository và máy trạng thái vòng đời.

**Ngoài:**
- Không đồng bộ dữ liệu (T-11 làm) — card này chỉ **đẩy job**, không tự chạy
- Không dựng snapshot
- Không làm UI (card GĐ 4)

## Đầu vào đã có
- Bảng `tracked_epic` từ **T-02**
- `searchIssues()`, `getIssue()` từ **T-03**
- Enum `TrackedEpicStatus` từ T-02

## Việc phải làm

1. Repository CRUD `tracked_epic` + `listActiveEpics()` dùng đúng index `idx_tracked_active`.
2. **Máy trạng thái** — hàm thuần kiểm tra chuyển trạng thái hợp lệ:
   ```typescript
   const ALLOWED: Record<TrackedEpicStatus, TrackedEpicStatus[]> = {
     PENDING:     ['BACKFILLING', 'ERROR'],
     BACKFILLING: ['ACTIVE', 'ERROR'],
     ACTIVE:      ['PAUSED', 'ERROR'],
     PAUSED:      ['ACTIVE'],
     ERROR:       ['BACKFILLING'],
   };
   ```
   Chuyển sai → ném lỗi, không âm thầm cho qua.
3. `POST /validate` — nhận mảng key, chạy 5 kiểm tra trên, trả kết quả **từng key** kèm `reason` khi hỏng. Cấu trúc phản hồi đúng PRD Phụ lục B.
4. `POST /epics` — chỉ thêm các key hợp lệ, đặt `PENDING`, đẩy job backfill vào BullMQ. Nhận `timezone` và `calendarId` từ body.
5. `GET /epics` — danh sách kèm số Phase, số Sub-task, tổng giờ, `last_synced_at`, và **tình trạng dữ liệu** (số Sub-task thiếu `wbs_*`).
6. `GET /browse` — JQL `project = "X" AND issuetype = Epic AND statusCategory != Done ORDER BY created DESC` (PRD §2.5).
7. `PATCH /:epicKey` — đổi `status` (chỉ `PAUSED` ⇄ `ACTIVE`), `timezone`, `calendarId`, `note`.
8. `DELETE /:epicKey?purge=` — `purge=false` chỉ xoá khỏi `tracked_epic`; `purge=true` xoá toàn bộ dữ liệu liên quan.
9. `GET /missing-dates` — Sub-task thiếu `wbs_start_date`/`wbs_end_date`, phục vụ rủi ro **R-08**.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — `timezone` là chuỗi IANA (`Asia/Ho_Chi_Minh`), validate bằng luxon.
- **C-3** — JSON API `camelCase`.
- **C-4** — `GET /browse` lọc theo `statusCategory`, **không** theo `status.name`.
- **C-6** — thêm Epic đã tồn tại thì UPSERT/bỏ qua, không ném lỗi trùng khoá.
- **C-9** — lỗi dữ liệu không làm sập; Epic lỗi chuyển `ERROR` kèm `last_error`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- apps/api` xanh
- [ ] `pnpm test -- packages/db` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Kiểm tra khi thêm:**
1. `dán 4 key trong đó 1 Task, 1 đã theo dõi, 2 hợp lệ thì trả đúng kết quả từng dòng`
2. `key là Task chứ không phải Epic thì reason = NOT_AN_EPIC`
3. `key không tồn tại trên Jira thì reason = NOT_FOUND`
4. `không có quyền đọc project thì reason = NO_PERMISSION`
5. `Epic đã theo dõi thì reason = ALREADY_TRACKED và KHÔNG bị thêm lần hai`
6. `Epic không có Task con vẫn được thêm, kèm cảnh báo`

**Vòng đời:**
7. `thêm thành công đặt status = PENDING và đẩy job backfill`
8. `chuyển PENDING → ACTIVE trực tiếp bị từ chối` — phải qua BACKFILLING
9. `chuyển ACTIVE → PAUSED rồi PAUSED → ACTIVE đều hợp lệ`
10. `chuyển PAUSED → BACKFILLING bị từ chối`
11. `job đêm chỉ lấy Epic ACTIVE` — tạo 5 Epic đủ 5 trạng thái, `listActiveEpics()` trả đúng 1

**Bỏ theo dõi:**
12. `xoá với purge=false giữ nguyên daily_snapshot và worklog_entry`
13. `xoá với purge=true xoá sạch mọi dữ liệu của Epic đó`

**Khác:**
14. `GET /epics trả đúng số Sub-task thiếu wbs_* trong tình trạng dữ liệu`
15. `PATCH với timezone không hợp lệ bị từ chối HTTP 400`

## Định nghĩa "xong"
PM dán một danh sách key lẫn key sai thì nhận được kết quả kiểm tra từng dòng, các key hợp lệ được thêm và tự chạy backfill, và `listActiveEpics()` chỉ trả về Epic đang `ACTIVE`.

## Cạm bẫy đã biết
- **Đừng để `POST /epics` tự chạy đồng bộ luôn.** Backfill 6 tháng mất tới 5 phút, request sẽ timeout. Chỉ đẩy job rồi trả về ngay.
- **Máy trạng thái phải chặn thật, không chỉ là tài liệu.** Cho phép `PENDING → ACTIVE` sẽ có Epic vào job đêm khi chưa có lịch sử → biểu đồ thủng lỗ mà không rõ nguyên nhân.
- **`DELETE ?purge=true` là thao tác không hoàn tác được.** Phải bắt xác nhận bằng cách gõ lại key Epic (PRD §2.6.4), không chỉ một tham số query.
- **Epic bị xoá trên Jira thì chuyển `ERROR`, KHÔNG tự xoá khỏi `tracked_epic`** (E-26). Có thể chỉ là lỗi tạm thời hoặc đổi key — để PM quyết định.
- **`GET /browse` phải phân trang.** Project lớn có hàng trăm Epic; trả hết một lần sẽ chậm và tốn quota Jira.

## Đã làm gì

**29 test xanh** (card yêu cầu 15). 7 endpoint đầy đủ. `typecheck` · `lint` · toàn workspace (194 test) xanh.

### Lỗi chặn phát hiện được: schema thiếu hai cột `wbs_*`

`jira_issue` **không có** `wbs_start_date` và `wbs_end_date`. Bản migration đầu (T-02) bỏ sót. Không có hai cột này thì:

- không tính được `phase_rollup.plan_start/plan_end` = MIN/MAX của Sub-task (PRD §2.7) → **T-15 không làm được**
- không dựng được ô Signboard, vì mỗi ô hiện ngày kế hoạch của từng ticket (Phụ lục B) → **card GĐ 4 không làm được**
- không trả lời được `GET /epics/:epicKey/missing-dates` — **chính là endpoint số 9 của card này**

Đã thêm migration `20260803120000_add_wbs_dates` (kèm `ROLLBACK.sql` theo C-13) với **partial index** chỉ chứa những dòng đang thiếu ngày: trên dữ liệu sạch nó gần như rỗng nên không tốn gì, mà vẫn trả lời tức thì đúng lúc dữ liệu bẩn — là lúc PM cần tới nó.

### Nới ràng buộc `api → jira`, có điều kiện

ARCHITECTURE.md cấm `apps/api` import `@app/jira`. Nhưng `POST /epics/validate` và `GET /epics/browse` **bắt buộc** phải hỏi Jira ngay trong request: PM dán danh sách key và cần thấy kết quả từng dòng ngay, còn `browse` thì không có gì trong DB để đọc — đó đúng là những Epic **chưa** được theo dõi.

Lý do gốc của lệnh cấm là *không để việc dài hơi lọt vào đường request đồng bộ*, chứ không phải bản thân việc import. Hai endpoint này không vi phạm điều đó. Đã ghi vào ARCHITECTURE.md kèm **4 điều kiện** không được nới thêm — quan trọng nhất: **tầng service không được biết tới Jira**, nó chỉ nhìn thấy cổng `JiraEpicPort`, và chỉ đúng một file bộ chuyển đổi được import `@app/jira`.

### Ba quyết định

1. **`lookup` dùng đúng 3 lần `/search` bất kể 1 hay 100 key.** Gọi từng key một sẽ là 100 request cho một hộp thoại — đúng vấn đề N+1 mà PRD §4.5 cảnh báo, chỉ ở chỗ khác.

2. **`purge=true` đòi gõ lại đúng key Epic**, không chỉ tham số `?purge=true`. Một query param quá dễ bấm nhầm cho thao tác xoá sạch lịch sử không hoàn tác được. Có 2 test cho ca chặn (thiếu xác nhận, và xác nhận sai key), cả hai đều khẳng định **không xoá gì**.

3. **Kiểm tra "đã theo dõi" TRƯỚC khi tra Jira.** Thông tin đó hữu ích hơn cho PM, và tránh báo `NOT_FOUND` cho một Epic họ biết chắc là có.

### Hai thứ thêm ngoài card

- **Phân biệt `NOT_FOUND` với `NO_PERMISSION`.** JQL của Jira **cố ý** không phân biệt hai ca này (trả lời khác nhau sẽ để lộ sự tồn tại của issue). Phải hỏi riêng từng key mới biết — và chỉ hỏi những key thiếu, nên bình thường là không hỏi lần nào.
- **`issuetype.name` được chuẩn hoá.** Jira trả tên theo **ngôn ngữ của tài khoản dịch vụ**: tiếng Nhật là `エピック`, `サブタスク`. So chuỗi `'Epic'` thẳng sẽ trượt sạch trên Jira tiếng Nhật — đúng môi trường của dự án này.

### Dùng `Intl` thay luxon để kiểm tra múi giờ

C-1 nói dùng luxon. `IANAZone.isValidZone` của luxon **chính là** `new Intl.DateTimeFormat(undefined, {timeZone})` bọc trong try/catch, nên kết quả giống hệt — không đáng kéo cả một thư viện ngày tháng vào `apps/api` chỉ để kiểm tra một chuỗi. Worker vẫn dùng luxon cho mọi phép tính ngày thật.
