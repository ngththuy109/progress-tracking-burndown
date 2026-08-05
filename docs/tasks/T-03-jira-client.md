---
id: T-03
title: Jira client — xác thực, phân trang, giới hạn tốc độ, thử lại
status: review
model: sonnet
effort: high
depends_on: ["T-01"]
touches:
  - packages/jira/src/client.ts
  - packages/jira/src/rate-limiter.ts
  - packages/jira/src/retry.ts
  - packages/jira/src/paginate.ts
  - packages/jira/src/endpoints/
  - packages/jira/src/index.ts
  - packages/shared/src/jira-types.ts
prd_refs: ["§2.5", "§9.2", "§9.3", "E-07"]
owner: claude
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-03 · Jira client — xác thực, phân trang, giới hạn tốc độ, thử lại

## Mục tiêu
Một client gọi được mọi endpoint Jira mà PRD cần, tự giãn tốc độ để không bị chặn, và tự phân trang. Card sau chỉ việc gọi hàm, không phải nghĩ về 429 hay `startAt`.

## Ngữ cảnh cần biết

**Rủi ro R-04 trong PRD xếp mức ảnh hưởng "Rất cao"**: bị Jira chặn vì gọi quá nhiều sẽ ảnh hưởng **cả tổ chức**, không riêng hệ thống này. Đó là lý do card này ưu tiên giới hạn tốc độ chủ động hơn là chờ bị 429 rồi mới xử lý.

Bảng endpoint đầy đủ ở **PRD §2.5**:

| Mục đích | Endpoint |
|---|---|
| Tìm issue theo JQL | `POST /rest/api/3/search` |
| Worklog của 1 issue | `GET /rest/api/3/issue/{key}/worklog` |
| Changelog của 1 issue | `GET /rest/api/3/issue/{key}/changelog` |
| Worklog vừa đổi | `GET /rest/api/3/worklog/updated` |
| Worklog vừa xoá | `GET /rest/api/3/worklog/deleted` |
| Chi tiết worklog theo lô | `POST /rest/api/3/worklog/list` |
| Bảng trạng thái | `GET /rest/api/3/status` |
| Danh sách field | `GET /rest/api/3/field` |

**Về nhiễu ngẫu nhiên khi thử lại** (PRD §9.2):

> Nếu 20 job cùng bị 429 và cùng chờ đúng 4 giây, chúng sẽ lại đồng loạt gọi lại cùng lúc → 429 tiếp. Cộng thêm một khoảng ngẫu nhiên nhỏ giúp trải đều các lần thử lại.

## Phạm vi

**Trong:**
- Basic auth `email:api_token` Base64, token đọc từ biến môi trường
- Bọc xác thực sau interface `CredentialProvider` để sau này đổi sang OAuth không phải sửa client
- Token bucket **trên Redis** (giới hạn toàn hệ thống, không phải per-process)
- Thử lại có nhiễu ngẫu nhiên, ưu tiên header `Retry-After`
- Phân trang tự động cho cả 3 kiểu Jira dùng (`startAt/maxResults`, `nextPageToken`, `since`)
- Giới hạn song song bằng `p-limit`
- 8 hàm endpoint có kiểu đầy đủ
- Bộ lọc che `Authorization` trong log

**Ngoài:**
- Không ghi gì vào database (T-11 làm)
- Không phân tách tiêu đề (T-07, T-08 làm)
- Không cache `statusCategory` (T-04 làm)
- Không dò custom field (T-05 làm)
- **Tuyệt đối không viết endpoint ghi vào Jira** — hệ thống chỉ đọc (PRD §1.4)

## Đầu vào đã có
- `packages/jira/` khung từ T-01
- `p-limit`, `zod` đã cài từ T-01

## Việc phải làm

1. `CredentialProvider` interface + `BasicAuthProvider` đọc từ env `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_BASE_URL`. Thiếu env → **chặn khởi động**, báo rõ thiếu biến nào.
2. **Token bucket trên Redis**, trần 40 request/giây toàn hệ thống. Dùng Lua script để nạp + lấy token nguyên tử (nhiều worker cùng chạy).
3. `withRetry()`:
   - Tối đa 5 lần
   - Giãn cách 1s → 2s → 4s → 8s → 16s
   - Cộng nhiễu ngẫu nhiên 0–500ms
   - Có header `Retry-After` → **ưu tiên tuyệt đối**, chờ đúng số giây đó
   - Chỉ thử lại với 429 và 5xx. **4xx khác không thử lại** (thử lại 404 là vô nghĩa và tốn quota)
4. `paginate()` — generator async, che 3 kiểu phân trang của Jira.
5. 8 hàm endpoint, mỗi hàm 1 file trong `endpoints/`, phản hồi validate bằng zod.
6. `searchIssues()` **bắt buộc** nhận tham số `fields` — không cho gọi thiếu.
7. Đếm số lần bị 429 để T-11 ghi vào `sync_run.rate_limit_hits`.
8. Bộ lọc log che `Authorization`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-7** — 40 req/s, song song tối đa 8, thử lại 5 lần có nhiễu, ưu tiên `Retry-After`, luôn truyền `fields=`. **Cấm thử lại ngay lập tức khi gặp 429.**
- **C-9** — log JSON có `correlationId`; **cấm ghi token vào log**.
- **C-1** — mốc thời gian Jira trả về là ISO có offset, giữ nguyên chuỗi, đừng vội đổi sang `Date`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- packages/jira` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

Dùng `msw` hoặc `nock` giả lập Jira, không gọi mạng thật:

1. `thiếu biến môi trường JIRA_API_TOKEN thì chặn khởi động và báo rõ tên biến`
2. `gặp 429 có Retry-After thì chờ đúng số giây Jira yêu cầu, không dùng công thức lùi`
3. `gặp 429 không có Retry-After thì lùi theo 1s, 2s, 4s, 8s, 16s`
4. `mỗi lần lùi đều cộng nhiễu ngẫu nhiên, hai lần chạy không ra cùng một khoảng chờ`
5. `gặp 404 thì KHÔNG thử lại` — chỉ 1 request được gửi
6. `gặp 500 thì thử lại tối đa 5 lần rồi ném lỗi`
7. `phân trang tự gộp đủ 250 issue từ 3 trang`
8. `token bucket chặn ở 40 request/giây` — bắn 100 request, đo thời gian ≥ 2.5 giây
9. `token bucket dùng chung giữa 2 client instance` — chứng minh giới hạn là toàn hệ thống
10. `log không bao giờ chứa chuỗi token` — bắt log, khẳng định `Authorization` bị che
11. `searchIssues không cho gọi thiếu tham số fields` — lỗi kiểu lúc biên dịch hoặc ném lỗi lúc chạy

## Định nghĩa "xong"
Gọi được cả 8 endpoint với phản hồi giả lập, và bộ test chứng minh client tự giãn tốc độ ở 40 req/s, xử lý 429 đúng cách, không thử lại lỗi 4xx, không rò token ra log.

## Cạm bẫy đã biết
- **Token bucket phải nằm trên Redis, không phải trong RAM.** 4 worker mỗi cái tự giới hạn 40 req/s thì tổng thành 160 req/s — vẫn bị chặn. Đây là lỗi im lặng: test đơn tiến trình vẫn xanh.
- **Nạp token phải nguyên tử.** Đọc-rồi-ghi qua 2 lệnh Redis sẽ tranh chấp. Dùng Lua script.
- **`Retry-After` có thể là số giây hoặc HTTP date.** Xử lý cả hai.
- **`/worklog/updated` và `/worklog/deleted` phân trang theo `since`**, không theo `startAt`. Dùng nhầm kiểu sẽ lặp vô hạn hoặc bỏ sót dữ liệu.
- **`POST /search` bị Atlassian deprecate dần** sang `/search/jql`. Bọc endpoint sau một hàm để sau này đổi một chỗ. Contract test hằng ngày (PRD §8.4) sẽ bắt được lúc Atlassian đổi.
- **Đừng thử lại lỗi 401.** Token sai thì thử 5 lần vẫn sai, chỉ làm chậm thông báo lỗi cho người vận hành.

## Đã làm gì

- `CredentialProvider` + `BasicAuthProvider` (thiếu env → chặn khởi động, báo rõ tên biến), `redactHeaders` che `Authorization` trước khi ghi log.
- Token bucket có **hai cài đặt**: `InMemoryTokenBucketStore` cho test, và `REDIS_TOKEN_BUCKET_LUA` — Lua script nạp + lấy token **nguyên tử** để dùng chung giữa các worker.
- `withRetry`: ưu tiên tuyệt đối `Retry-After` (đọc được cả số giây lẫn HTTP date), lùi 1s→16s có nhiễu ngẫu nhiên, **chỉ thử lại 429 và 5xx**.
- `JiraClient` với `p-limit(8)`, đếm `apiCallsMade` / `rateLimitHits` cho T-11 ghi vào `sync_run`.
- **Đủ 8 endpoint** PRD §2.5, mọi phản hồi validate bằng zod ở biên. `searchIssues` bắt buộc truyền `fields`.
- **18 test** (card yêu cầu 11), không gọi mạng thật.

**Ba điều đáng ghi lại:**

1. **Hàng rào kiến trúc T-01 đã bắt được lỗi thật ngay lần đầu dùng.** Test `tsc --build` đỏ vì `HeadersInit` không có trong lib `ES2023` — lỗi này `pnpm test` thường sẽ không phát hiện, chỉ `typecheck` mới thấy. Việc gộp typecheck vào bộ test hoá ra có giá trị hơn dự kiến.
2. **Thêm test chống lặp vô hạn cho `/worklog/updated`** (không có trong card): nếu Jira trả `updatedTime` không tiến lên mà `lastPage: false`, vòng lặp phân trang sẽ quay mãi. Đã chặn bằng so sánh mốc.
3. **Thêm test 401 không thử lại** (card chỉ nêu 404). Token sai thì thử 5 lần vẫn sai, chỉ làm chậm thông báo lỗi cho người vận hành.
