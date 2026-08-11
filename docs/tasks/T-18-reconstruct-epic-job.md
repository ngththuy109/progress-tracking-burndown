---
id: T-18
title: Job dựng lại lịch sử — khoá, heartbeat và ghi idempotent
status: review
model: opus
effort: high
depends_on: ["T-11", "T-15", "T-17"]
touches:
  - apps/worker/src/jobs/reconstruct-epic.job.ts
  - apps/worker/src/lock/redis-lock.ts
  - packages/db/src/repositories/snapshot.repository.ts
prd_refs: ["§4.2", "§4.2.1", "§4.4", "E-11", "E-12", "E-19", "E-21", "E-24"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-18 · Job dựng lại lịch sử — khoá, heartbeat và ghi idempotent

## Mục tiêu
Chạy trọn vẹn một Epic: lấy dữ liệu, tổng hợp ngày Phase, dựng snapshot cho từng ngày làm việc, ghi vào database. Chạy lại bao nhiêu lần cũng không nhân đôi và không ghi đè bằng dữ liệu cũ.

## Ngữ cảnh cần biết

**Khoá Redis là mutex NỘI BỘ giữa các job, KHÔNG phải khoá trên Jira** (PRD §4.2.1):

> Người dùng vẫn sửa Epic, thêm Sub-task, log giờ **bình thường 24/7** — kể cả đúng lúc job đang chạy. Hệ thống này chỉ **đọc** từ Jira.

**Khoá là tối ưu, KHÔNG phải cơ chế đảm bảo tính đúng đắn:**

> Lớp đảm bảo đúng đắn thật sự là `UNIQUE (epic_key, snapshot_date)` + UPSERT idempotent. Nếu khoá hỏng hoàn toàn, **số liệu vẫn không sai** — chỉ tốn thêm quota Jira và CPU.

Bốn lý do vẫn cần khoá: tiết kiệm quota Jira (R-04 mức "Rất cao"), chống ghi đè dữ liệu cũ, tránh deadlock PostgreSQL, tiết kiệm CPU.

**Không lấy được khoá thì KHÔNG bỏ qua im lặng** (PRD §4.2):

> Nếu đây là yêu cầu tính lại do log giờ lùi ngày, bỏ qua = **mất luôn yêu cầu** = snapshot quá khứ sai vĩnh viễn. Phải đánh dấu `dirty:epics` để lượt sau xử lý.

**Heartbeat** — job có thể chạy lâu hơn TTL 15 phút (Jira chậm, dính 429 nhiều lần). Không gia hạn thì khoá tự hết hạn giữa chừng.

**Chống ghi đè bằng dữ liệu cũ** (E-19) — UPSERT phải có điều kiện `WHERE existing.source_read_at < EXCLUDED.source_read_at`.

## Phạm vi

**Trong:**
- `reconstructEpic(epicKey, fromDate, toDate)` theo đúng mã giả PRD §4.4 Hàm 7
- Khoá Redis `joblock:sync:{epicKey}` TTL 15 phút + heartbeat gia hạn mỗi 60 giây
- Không lấy được khoá → `SADD dirty:epics` rồi thoát
- Gọi `computePhaseRollups` (T-15) **trước** khi dựng snapshot
- Lặp qua từng ngày làm việc, gọi `buildSnapshotForDay` (T-17)
- UPSERT snapshot trong **một transaction**, có điều kiện `source_read_at`
- Xoá cache `chart:{epicKey}:*` bằng `SCAN`
- CRON 00:01 lấy Epic từ `tracked_epic WHERE status = 'ACTIVE'`
- Job nhặt `dirty:epics` chạy mỗi giờ
- Dò và bù ngày snapshot bị thiếu (E-12)

**Ngoài:**
- Không xây dựng lại Jira fetcher (T-11 đã có)
- Không tính trạng thái Signboard (T-22 làm, và Signboard tính lúc đọc chứ không snapshot)
- Không làm API đọc biểu đồ (card GĐ 3)

## Đầu vào đã có
- Pipeline đồng bộ từ **T-11**
- `computePhaseRollups`, `detectPlanShift` từ **T-15**
- `buildSnapshotForDay` từ **T-17**
- `listWorkdays` từ **T-12**
- `listActiveEpics()` từ **T-10**

## Việc phải làm

1. `redis-lock.ts` — `acquireLock`, `releaseLock`, `startHeartbeat`. Nhả khoá phải kiểm tra token sở hữu (Lua script), tránh nhả nhầm khoá của job khác.
2. `reconstructEpic` theo đúng mã giả PRD §4.4:
   ```typescript
   const LOCK_KEY = `joblock:sync:${epicKey}`;
   const lock = await redis.acquireLock(LOCK_KEY, 15 * 60_000);

   if (!lock) {
     // KHÔNG bỏ qua im lặng — mất yêu cầu tính lại là mất vĩnh viễn
     await redis.sadd('dirty:epics', epicKey);
     return;
   }

   const heartbeat = setInterval(() => redis.expire(LOCK_KEY, 15 * 60), 60_000);

   try {
     const epic     = await loadTrackedEpic(epicKey);
     const subtasks = await loadSubtasksWithHistory(epicKey);

     // GIAI ĐOẠN 4 — phải làm TRƯỚC khi dựng snapshot
     const phaseRollups = computePhaseRollups(subtasks, calendar);
     await db.upsertPhaseRollups(epicKey, phaseRollups);

     // GIAI ĐOẠN 5
     const days = listWorkdays(fromDate, toDate, epic.calendarId);
     const snapshots = days.map(d =>
       buildSnapshotForDay(epic, subtasks, phaseRollups, d, epic.timezone, ...)
     );

     await db.transaction(tx => tx.upsertSnapshots(snapshots));
     await redis.delByPattern(`chart:${epicKey}:*`);   // SCAN, không KEYS
     await db.updateWatermark(epicKey, sourceReadAt);

   } finally {
     clearInterval(heartbeat);          // tắt heartbeat TRƯỚC khi nhả khoá
     await redis.releaseLock(LOCK_KEY);
   }
   ```
3. UPSERT snapshot có điều kiện chống ghi đè dữ liệu cũ:
   ```sql
   INSERT INTO daily_snapshot (...) VALUES (...)
   ON CONFLICT (epic_key, snapshot_date) DO UPDATE
       SET ... = EXCLUDED. ...
       WHERE daily_snapshot.source_read_at < EXCLUDED.source_read_at;
   ```
4. Scheduler CRON 00:01 → `listActiveEpics()` → đẩy job, tối đa 4 Epic song song.
5. Job nhặt `dirty:epics` chạy mỗi giờ (gom yêu cầu, tránh tính lại liên tục — R-10).
6. Dò ngày thiếu: so `listWorkdays` với snapshot đã có, thiếu thì bù (E-12).
7. Sub-task đổi Phase → tính lại `phase_rollup` của **cả hai** Phase (E-24).

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-6** — UPSERT theo khoá tự nhiên; chống ghi đè bằng `source_read_at`; chạy 2 lần cho kết quả byte-for-byte giống nhau.
- **C-7** — tối đa 4 Epic song song.
- **C-9** — log JSON có `correlationId`; lỗi ghi `sync_run` rồi chuyển Epic sang `ERROR`.
- **C-13** — không sửa migration đã merge.
- Xoá cache dùng `SCAN`, **không dùng `KEYS`** (KEYS khoá cả Redis).

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- apps/worker` xanh (Testcontainers: PostgreSQL + Redis)
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Khoá:**
1. `job thứ hai không lấy được khoá thì đẩy Epic vào dirty:epics rồi thoát` — **không** bỏ qua im lặng
2. `heartbeat gia hạn TTL khoá trong lúc job chạy` — job chạy 3 phút, khoá vẫn còn
3. `heartbeat bị tắt trước khi nhả khoá` — không còn interval treo sau khi job xong
4. `job lỗi giữa chừng vẫn nhả khoá` — khối finally
5. `không nhả được khoá của job khác` — token sở hữu

**Idempotency:**
6. `chạy job 2 lần liên tiếp cho ra dữ liệu byte-for-byte giống nhau`
7. `job đọc Jira lúc 00:01 ghi SAU job đọc lúc 00:03 thì KHÔNG ghi đè` — chống stale overwrite (E-19)
8. `UNIQUE (epic_key, snapshot_date) chặn được nhân đôi kể cả khi khoá hỏng hoàn toàn`

**Thứ tự giai đoạn:**
9. `phase_rollup được tính TRƯỚC khi dựng snapshot` — snapshot dùng đúng ngày Phase mới
10. `plan_shift_history được ghi khi plan_end bị đẩy lùi`

**Bù ngày thiếu:**
11. `thiếu snapshot ngày 12/03 thì job hôm sau tự dựng bù cả 12/03 và 13/03`
12. `chạy bù nhiều lần chỉ cho ra đúng một bản ghi cho mỗi (epic, ngày)`

**Scheduler:**
13. `CRON chỉ đẩy job cho Epic có status ACTIVE`
14. `Epic chuyển PAUSED giữa lúc job chạy thì job hiện tại chạy nốt, lượt sau bỏ qua` (E-25)
15. `tối đa 4 Epic chạy song song`

**Đổi Phase:**
16. `Sub-task chuyển sang Phase khác thì phase_rollup của CẢ HAI Phase được tính lại` (E-24)

**Xoá cache:**
17. `xoá cache dùng SCAN, không gọi lệnh KEYS`

## Định nghĩa "xong"
Chạy job cho một Epic thật sinh ra đủ snapshot cho mọi ngày làm việc; chạy lại lần hai không đổi một byte; và hai job chồng nhau không làm hỏng dữ liệu kể cả khi khoá bị vô hiệu.

## Cạm bẫy đã biết
- **Bỏ qua im lặng khi không lấy được khoá là lỗi mất dữ liệu.** Job đêm bỏ qua thì vô hại (mai chạy lại), nhưng bỏ qua một yêu cầu tính lại do log lùi ngày thì **mất vĩnh viễn** — snapshot quá khứ sai mãi. Đây là lý do test 1 tồn tại.
- **Quên `clearInterval` trong `finally` làm rò rỉ heartbeat.** Worker chạy vài ngày sẽ tích tụ hàng trăm interval gia hạn những khoá không còn tồn tại.
- **`UNIQUE` không chống được ghi đè bằng dữ liệu cũ.** UPSERT là "ai ghi sau thì thắng", mà ghi sau chưa chắc là mới hơn. Bắt buộc phải có mệnh đề `WHERE source_read_at <`.
- **Tính `phase_rollup` sau khi dựng snapshot là sai thứ tự.** Snapshot sẽ dùng ngày Phase cũ → đường Kế hoạch lệch một lượt đồng bộ. Lỗi im lặng, chỉ lộ khi so hai lần chạy liên tiếp.
- **`KEYS` khoá cả Redis.** Với vài chục nghìn key cache, một lệnh `KEYS` làm treo mọi thao tác Redis khác vài trăm mili-giây — gồm cả token bucket giới hạn tốc độ Jira.
- **Nhả khoá không kiểm tra token có thể nhả nhầm khoá của job khác** khi khoá của mình đã hết hạn và job khác vừa chiếm được.

## Đã làm gì

**31 test xanh** (13 khoá + 18 job; card yêu cầu 17). Toàn workspace **451 test** xanh.

### Redis giả cài lại đúng ngữ nghĩa, không trả giá trị cố định

`FakeLockRedis` cài lại `SET NX PX` và cả hai Lua script, kèm đồng hồ ảo để tua tới lúc khoá hết hạn. Nếu chỉ trả `'OK'` cứng thì test *"hai job không cùng lấy được khoá"* sẽ xanh **ngay cả khi khoá hỏng hoàn toàn** — tức là test vô nghĩa đúng ở chỗ quan trọng nhất.

Nhờ vậy 3 test về quyền sở hữu mới có giá trị: không nhả được khoá của job khác, không gia hạn được khoá của job khác, và gia hạn khoá đã hết hạn **không tạo lại** khoá đó.

### Ba test về thứ tự — chỗ dễ sai nhất và hoàn toàn im lặng

`FakePorts` ghi lại thứ tự mọi lời gọi, rồi test khẳng định:

| Phải xảy ra trước | Phải xảy ra sau | Sai thì sao |
|---|---|---|
| `savePhaseRollups` | `saveSnapshots` | Snapshot dùng ngày Phase **cũ** → đường Kế hoạch lệch một lượt đồng bộ |
| `loadPreviousRollups` | `savePhaseRollups` | So bản mới với **chính nó** → không bao giờ phát hiện dịch chuyển (R-11 mất tác dụng) |
| `saveSnapshots` | `invalidateChartCache` | Request xen giữa sẽ nạp lại dữ liệu **cũ** rồi cache thêm 15 phút |

Cả ba đều không làm test nào khác đỏ, và cả ba đều cho ra biểu đồ trông hoàn toàn bình thường.

### Thêm ngoài card: xử lý mất khoá giữa chừng

Card có heartbeat nhưng không nói làm gì khi gia hạn **thất bại** — nghĩa là job khác đã chiếm khoá. Chạy tiếp và ghi đè lên họ sẽ tạo dữ liệu trộn lẫn từ **hai lượt đọc Jira khác nhau**, và `source_read_at` cũng không cứu được vì cả hai đều "mới".

Đã cho `LockHeartbeat` nhận `onLost`; job bỏ qua việc ghi, đánh dấu `dirty:epics` và thoát như ca không lấy được khoá ngay từ đầu.

### `upsertSnapshots` phải viết SQL thô

Prisma **không sinh được** mệnh đề `WHERE ... < EXCLUDED.source_read_at` trong `ON CONFLICT DO UPDATE`. Không có mệnh đề đó thì `UNIQUE` một mình vô dụng cho ca này: UPSERT là *"ai ghi sau thì thắng"*, mà ghi sau chưa chắc là mới hơn.

Hàm trả về cả `written` lẫn `skippedStale`, và job báo cáo lại `skippedStale` — luôn khác 0 nghĩa là có hai job đang giẫm chân nhau.

### Ba việc trong card thuộc về T-23, không làm ở đây

CRON, hàng đợi `dirty:epics` chạy mỗi giờ, và giới hạn 4 Epic song song đều cần **hạ tầng hàng đợi BullMQ** mà T-23 mới dựng. Card này để lại đúng thứ T-23 cần: một hàm `reconstructEpic()` thuần điều phối, nhận cổng qua tham số. Đã ghi vào card T-23.

---

## Cập nhật sau bàn giao — 2026-08 (nhánh `claude/burndown-chart-missing-day`)

Giai đoạn 5 nay dựng snapshot cho **mọi ngày lịch** trong dải, không chỉ ngày
làm việc (`listCalendarDays` thay `listWorkdays`): team log giờ Thứ 7/CN thì
đường Thực tế giảm đúng hôm đó thay vì dồn vào sáng Thứ 2. Ngày nghỉ không ai
làm thì snapshot phẳng so với hôm trước — biểu đồ bôi xám ngày nghỉ nên đoạn
phẳng đọc đúng nghĩa. Riêng phép dò ngày thiếu E-12 vẫn CHỈ quét ngày làm việc
(cố ý — tránh đêm đầu sau nâng cấp phải đào lại toàn bộ lịch sử cuối tuần; xem
ghi chú tại `earliestMissingSnapshotDate` trong `wire.ts`).
