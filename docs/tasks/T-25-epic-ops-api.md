---
id: T-25
title: API vận hành Epic — sức khoẻ, giải thích số liệu, đồng bộ lại
status: review
model: opus
effort: high
depends_on: ["T-13", "T-18", "T-23"]
touches:
  - apps/api/src/routes/epic-ops.routes.ts
  - apps/api/src/routes/epic-ops.routes.test.ts
  - apps/api/src/services/epic-health.service.ts
  - apps/api/src/services/explain-day.service.ts
  - apps/api/src/adapters/epic-ops.adapters.ts
  - apps/api/src/server.ts
  - packages/db/src/repositories/explain.repository.ts
  - packages/shared/src/api-epic-ops.ts
prd_refs: ["§4.4", "§10.3", "§10.4", "Phụ lục B", "E-12", "R-08", "R-11"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-25 · API vận hành Epic — sức khoẻ, giải thích số liệu, đồng bộ lại

## Mục tiêu
Bốn endpoint để trả lời câu hỏi *"vì sao con số này lại thế"* và để xử lý sự cố mà không cần vào database. Endpoint quan trọng nhất là **giải thích một điểm dữ liệu** — nó là bước đầu tiên trong runbook khi PM báo số liệu sai.

## Ngữ cảnh cần biết

**Runbook nói rõ endpoint này dùng khi nào** (PRD §10.3):

> **PM báo số liệu sai** → 1. Mở màn hình "giải thích số liệu" của ngày đó. 2. Đối chiếu changelog của Sub-task nghi ngờ. 3. Kiểm tra xem có phải **Quy tắc 2 đang thắng Quy tắc 3** không (đây là nguyên nhân phổ biến nhất).

Nghĩa là phản hồi của `/explain` **bắt buộc phải nói rõ quy tắc nào đã được áp dụng cho từng Sub-task**. Trả về con số mà không kèm lý do thì endpoint này vô dụng đúng vào lúc cần nó nhất.

**Ba quy tắc tính khối lượng còn lại** (T-13, PRD §4.4):

| Quy tắc | Điều kiện | Giá trị |
|---|---|---|
| 1 | `statusCategory = done` tại thời điểm đó | `0` |
| 2 | Có sự kiện changelog `timeestimate` trước thời điểm đó | Giá trị mới nhất |
| 3 | Còn lại | `max(0, OriginalEstimate − spent)` |

> Quy tắc 2 thắng Quy tắc 3 là **nguyên nhân sai số phổ biến nhất**. Ai đó sửa tay `timeestimate` trên Jira một lần và giá trị đó dính mãi.

**`POST /resync` không được chạy đồng bộ ngay trong request.** Backfill 6 tháng mất tới 5 phút; phải đẩy job rồi trả về ngay. Đây là cùng cạm bẫy đã gặp ở T-09 và T-10.

**Đồng bộ lại là đường thoát của Epic đang `ERROR`** (PRD §10.3):

> Sửa xong bấm **Đồng bộ lại** → Epic quay về `BACKFILLING` rồi `ACTIVE`.

Máy trạng thái của T-10 cho phép `ERROR → BACKFILLING`. Dùng lại `assertTransition`, đừng tự sửa `status` bằng tay.

## Phạm vi

**Trong:** 4 endpoint theo PRD Phụ lục B

| Method | Đường dẫn | Việc |
|---|---|---|
| `GET` | `/api/epic/:epicKey/health` | Tình trạng dữ liệu: ngày thiếu snapshot, tỉ lệ thiếu estimate, tỉ lệ `UNCLASSIFIED`, tỉ lệ thiếu `wbs_*` |
| `GET` | `/api/burndown/epic/:epicKey/day/:date/explain` | **Giải thích một điểm dữ liệu**: từng Sub-task, quy tắc nào áp dụng, ra số bao nhiêu |
| `POST` | `/api/epic/:epicKey/resync` | Kích hoạt đồng bộ lại thủ công |
| `GET` | `/api/epic/:epicKey/plan-shift-history` | Lịch sử dịch chuyển kế hoạch — tuyến phòng thủ chính cho **R-11** |

**Ngoài:**
- Không tính lại số liệu — `/explain` chỉ **giải thích số đã có**, không tính lại từ đầu
- Không làm API biểu đồ (T-24 làm)
- Không làm UI (card GĐ 4)
- Không gửi cảnh báo (T-27 làm)

## Đầu vào đã có
- Ba quy tắc và `HistoricalRemaining` từ **T-13**
- `daily_snapshot` do **T-18** ghi, có `per_phase` và `source_read_at`
- `plan_shift_history` từ **T-15**
- Bảng `issue_changelog_event` và `worklog_entry` từ **T-11**
- Máy trạng thái `assertTransition` từ **T-10** ở [epic-registry.service.ts](../../apps/api/src/services/epic-registry.service.ts)
- Hàng đợi `sync` từ **T-23**
- `listWorkdays` từ **T-12**

## Việc phải làm

1. `packages/shared/src/api-epic-ops.ts` — zod schema cho 4 phản hồi.

2. `explain-day.service.ts` — **hàm thuần**, nhận dữ liệu đã nạp sẵn, trả về từng dòng:
   ```typescript
   {
     issueKey: string;
     summary: string;
     phaseCode: string;
     statusCategoryAtDay: 'new' | 'indeterminate' | 'done';
     appliedRule: 1 | 2 | 3;
     ruleExplanation: string;      // câu tiếng Việt PM đọc được
     originalEstimateHours: number;
     spentHoursUpToDay: number;
     remainingHours: number;
     // Chỉ có khi Quy tắc 2 thắng — đây là thứ runbook bảo đi tìm
     estimateOverride?: { valueHours: number; changedAt: string; changedBy: string | null };
   }
   ```
   Kèm phần tổng: tổng của các dòng **phải khớp** `daily_snapshot.actual_remaining_s` của ngày đó.

3. **Đối chiếu với snapshot đã lưu.** `/explain` tính lại từ dữ liệu thô rồi **so với số đã lưu**. Lệch nhau → trả thêm `mismatch: { storedHours, recomputedHours, differenceHours }`. Đây là cách phát hiện snapshot cũ hoặc lỗi engine — và là lý do endpoint này đáng giá hơn một bảng số thường.

4. `epic-health.service.ts`:
   - `missingSnapshotDays` — **danh sách ngày cụ thể**, không phải con số
   - `missingEstimateRatio` — Sub-task thiếu `timeoriginalestimate`
   - `unclassifiedPhaseRatio` — Task `phase_code = 'UNCLASSIFIED'`
   - `missingWbsDateRatio` — Sub-task thiếu `wbs_start_date` / `wbs_end_date` (R-08)
   - `unparsedSubtaskRatio` — `sb_parse_status <> 'OK'`
   - `lastSyncedAt`, `lastError`, `status` từ `tracked_epic`
   - Mỗi tỉ lệ kèm `level` (`OK` / `WARN` / `CRITICAL`) theo đúng ngưỡng ở PRD §10.4

5. `POST /resync`:
   - Kiểm tra quyền (Admin hoặc PM của project)
   - Nhận `{ from?, to?, full? }`; `full = true` là backfill toàn bộ
   - Epic đang `ERROR` → chuyển `BACKFILLING` qua `assertTransition`
   - Đẩy job vào hàng đợi `sync` với `jobId` chống trùng
   - Trả về ngay `{ jobId, queued: true }`

6. `GET /plan-shift-history` — danh sách từ `plan_shift_history`, mới nhất trước, kèm tổng số ngày lùi và `warningLevel` (ngưỡng 20% độ dài Phase).

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — mốc thời gian trả về là ISO UTC; ngày (`date`) là ngày **địa phương** của Epic.
- **C-2** — lưu bằng giây, trả ra bằng giờ.
- **C-3** — JSON API `camelCase`.
- **C-9** — log JSON có `correlationId`.
- **C-10** — không đoán bừa: ngày không có snapshot thì nói là **không có**, không tính bù tại chỗ.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- apps/api` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Giải thích số liệu:**
1. `Sub-task đã Done tại ngày đó được ghi rõ là áp dụng Quy tắc 1, còn lại 0 giờ`
2. `Sub-task có sự kiện timeestimate trước ngày đó áp dụng Quy tắc 2 và trả về estimateOverride`
3. `Sub-task bình thường áp dụng Quy tắc 3, remaining = OE − spent`
4. `Quy tắc 2 THẮNG Quy tắc 3 khi cả hai đều thoả` — nguyên nhân sai số phổ biến nhất
5. `Quy tắc 1 THẮNG cả Quy tắc 2 lẫn 3 khi Sub-task đã Done`
6. `tổng các dòng khớp đúng actual_remaining_s của snapshot ngày đó`
7. `snapshot lệch so với tính lại thì trả về phần mismatch kèm cả hai con số`
8. `mỗi dòng có câu giải thích tiếng Việt đọc được, không chỉ số quy tắc`
9. `ngày không có snapshot trả HTTP 404 kèm thông báo rõ, KHÔNG tính bù tại chỗ`
10. `Sub-task UNCLASSIFIED vẫn xuất hiện trong danh sách giải thích` — nó vẫn cộng vào tổng (C-11)

**Sức khoẻ dữ liệu:**
11. `missingSnapshotDays trả về danh sách NGÀY cụ thể, không phải con số`
12. `20% Task UNCLASSIFIED cho level = WARN theo đúng ngưỡng PRD §10.4`
13. `10% Sub-task thiếu wbs_* cho level = WARN`
14. `Epic dữ liệu sạch cho mọi level = OK`
15. `health trả kèm lastError khi Epic đang ở trạng thái ERROR`

**Đồng bộ lại:**
16. `resync đẩy job vào hàng đợi và trả về NGAY, không chạy đồng bộ trong request`
17. `Epic đang ERROR thì resync chuyển nó về BACKFILLING`
18. `Epic đang PAUSED thì resync bị từ chối` — máy trạng thái không cho PAUSED → BACKFILLING
19. `bấm resync hai lần chỉ tạo một job` — jobId chống trùng
20. `người dùng thường không được resync, trả HTTP 403`

**Dịch chuyển kế hoạch:**
21. `plan-shift-history trả danh sách mới nhất trước`
22. `Phase bị lùi quá 20% độ dài cho warningLevel = CRITICAL`
23. `Epic chưa từng bị lùi kế hoạch trả danh sách rỗng và warningLevel = OK`

## Định nghĩa "xong"
PM báo số liệu ngày 10/03 sai; gọi `/day/2026-03-10/explain` là thấy ngay từng Sub-task đóng góp bao nhiêu giờ, quy tắc nào áp dụng, và nếu có Sub-task nào bị Quy tắc 2 khoá cứng thì nó hiện ra kèm thời điểm và người sửa.

## Cạm bẫy đã biết
- **Trả về con số mà không kèm quy tắc đã áp dụng làm endpoint này vô dụng.** Runbook dẫn người vận hành tới đây đúng lúc họ cần biết *vì sao*, không phải *bao nhiêu*. Nếu chỉ có số thì họ vẫn phải mở database.
- **Tính bù snapshot tại chỗ khi ngày đó trống** che mất việc job đêm đang hỏng. Ngày thiếu là triệu chứng cần nhìn thấy (E-12).
- **`/explain` tính lại nhưng KHÔNG so với số đã lưu** thì bỏ lỡ đúng thứ đáng giá nhất: phát hiện snapshot cũ hoặc engine sai. Phần `mismatch` là lý do tồn tại của endpoint này.
- **`resync` chạy đồng bộ ngay trong request** sẽ timeout với backfill 6 tháng, và PM tưởng thất bại rồi bấm lại — đúng cạm bẫy đã ghi ở T-09 và T-10.
- **Sửa `tracked_epic.status` bằng tay thay vì qua `assertTransition`** sẽ mở đường cho `PAUSED → BACKFILLING`, mà máy trạng thái cố ý cấm. Epic tạm dừng bị đánh thức không rõ nguyên nhân.
- **Bỏ Sub-task `UNCLASSIFIED` khỏi danh sách giải thích** làm tổng không khớp snapshot, và người điều tra sẽ đi tìm một sai số không tồn tại.
- **`spentHoursUpToDay` phải tính theo `started`, không theo `created`** (C-1, E-03). Dùng nhầm thì phần giải thích mâu thuẫn với chính snapshot mà nó đang giải thích.

## Sửa sau khi bàn giao — `full` chưa từng đi tới worker

Card này nhận đủ `{from, to, full}` và đẩy cả ba vào job, nhưng phía worker khai kiểu nội dung job chỉ có `epicKey`, nên ba trường kia biến mất trong im lặng. Lệnh `{"full":true}` của runbook chạy trót lọt mà không dựng lại gì.

Đã nối xong, thêm 31 test:

- `packages/shared/src/sync-job.ts` — **một** schema cho nội dung job, dùng chung cho bên đẩy và bên chạy. `resyncRequestSchema` giờ dẫn xuất từ nó (`.omit({ epicKey: true })`) thay vì khai riêng.
- `apps/worker/src/jobs/rebuild-range.ts` — hàm thuần chốt dải ngày: `full` → từ ngày sớm nhất có dữ liệu; ngược lại → 7 ngày gần nhất, tự nới ra nếu có ngày thiếu snapshot cũ hơn (E-12).
- `apps/worker/src/jobs/handle-sync-job.ts` — bộ xử lý nối giai đoạn 1–3 với 4–5.
- `syncEpic(deps, key, { ignoreWatermark })` — `full` cũng bỏ qua watermark để đọc lại toàn bộ Jira, không chỉ tính lại từ dữ liệu thô đang có.
- `JobPayload` đổi thành `unknown`: đọc trường nào cũng phải kiểm trước, không kiểm thì không biên dịch được.

Xem mục *"Lỗi im lặng nặng nhất của cả dự án"* trong [README](./README.md) để biết vì sao ba lớp test đều bỏ lọt.

**Sau đó lộ ra một lỗ thứ hai:** hợp đồng API thì đúng, nhưng giao diện chỉ với tới **một** trong ba mức — `useResyncEpic` cố định `{ full: false }`, và nút bấm duy nhất nằm ở `/ops`, chỉ hiện cho Epic đang lỗi. Cả runbook lẫn màn hình Biểu đồ đều bảo *"bấm Đồng bộ lại ở màn hình Epic"*, mà màn hình Epic không hề có nút nào tên như vậy.

Đã bổ sung, thêm 17 test + 5 E2E:

- `apps/web/src/routes/epics/resync-modes.ts` — ba mức ở dạng dữ liệu thuần, mặc định là mức rẻ nhất
- `apps/web/src/routes/epics/resync-dialog.tsx` — hộp chọn mức, cảnh báo hạn mức Jira chỉ hiện ở mức Toàn bộ
- Nút **Đồng bộ lại** trên từng dòng Epic; Epic đang tạm dừng thì nút mờ (API trả 409)
- `tools/arch-tests/docs.test.ts` — **test chặn tài liệu chỉ tới nút không tồn tại**: quét mọi câu `Bấm **X** ở màn hình Epic` trong runbook và đối chiếu với nhãn nút thật trong mã nguồn

## Đã làm gì

**29 test xanh** (card yêu cầu 23), chạy qua `fastify.inject()` với cổng giả.

### Card sai một chỗ, và máy trạng thái là bên đúng

Card ghi: *"Epic đang `ERROR` → chuyển `BACKFILLING` qua `assertTransition`"*, kèm test số 17 và 18. Nhưng viết xong thì test *"đồng bộ lại một Epic đang chạy bình thường"* đỏ với HTTP 409.

Nguyên nhân: máy trạng thái của T-10 **không có nhánh `ACTIVE → BACKFILLING`**. Và đó là quyết định đúng — Epic đang chạy bình thường thì đồng bộ lại **vẫn ở `ACTIVE`**; `BACKFILLING` chỉ dành cho lần dựng lịch sử đầu tiên hoặc lần phục hồi sau lỗi.

Đã sửa theo hướng máy trạng thái:

| Trạng thái | Đồng bộ lại làm gì |
|---|---|
| `ERROR`, `PENDING` | chuyển sang `BACKFILLING` rồi đẩy job |
| `ACTIVE`, `BACKFILLING` | đẩy job, **không đổi trạng thái** |
| `PAUSED` | **từ chối** HTTP 409 kèm câu "Bật lại ở màn hình danh sách Epic rồi thử lại" |

Ca `PAUSED` được chặn bằng một lỗi riêng có câu chữ nói rõ cách khắc phục, thay vì để `assertTransition` ném ra một thông báo kỹ thuật.

### Endpoint đắt giá nhất là phần `mismatch`

`/explain` **tính lại** từ dữ liệu thô rồi **so với số đã lưu** trong snapshot. Lệch nhau thì trả về cả hai con số. Đây mới là lý do endpoint này đáng giá hơn một bảng số thường: nó phát hiện được snapshot cũ hoặc engine sai.

Điều kiện lọc Sub-task đang hoạt động **sao chép đúng** `buildSnapshotForDay` của T-17 (`createdAtMs <= T && (removedAtMs === null || removedAtMs > T)`). Lệch một dấu `=` ở đây là phần giải thích mâu thuẫn với chính snapshot mà nó đang giải thích — và người điều tra sẽ đi tìm một sai số không tồn tại. Có test riêng cho Sub-task tạo sau ngày đang xét.

### Bốn test bám đúng vào nguyên nhân sai số phổ biến nhất

Runbook (PRD §10.3) nói *"kiểm tra xem có phải Quy tắc 2 đang thắng Quy tắc 3 không"*. Nên có bốn test riêng cho thứ tự ba quy tắc, trong đó ca quan trọng nhất là: Sub-task đã log **7 giờ** trên ước lượng **8 giờ** nhưng có người sửa tay thành **5 giờ** — quy tắc 3 sẽ cho 1 giờ, quy tắc 2 cho 5 giờ, và **5 giờ mới là đúng**.

`estimateOverride` trả kèm **thời điểm và người sửa**, vì đó chính là thứ runbook bảo đi tìm.

### Chi tiết dễ tuột đã chặn

- **Chỉ dò ngày thiếu TRONG khoảng đã từng có snapshot.** Dò từ ngày tạo Epic sẽ báo thiếu cả những ngày job đêm chưa từng chạy tới — đúng nhưng vô dụng, và làm chìm mất những lỗ thủng thật.
- **Mức tổng lấy chỉ số XẤU NHẤT, không lấy trung bình.** Trung bình sẽ để ba chỉ số tốt che mất một chỉ số nghiêm trọng.
- **Mỗi chỉ số vượt ngưỡng nói rõ làm gì tiếp**, ví dụ *"mở màn hình Cấu hình Phase, xem khu Chưa nhận diện được rồi thêm luật khớp"*. Một con số 0,23 không giúp PM biết phải làm gì.
- **Ngưỡng nằm ở `packages/shared`**, không nằm trong API — dashboard vận hành (T-33) đọc cùng một nguồn. Hai nơi tự khai riêng thì sẽ có ngày lệch nhau và người trực không biết tin bên nào.
- **Sub-task `UNCLASSIFIED` vẫn nằm trong danh sách giải thích** (C-11), có test khẳng định tổng vẫn khớp snapshot.
- **Người xem không được bấm Đồng bộ lại**, kèm lý do thật: thao tác đó chiếm hạn mức gọi Jira của cả hệ thống.
