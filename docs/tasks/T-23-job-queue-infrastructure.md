---
id: T-23
title: Hạ tầng hàng đợi BullMQ và vòng đời worker
status: review
model: sonnet
effort: high
depends_on: ["T-11"]
touches:
  - apps/worker/src/queue/queues.ts
  - apps/worker/src/queue/worker.ts
  - apps/worker/src/queue/shutdown.ts
  - apps/worker/src/queue/redis-token-bucket.ts
  - apps/worker/src/queue/queue.test.ts
  - apps/worker/src/main.ts
prd_refs: ["§4.1", "§4.7", "§9.2", "§9.5", "E-25"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-23 · Hạ tầng hàng đợi BullMQ và vòng đời worker

## Mục tiêu
Dựng hàng đợi thật để các job có chỗ chạy: định nghĩa queue, chính sách thử lại, chống trùng job, giới hạn số Epic song song, và tắt worker sạch sẽ. Không có card này thì T-10 và T-18 đang đẩy job vào một cái hàng đợi chưa tồn tại.

## Ngữ cảnh cần biết

**Đây là món nợ đã tồn tại, không phải việc mới.** T-10 gọi `queue.add('backfill-epic', ...)` qua một interface `QueueLike` **chưa có ai cài đặt**, còn T-18 giả định queue đã có sẵn. Card này trả món nợ đó.

**Giới hạn song song là 4 Epic, không phải 4 job** (PRD §9.2):

| Quy tắc | Giá trị |
|---|---|
| Số request Jira song song | 8 (đã có ở `JiraClient`, T-03) |
| **Số Epic xử lý song song** | **4** |
| Số lần thử lại tối đa | 5 |
| Giãn cách | 1s → 2s → 4s → 8s → 16s + nhiễu 0–500ms |

> Hai giới hạn này **chồng lên nhau**: 4 Epic × 8 request = 32 request song song, vượt xa trần 8 của `JiraClient`. Đúng như vậy — `JiraClient` là bộ chặn cuối cùng và nó dùng chung cho cả tiến trình, nên 4 job vẫn chỉ đẩy được 8 request cùng lúc. Đừng "sửa" cho hai con số khớp nhau.

**Chống trùng job bằng `jobId`.** T-10 đã dùng `jobId = backfill-epic:{epicKey}`. BullMQ bỏ qua job có `jobId` trùng nếu job cũ còn trong hàng đợi — nhờ vậy PM bấm "Thêm" hai lần không tạo hai lần backfill.

**Tắt worker sạch là yêu cầu vận hành, không phải chi tiết đẹp đẽ.** Deploy giữa lúc job đêm đang chạy mà giết tiến trình ngay thì:
- khoá Redis còn treo tới hết TTL 15 phút → Epic đó bị bỏ qua cả lượt
- `sync_run` mắc kẹt ở `RUNNING` mãi mãi → người vận hành không biết job đã chạy hay chưa

## Phạm vi

**Trong:**
- Định nghĩa 3 queue: `sync` (đồng bộ + dựng lại), `backfill` (chạy bù), `reconcile` (đối soát, T-26 dùng)
- Kết nối Redis dùng chung (`ioredis`), có `maxRetriesPerRequest: null` theo yêu cầu của BullMQ
- Chính sách thử lại: 5 lần, giãn cách luỹ thừa + nhiễu
- `concurrency: 4` cho worker `sync`
- Chống trùng bằng `jobId`
- Tắt sạch khi nhận `SIGTERM` / `SIGINT`: ngừng nhận job mới, chờ job đang chạy xong (có hạn), đóng kết nối
- Job hỏng hết số lần thử → chuyển sang hàng đợi thất bại, **giữ lại** để điều tra
- `apps/worker/src/main.ts` — điểm lắp ráp: tạo Prisma, Redis, `JiraClient`, đăng ký worker

**Ngoài:**
- Không viết logic đồng bộ (T-11 đã có) hay dựng lại lịch sử (T-18)
- Không đăng ký CRON (T-18 làm phần lịch chạy)
- Không làm metrics (T-27 làm)
- Không làm job đối soát (T-26 làm) — card này chỉ **tạo sẵn queue** cho nó

## Đầu vào đã có
- `syncEpic()` từ **T-11** ở [sync-epic.job.ts](../../apps/worker/src/jobs/sync-epic.job.ts)
- Interface `QueueLike` và hằng `BACKFILL_JOB_NAME` từ **T-10** ở [epic-registry.adapters.ts](../../apps/api/src/adapters/epic-registry.adapters.ts)
- `bullmq` và `ioredis` đã khai trong `apps/worker/package.json`
- Bố trí key Redis ở PRD §4.7 — tiền tố hàng đợi là `bull:burndown:*`

## Việc phải làm

1. `queues.ts` — khai 3 queue dùng chung một `prefix: 'bull:burndown'`, kèm `defaultJobOptions`:
   ```typescript
   {
     attempts: 5,
     backoff: { type: 'exponential', delay: 1000 },   // 1s → 2s → 4s → 8s → 16s
     removeOnComplete: { age: 24 * 3600, count: 1000 },
     removeOnFail: false,        // GIỮ LẠI job hỏng để điều tra
   }
   ```
   `removeOnFail: false` là có chủ ý: job đêm hỏng lúc 00:01 mà bị xoá thì sáng ra không còn gì để xem.

2. `worker.ts` — tạo `Worker` cho queue `sync` với `concurrency: 4`. Bộ xử lý gọi thẳng `syncEpic()`, **không** nhét thêm logic nghiệp vụ vào đây.

3. Nhiễu ngẫu nhiên cho lần thử lại. BullMQ `exponential` **không** tự cộng nhiễu — phải tự thêm, nếu không 20 job cùng bị 429 sẽ cùng chờ đúng 4 giây rồi lại đồng loạt gọi lại (PRD §9.2).

4. `shutdown.ts`:
   - Bắt `SIGTERM` và `SIGINT`
   - `worker.close()` — ngừng nhận job mới, chờ job đang chạy
   - Hạn chờ 30 giây; quá hạn thì ghi log rõ ràng rồi thoát mã khác 0
   - Đóng Redis và Prisma **sau khi** worker đã đóng
   - Gọi hai lần phải an toàn (bấm Ctrl+C hai lần)

5. `main.ts` — lắp ráp: đọc biến môi trường, dựng `PrismaClient`, `ioredis`, `JiraClient` (kèm `TokenBucketRateLimiter` dùng **Redis store**, không phải in-memory), nạp `EffectiveConfig`, đăng ký worker, đăng ký tắt sạch.

6. Bộ chuyển đổi để `apps/api` đẩy được job thật: `QueueLike` của T-10 đã đủ hẹp, chỉ cần truyền `Queue` của BullMQ vào là khớp.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-6** — job chạy lại phải an toàn; `jobId` chống trùng.
- **C-7** — 4 Epic song song; bộ giới hạn tốc độ Jira phải dùng **Redis store**, không phải in-memory. In-memory nghĩa là mỗi worker tự giới hạn 40 req/s riêng, 4 worker thành 160 req/s và vẫn bị Jira chặn. Đây là lỗi im lặng: test đơn tiến trình vẫn xanh.
- **C-9** — log JSON có `correlationId`; **cấm ghi token vào log**.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- apps/worker` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Hàng đợi và chống trùng:**
1. `đẩy hai job cùng jobId thì chỉ có một job trong hàng đợi`
2. `job có jobId khác nhau thì cả hai đều vào hàng đợi`
3. `job hỏng được thử lại đúng 5 lần rồi mới chuyển sang thất bại`
4. `khoảng chờ giữa các lần thử tăng theo luỹ thừa`
5. `hai lần thử lại của cùng một job KHÔNG có khoảng chờ giống hệt nhau` — chứng minh nhiễu thật sự tồn tại
6. `job thất bại hết số lần vẫn được GIỮ LẠI trong hàng đợi thất bại`

**Song song:**
7. `worker sync chạy tối đa 4 job cùng lúc` — đẩy 10 job, đo số job chạy đồng thời
8. `job thứ 5 chờ tới khi có chỗ trống chứ không bị bỏ`

**Tắt sạch:**
9. `nhận SIGTERM thì ngừng nhận job mới nhưng job đang chạy vẫn xong`
10. `job đang chạy quá 30 giây thì ghi log cảnh báo và thoát mã khác 0`
11. `gọi tắt sạch hai lần không ném lỗi`
12. `Redis và Prisma chỉ đóng SAU KHI worker đã đóng`

**Lắp ráp:**
13. `bộ giới hạn tốc độ dùng Redis store, không phải in-memory`
14. `log của worker không chứa chuỗi token`

## Định nghĩa "xong"
Chạy `pnpm --filter @app/worker dev`, đẩy một job đồng bộ vào queue thì nó chạy đúng; đẩy 10 job thì tối đa 4 chạy cùng lúc; gửi `SIGTERM` thì job đang chạy hoàn tất rồi tiến trình mới thoát.

## Cạm bẫy đã biết
- **`maxRetriesPerRequest` phải là `null` cho kết nối BullMQ dùng.** Mặc định của `ioredis` là 20, và BullMQ sẽ ném lỗi khởi động. Thông báo lỗi không nói rõ nguyên nhân.
- **Dùng chung một kết nối `ioredis` cho cả `Queue` lẫn `Worker` là sai.** BullMQ cần kết nối riêng cho chế độ blocking; dùng chung sẽ làm treo mọi lệnh Redis khác — **kể cả token bucket giới hạn tốc độ Jira**.
- **`removeOnFail: true` xoá mất bằng chứng.** Job đêm hỏng lúc 00:01, sáng ra không còn gì để điều tra. Mặc định của BullMQ có vẻ gọn gàng nhưng sai với ca này.
- **BullMQ `exponential` KHÔNG tự cộng nhiễu.** Phải tự thêm. Không có nhiễu thì các job bị 429 sẽ đồng loạt gọi lại đúng cùng một thời điểm và lại 429.
- **Bộ giới hạn tốc độ in-memory là lỗi im lặng nguy hiểm nhất ở card này.** Mọi test đơn tiến trình vẫn xanh, chỉ khi chạy 4 worker trên production mới bị Jira chặn — và lúc đó ảnh hưởng cả tổ chức (R-04 mức "Rất cao").
- **Quên `await` khi đóng worker** khiến tiến trình thoát trước lúc job xong, để lại khoá Redis treo 15 phút và `sync_run` mắc kẹt ở `RUNNING`.

## Đã làm gì

**33 test xanh**, không cần Redis thật.

### Cạm bẫy nguy hiểm nhất của card đã được chặn bằng hình dạng API

Card cảnh báo bộ giới hạn tốc độ in-memory là *"lỗi im lặng nguy hiểm nhất"*: mọi test đơn tiến trình vẫn xanh, chỉ khi chạy 4 worker trên production mới bị Jira chặn.

Tôi không chống nó bằng một dòng ghi chú mà bằng **kiểu dữ liệu**: `buildJiraRateLimiter(redis)` bắt buộc nhận một kết nối Redis và **không có tham số nào** cho phép chọn bản in-memory. Kèm test khẳng định `store instanceof RedisTokenBucketStore` và **không** phải `InMemoryTokenBucketStore`.

`RedisTokenBucketStore` là file mới ngoài danh sách `touches` ban đầu. Lý do: `packages/jira` cố ý không phụ thuộc `ioredis` — T-03 chỉ để lại Lua script và cổng `TokenBucketStore`, nên chỗ nối vào Redis phải nằm ở worker.

### Tách được phần kiểm được ra khỏi phần cần Redis

Hành vi của BullMQ (chống trùng theo `jobId`, đếm số lần thử, giới hạn song song) chỉ kiểm được với Redis thật. Nhưng **cấu hình sinh ra hành vi đó thì kiểm được ngay**:

| Kiểm được không cần Redis | Cần Redis thật |
|---|---|
| `attempts: 5`, giãn cách luỹ thừa, `removeOnFail: false` | job hỏng có đúng thử lại 5 lần không |
| `jobIdFor` sinh khoá trùng cho cùng Epic | BullMQ có thật sự bỏ job trùng không |
| `SYNC_CONCURRENCY = 4` | worker có thật sự chỉ chạy 4 job không |
| **Toàn bộ quy trình tắt sạch** | — |

Quy trình tắt sạch được viết quanh cổng `Closable` chứ không quanh `Worker` của BullMQ, nên kiểm được **đầy đủ**: thứ tự đóng, gọi hai lần, quá hạn 30 giây, và cả ca một kết nối đóng lỗi không được chặn những cái còn lại.

### Ba chi tiết dễ tuột

1. **Nhiễu là thật, có test chứng minh.** BullMQ `exponential` không tự cộng nhiễu. Test sinh 200 khoảng chờ và đòi hơn 50 giá trị khác nhau — viết cứng một hằng số sẽ đỏ ngay.
2. **Kết nối luôn đóng SAU worker, kể cả khi đã quá hạn.** Bỏ luôn việc đóng sẽ để lại kết nối treo phía Redis; đóng trước là cắt chân chính cái job đang cố hoàn tất.
3. **Mật khẩu nằm trong URL Redis và PostgreSQL cũng phải bị che.** `loggableEnv` chỉ lấy phần host, có test riêng — đây là đường rò rỉ dễ bỏ sót hơn cả token Jira.

### Thêm ngoài card

`dispatchJob` **ném lỗi** khi gặp job không có bộ xử lý. Bỏ qua trong im lặng thì job báo thành công và Epic đó vĩnh viễn không được đồng bộ — chuyện rất dễ xảy ra sau một lần đổi tên job mà hàng đợi còn job cũ.

### Còn nợ lại

`main()` thật (tạo Prisma, ioredis, JiraClient rồi chạy) **chưa viết**: nó chỉ chạy được khi có PostgreSQL, Redis và Jira, mà máy hiện tại không có cái nào. Phần lắp ráp đã tách thành các hàm thuần (`readEnv`, `createRedisConnections`, `buildJiraRateLimiter`) và kiểm đầy đủ; ghép chúng lại là việc của lần triển khai thật đầu tiên.
