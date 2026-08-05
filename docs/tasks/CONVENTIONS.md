# Quy ước bắt buộc

Mọi task card **copy phần liên quan** vào mục *Quy ước bắt buộc* của card đó.
Đây là chỗ ngăn agent tự chế lại quy ước đã chốt.

Nguồn nghiệp vụ: [PRD](../PRD_Burndown_Engine.md) · Cấu trúc thư mục: [ARCHITECTURE.md](../ARCHITECTURE.md)

---

## C-1 · Thời gian và múi giờ

Đây là nguồn lỗi khó tìm nhất trong dự án này. Vi phạm mục này là lỗi chặn merge.

| Quy ước | Chi tiết |
|---|---|
| Lưu trữ | Mọi mốc thời gian trong DB dùng `TIMESTAMPTZ`, giá trị lưu ở **UTC** |
| Thư viện | **Bắt buộc `luxon`.** Cấm tự cộng trừ offset bằng số |
| Cấm | `new Date()`, `Date.now()` trong `packages/engine` — có lint rule chặn |
| Truyền ngày | Hàm cần "hôm nay" phải **nhận qua tham số** `asOfDate: string`, không tự đọc đồng hồ |
| Mốc chốt sổ | `DateTime.fromISO(d, { zone: tz }).endOf('day').toUTC()` — 23:59:59.999 giờ **địa phương** |
| Ngày của worklog | Theo trường `started`, **không** theo `created` (PRD E-03) |
| Kiểu ngày thuần | Ngày không có giờ (`wbs_start_date`, `plan_end`…) dùng `DATE` và chuỗi `'YYYY-MM-DD'`, **không** dùng `Date` object |

```typescript
// SAI
const end = new Date(dateStr + 'T23:59:59+07:00');

// ĐÚNG
const end = DateTime.fromISO(dateStr, { zone: tz }).endOf('day').toUTC().toMillis();
```

## C-2 · Đơn vị thời lượng

| Quy ước | Chi tiết |
|---|---|
| Đơn vị lưu | **Giây** (`BIGINT`). Jira trả về giây, giữ nguyên để không mất chính xác |
| Hậu tố tên cột | `_s` — `total_scope_s`, `time_spent_s` |
| Hậu tố tên biến | `Seconds` — `totalScopeSeconds` |
| Đổi sang giờ | **Chỉ ở tầng API/UI**, không đổi trong engine hay DB |
| Cấm | Lưu giờ dạng số thực. `0.1 + 0.2 !== 0.3` |

## C-3 · Đặt tên

| Nơi | Kiểu | Ví dụ |
|---|---|---|
| Bảng DB | `snake_case`, số ít | `daily_snapshot`, `phase_rollup` |
| Cột DB | `snake_case` | `plan_start`, `actual_end_is_provisional` |
| Trường JSON của API | `camelCase` | `planStart`, `actualEndIsProvisional` |
| Type / interface | `PascalCase` | `PhaseRollup`, `SignboardStatus` |
| Hằng số | `SCREAMING_SNAKE` | `MAX_CONCURRENT_JIRA_CALLS` |
| File | `kebab-case.ts` | `resolve-historical-remaining.ts` |

Việc đổi `snake_case` ↔ `camelCase` làm ở **tầng repository**, không rải rác khắp nơi.

## C-4 · Trạng thái Jira

| Quy ước | Chi tiết |
|---|---|
| **Bắt buộc** | Chỉ đọc `fields.status.statusCategory.key` → `new` \| `indeterminate` \| `done` |
| **Tuyệt đối cấm** | So sánh chuỗi `status.name` — tên hiển thị là tiếng Nhật và admin đổi được bất cứ lúc nào |
| Trong changelog | Jira ghi **status ID dạng số**, phải tra qua bảng cache `GET /rest/api/3/status` (PRD §2.3) |

## C-5 · Chuẩn hoá chuỗi trước khi so khớp

Áp dụng cho **cả** chuỗi nguồn lẫn từ khoá, đúng thứ tự này (PRD §2.2.2):

```typescript
const normalize = (s: string) =>
  s.normalize('NFKC')      // 1. gộp toàn giác/bán giác: ﾃｽﾄ → テスト, Ａ → A
   .toLowerCase()          // 2. bỏ phân biệt hoa/thường
   .replace(/\s+/g, ' ')   // 3. gộp khoảng trắng liên tiếp
   .trim();                // 4. cắt hai đầu
```

Bỏ bước NFKC thì việc so khớp sẽ **trượt hàng loạt** trên dữ liệu Jira tiếng Nhật thật, mà nhìn mắt thường hai chuỗi trông y hệt nhau.

## C-6 · Idempotency — chạy lại không được nhân đôi

| Quy ước | Chi tiết |
|---|---|
| Mọi thao tác ghi | Dùng `UPSERT` theo **khoá tự nhiên**, không dùng `INSERT` trần |
| `daily_snapshot` | Khoá `(epic_key, snapshot_date)` |
| `phase_rollup` | Khoá `(epic_key, phase_code)` |
| `worklog_entry` | Khoá `worklog_id` (ID gốc từ Jira) |
| Chống ghi đè dữ liệu cũ | UPSERT phải có `WHERE existing.source_read_at < EXCLUDED.source_read_at` (PRD E-19) |
| Kiểm chứng | Chạy job 2 lần liên tiếp → dữ liệu byte-for-byte giống nhau |

## C-7 · Gọi Jira

| Quy ước | Giá trị |
|---|---|
| Trần chủ động (token bucket trên Redis) | 40 request/giây toàn hệ thống |
| Song song tối đa | 8 (`p-limit`) |
| Số Epic xử lý song song | 4 |
| Thử lại | Tối đa 5 lần: 1s → 2s → 4s → 8s → 16s, **cộng nhiễu ngẫu nhiên 0–500ms** |
| Khi có header `Retry-After` | Ưu tiên tuyệt đối, chờ đúng số giây Jira yêu cầu |
| Luôn truyền `fields=` | Chỉ lấy trường cần, giảm ~70% dung lượng phản hồi |
| Cấm | Thử lại ngay lập tức khi gặp 429 |

Không có nhiễu ngẫu nhiên thì 20 job cùng bị 429 sẽ cùng chờ 4 giây rồi cùng gọi lại — lại 429 tiếp.

## C-8 · Regex do người dùng nhập

PM tự nhập mẫu tiêu đề và regex (PRD §2.2, E-20). Coi đây là **dữ liệu không đáng tin**.

| Quy ước | Chi tiết |
|---|---|
| Thư viện | **`re2`**, không dùng regex gốc của JavaScript |
| Giới hạn độ dài | ≤ 200 ký tự |
| Timeout | 100ms cho mỗi chuỗi |
| Khi quá timeout | Coi như **không khớp**, ghi cảnh báo `REGEX_TIMEOUT`, **không làm sập job** |
| Tự tắt | Một luật timeout > 5 lần → tự vô hiệu hoá và báo PM |

Với mẫu tiêu đề dạng `{name}`: hệ thống **tự sinh regex** và **escape toàn bộ phần còn lại**. PM không bao giờ gõ regex thô trừ khi chủ động bật chế độ `REGEX`.

> **Cạm bẫy đã dính một lần (T-08 phát hiện).** Nạp `re2` bằng `require('re2')` **không chạy** — package là ESM nên `require` không tồn tại, lệnh ném `ReferenceError` và code lùi về `RegExp` gốc **trong im lặng**. Mọi test vẫn xanh, mọi regex vẫn khớp đúng, chỉ có lớp chống ReDoS là biến mất.
>
> Phải dùng `createRequire(import.meta.url)` — `await import()` không dùng được vì hàm khớp là đồng bộ.
>
> Timeout 100ms **không phải** phương án dự phòng cho việc này: nó chỉ đo *sau khi* `exec()` trả về, nên không cắt ngang được regex đang quay vòng. `re2` là tuyến phòng thủ thật, đồng hồ chỉ là thứ ghi nhận.
>
> `safe-regex-engine.test.ts` giữ cho lỗi này không tái diễn, bằng **test hành vi** (lookahead phải bị từ chối) chứ không chỉ đọc cờ.

## C-9 · Xử lý lỗi và log

| Quy ước | Chi tiết |
|---|---|
| Log | JSON có cấu trúc, kèm `correlationId` cho mỗi lần chạy job |
| **Cấm ghi token** | Bộ lọc tự động che header `Authorization` |
| Mã lỗi nghiệp vụ | `SCREAMING_SNAKE`, đúng mã đã đặt trong PRD: `PHASE_MISMATCH`, `REGEX_TIMEOUT`, `ORPHAN_PHASE_CODE`, `INVALID_PHASE_PERIOD`, `FIELD_MAPPING_BROKEN`, `AMBIGUOUS_PHASE_RULE`, `HISTORY_TRUNCATED`, `ESTIMATE_HISTORY_MISSING` |
| Lỗi dữ liệu | **Không làm sập job.** Ghi cảnh báo, bỏ qua bản ghi đó, chạy tiếp |
| Lỗi cấu hình | **Chặn khởi động**, báo rõ. Thà không chạy còn hơn chạy ra số sai |

## C-10 · "Không đoán bừa"

Nguyên tắc xuyên suốt PRD. Khi thiếu dữ liệu:

| Tình huống | Làm gì |
|---|---|
| Sub-task thiếu `wbs_start_date`/`wbs_end_date` | Trạng thái `NoPlan`, **không** suy ra ngày (PRD E-30) |
| Cả Phase thiếu ngày | **Không vẽ** đường Kế hoạch, hiện danh sách cần điền (PRD §2.7.3) |
| Sub-task thiếu Original Estimate | Coi là 0, gắn cờ `MISSING_ESTIMATE`, **không** đoán một con số |
| Tiêu đề không khớp format | `UNPARSED`, **vẫn cộng dồn vào Burndown**, chỉ không lên Signboard (PRD E-27) |

Ép một giá trị mặc định "cho đẹp" sẽ khiến PM tin vào số sai. Thà hiện "chưa có dữ liệu".

## C-11 · Cộng dồn không lọc bỏ

Mọi Sub-task thuộc Phase đều được cộng vào tổng, **kể cả** khi `sb_parse_status = UNPARSED`, thiếu `wbs_*`, hoặc thuộc Phase `UNCLASSIFIED`. Công việc là có thật, giờ đã log là có thật (PRD §2.4).

Chúng chỉ **không hiển thị được** trên Signboard, chứ vẫn nằm đủ trong Burndown.

## C-12 · Test

| Quy ước | Chi tiết |
|---|---|
| Độ phủ `packages/engine` | ≥ 90% |
| Cấm `any` trong engine | `strict: true` |
| `pnpm test:engine` | Phải chạy **< 10 giây**, không cần DB hay mạng |
| Test phụ thuộc ngày | **Bắt buộc đóng băng đồng hồ** (`vi.setSystemTime`) — hoặc tốt hơn: truyền `asOfDate` qua tham số |
| Tên test | Khẳng định một **hành vi nghiệp vụ**, không phải một dòng code |
| Golden dataset | Fixture JSON cố định + kết quả đã tính tay, đặt tại `packages/engine/test/fixtures/GD-NN/` |

```typescript
// SAI — mô tả code
it('returns 0 when status is done')

// ĐÚNG — mô tả nghiệp vụ
it('Sub-task đã Done thì khối lượng còn lại bằng 0, kể cả khi Jira còn sót số dư')
```

## C-13 · Migration

| Quy ước | Chi tiết |
|---|---|
| Công cụ | Prisma Migrate |
| **Cấm sửa migration đã merge** | Cần đổi schema → tạo migration mới |
| Mỗi migration | Phải có kịch bản rollback ghi trong PR |
| Thứ tự tạo bảng | `work_calendar` → `calendar_holiday` → `tracked_epic` → còn lại (có khoá ngoại đi ngược, xem PRD §4.6) |

## C-14 · Trước khi mở PR

- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test` xanh
- [ ] `pnpm e2e` xanh (bắt buộc nếu card có UI)
- [ ] Không đụng file ngoài `touches:` của card
- [ ] Cập nhật `status: review` + `finished_at` trong frontmatter card
- [ ] Ghi 3–5 dòng "Đã làm gì" vào cuối card
