---
id: T-04
title: Ánh xạ statusCategory — chịu được Jira tiếng Nhật
status: review
model: sonnet
effort: low
depends_on: ["T-03"]
touches:
  - packages/jira/src/status-map.ts
  - packages/engine/src/status/resolve-status-category.ts
  - packages/engine/src/status/index.ts
  - packages/shared/src/status.ts
prd_refs: ["§2.3", "E-13"]
owner: claude
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-04 · Ánh xạ statusCategory — chịu được Jira tiếng Nhật

## Mục tiêu
Hệ thống biết một issue đang ở nhóm `To Do` / `In Progress` / `Done` tại **bất kỳ thời điểm nào trong quá khứ**, và không hỏng khi admin Jira đổi tên trạng thái tiếng Nhật.

## Ngữ cảnh cần biết

Đây là quy tắc quan trọng nhất khi làm với Jira tiếng Nhật (PRD §2.3):

> **Bắt buộc:** Chỉ được đọc trường `fields.status.statusCategory.key`.
> **Tuyệt đối cấm:** So sánh chuỗi tên trạng thái (`status.name`).

Tên hiển thị có thể là `完了`, `対応中`, `未対応`, và **admin đổi được bất cứ lúc nào**. Nhóm thì luôn là 3 giá trị tiếng Anh.

**Điểm khiến card này không tầm thường:**

> Trong `changelog`, khi trạng thái đổi, Jira ghi `from`/`to` là **status ID dạng số** (ví dụ `"10001"`), *không phải* statusCategory.

Nghĩa là muốn biết trạng thái quá khứ thì phải nạp sẵn bảng tra `status_id → statusCategory` từ `GET /rest/api/3/status`, cache lại, rồi tra ngược.

**Ca reopen** (PRD E-13) — hàm phải xử lý đúng luồng `To Do → Done → In Progress → Done`. Không được cache cứng "đã done thì mãi mãi done", vì như vậy khối lượng công việc bị mất luôn khi task được mở lại.

## Phạm vi

**Trong:**
- Nạp bảng `status_id → statusCategory` từ `GET /rest/api/3/status`, cache Redis `meta:statuscategory` TTL 24 giờ
- Hàm thuần `resolveStatusCategoryAt(changelog, statusIdMap, tMs)` trong engine
- Type `StatusCategory` trong shared

**Ngoài:**
- Không tính khối lượng còn lại (T-13 làm)
- Không đọc/ghi database
- Không xử lý các trường changelog khác (`timeestimate`, `parent`…)

## Đầu vào đã có
- `packages/jira` — `getStatuses()` từ T-03
- `packages/shared/src/enums.ts` — enum `StatusCategory` từ T-02

## Việc phải làm

1. `packages/jira/src/status-map.ts` — `loadStatusIdMap()`: gọi `/rest/api/3/status`, dựng `Map<string, StatusCategory>`, cache Redis TTL 24 giờ.
2. `packages/engine/src/status/resolve-status-category.ts` — hàm **thuần**:
   ```typescript
   function resolveStatusCategoryAt(
     changelog: ChangelogEvent[],   // đã sắp xếp tăng dần theo thời gian
     statusIdMap: ReadonlyMap<string, StatusCategory>,
     tMs: number,
   ): StatusCategory
   ```
   Cách làm: bắt đầu từ `'new'` (trạng thái lúc issue mới tạo), tua lần lượt các sự kiện `field === 'status'` cho tới mốc `tMs`, dừng khi vượt qua.
3. Status ID không có trong bảng tra (trạng thái vừa bị xoá) → giữ nguyên trạng thái trước đó, ghi cảnh báo, **không ném lỗi**.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-4** — chỉ đọc `statusCategory.key`; **tuyệt đối cấm** so sánh `status.name`. Changelog ghi status ID dạng số, phải tra bảng.
- **C-9** — lỗi dữ liệu không được làm sập job; ghi cảnh báo rồi chạy tiếp.
- **C-12** — hàm trong engine phải thuần, `pnpm test:engine` < 10 giây.
- Engine **không được** import `packages/jira`. Bảng tra truyền vào qua tham số.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh — đặc biệt kiểm tra engine không import `@app/jira`
- [ ] `pnpm test:engine` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

1. `issue mới tạo chưa có changelog thì thuộc nhóm To Do`
2. `tua đúng trạng thái tại một mốc giữa hai lần đổi` — đổi lúc 09/03 và 12/03, hỏi lúc 10/03 phải ra trạng thái của lần đổi 09/03
3. `sự kiện xảy ra SAU mốc hỏi thì bị bỏ qua`
4. `admin đổi tên hiển thị từ 完了 sang 対応完了 thì vẫn nhận là Done` — cùng status ID, khác `name`
5. `xử lý đúng ca reopen To Do → Done → In Progress → Done` — hỏi tại 4 mốc khác nhau ra 4 kết quả đúng
6. `status ID lạ không có trong bảng tra thì giữ trạng thái trước đó và ghi cảnh báo, không ném lỗi`
7. `bảng tra dựng đúng từ phản hồi /rest/api/3/status có trạng thái tiếng Nhật`
8. `bảng tra lấy từ cache Redis ở lần gọi thứ hai, không gọi lại Jira`

## Định nghĩa "xong"
`resolveStatusCategoryAt` trả đúng nhóm trạng thái tại mọi mốc thời gian trong quá khứ, kể cả khi issue bị mở lại nhiều lần, và không phụ thuộc vào tên hiển thị của trạng thái.

## Cạm bẫy đã biết
- **Cám dỗ lớn nhất: so sánh `status.name === '完了'`.** Chạy đúng hôm nay, hỏng ngay khi admin sửa một ký tự. Đây chính là lỗi mà PRD §2.3 dành hẳn một mục để cảnh báo.
- **Đừng cache "đã done thì mãi mãi done".** Ca reopen (E-13) sẽ mất trắng khối lượng công việc, và lỗi này im lặng — biểu đồ vẫn vẽ ra, chỉ là sai.
- **Changelog phải sắp xếp tăng dần trước khi tua.** Jira không đảm bảo thứ tự. Sai thứ tự thì kết quả sai mà không có lỗi nào.
- **`statusCategory.key` là `'new' | 'indeterminate' | 'done'`**, không phải `'To Do' | 'In Progress' | 'Done'` — đó là `statusCategory.name`. Dùng nhầm sẽ không khớp gì cả.

## Đã làm gì

- `packages/jira/src/status-map.ts` — `loadStatusIdMap()` với interface cache trừu tượng (`StatusMapCache`), không phụ thuộc `ioredis` để engine và worker dùng chung được. Giá trị `statusCategory.key` lạ bị lọc bỏ thay vì đưa dữ liệu rác vào engine.
- `packages/engine/src/status/` — 3 hàm **thuần**: `resolveStatusCategoryAt`, `findFirstInProgressMs`, `findLastDoneMs`. Engine không import `@app/jira`; bảng tra truyền qua tham số.
- `packages/shared/src/issue-history.ts` — `ChangelogEvent`, `WorklogRecord`, `SubtaskRecord`, `StatusIdMap` dùng chung. Comment ghi rõ `startedAtMs` lấy từ `started` chứ không phải `created`.
- **13 test**, gồm ca reopen hỏi tại 5 mốc khác nhau.

**Hai hàm thêm ngoài card:** `findFirstInProgressMs` và `findLastDoneMs`. Card chỉ yêu cầu `resolveStatusCategoryAt`, nhưng T-14 (ngày thực tế của Sub-task) cần đúng hai phép tra này, và quy tắc "lấy lần Done **cuối cùng**" là chỗ dễ sai nhất (PRD E-13). Đặt chúng cạnh nhau ngay từ đây để logic tua changelog nằm một chỗ, kèm test khẳng định `findLastDoneMs` **không** trả về lần Done đầu tiên.
