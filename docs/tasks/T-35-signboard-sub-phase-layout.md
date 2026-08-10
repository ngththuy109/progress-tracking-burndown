---
id: T-35
title: Signboard nhóm cột theo Sub-phase
status: review
model: opus
effort: medium
depends_on: ["T-22", "T-28", "T-31"]
touches:
  - packages/shared/src/api-signboard.ts
  - apps/api/src/services/signboard.service.ts
  - apps/api/src/routes/signboard.routes.ts
  - apps/api/src/adapters/signboard.adapters.ts
  - apps/api/src/routes/signboard.routes.test.ts
  - apps/web/src/routes/signboard/index.tsx
  - apps/web/src/styles.css
  - apps/web/e2e/signboard.spec.ts
  - docs/PRD_Burndown_Engine.md
  - README.md
prd_refs: ["§6.1", "§2.9.1", "§2.9.2"]
owner: claude
started_at: 2026-08-10
finished_at: 2026-08-10
---

# T-35 · Signboard nhóm cột theo Sub-phase

## Mục tiêu
Một Phase có thể chứa nhiều **Sub-phase** (ví dụ Phase `FUT_TestCase` gồm hai Sub-phase `FUT_ConfirmPoint` và `FUT_TestCase`). Bảng Signboard cần vẽ cột **nhóm theo Sub-phase**, các Sub-phase xếp tuần tự hàng ngang, và trong mỗi nhóm là bộ loại task quen thuộc — để PM thấy Function nào trễ, ở khâu nào, **trong Sub-phase nào**.

## Ngữ cảnh cần biết

**Sub-phase đã được parse sẵn, chỉ chưa dùng.** Trong format tiêu đề `[Project][Team][Phase][Function]_Task` (PRD §2.9.1), cặp ngoặc `[Phase]` **ngay trước Function** chính là Sub-phase. Nó đã được `SubtaskTitleParser` bóc ra thành `sbPhaseRaw` và lưu ở cột `jira_issue.sb_phase_raw` từ T-08 — nhưng trước đây **chỉ dùng để cảnh báo `PHASE_MISMATCH`** (§2.9.2), chưa hề đưa lên bảng.

Nghĩa là card này **không cần migration, không đổi parser, không đổi sync** — dữ liệu đã nằm sẵn trong DB.

**`buildSignboard` nằm ở tầng service API** (`apps/api`), KHÔNG ở `packages/engine`. Engine chỉ export logic cấp-ô (`resolveCellStatus`, `mergeCell`). Nên đổi cách nhóm cột **không đụng tới engine thuần** và luật "engine không đọc đồng hồ" — `SignboardCell` giữ nguyên.

**Phase thật vẫn là Phase của Task cha** (§2.9.2). Sub-phase chỉ để **nhóm cột trên bảng**, không phân loại lại cây Jira. Đây là ranh giới quan trọng: lấy `sbPhaseRaw` thay Phase cha sẽ làm số cộng dồn lệch khỏi cây Jira.

## Phạm vi

**Trong:**
- Cột hai tầng: tầng 1 = Sub-phase, tầng 2 = loại task; bộ loại task lặp lại dưới mỗi Sub-phase
- Thứ tự Sub-phase theo `display_order` của cấu hình Phase (khớp mã), Sub-phase lạ xếp sau A→Z
- Nhóm dự phòng "(No sub-phase)" cho Sub-task thiếu bracket, xếp cuối
- Cột Σ mỗi Sub-phase + cột Overall toàn hàng
- Header lưới hai tầng ở web, cột Function/Overall dính (`rowspan`)

**Ngoài:**
- Không migration, không đổi parser/sync — `sb_phase_raw` đã có
- Không đụng `packages/engine` — logic ô giữ nguyên
- Không thêm bảng cấu hình Sub-phase riêng — tái dùng `phase_definition` để lấy nhãn + thứ tự

## Việc phải làm

1. `packages/shared`: thêm `subPhaseRaw` vào `SignboardSubtask`; thêm `columnGroups`, `subtotals`, `subPhaseKey` vào `SignboardResponse` + zod (giữ `cells`/`columns` là mảng **lá đã làm phẳng** 1:1).
2. `apps/api` service: `buildSignboard` gộp ô theo `(subPhaseKey, taskType)`, sinh `columnGroups`, cột phẳng, `subtotals`, `total`; xếp thứ tự Sub-phase.
3. `apps/api` route + adapter: `SELECT i.sb_phase_raw`; thêm cổng `subPhaseMeta(projectKey)` trả nhãn + thứ tự (tái dùng truy vấn `phase_definition` của `phases()`), khoá `normalize(phase_code)`.
4. `apps/web`: header 2 tầng (`colSpan`/`rowSpan`), cột Σ mỗi nhóm, giữ Function/Overall dính; CSS vạch ngăn nhóm.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):
- **E-31** — gộp theo khoá đã chuẩn hoá (NFKC + lowercase); áp cho cả `functionKey` lẫn `subPhaseKey`.
- **C-9** — thông báo tiếng Việt, nói cả cách khắc phục.
- Ranh giới engine (ARCHITECTURE.md §2) — không đưa việc nhóm cột vào engine.

## Checklist đầu ra
- [x] `pnpm typecheck` xanh
- [x] `pnpm lint` xanh (kể cả hai hàng rào kiến trúc)
- [x] `pnpm test` xanh (965 pass, 1 skip)
- [x] `pnpm e2e` xanh (65 pass)
- [x] Cập nhật `status: review` + `finished_at`

## Đã làm gì

### Sub-phase = `sbPhaseRaw` — không sinh dữ liệu mới, chỉ surface thứ đã có
Phát hiện then chốt: cặp `[Phase]` trước Function đã được parse thành `sbPhaseRaw` và lưu ở `jira_issue.sb_phase_raw` từ lâu, chỉ chưa ai đọc lên bảng. Cả card không có một dòng migration nào — chỉ thêm `SELECT i.sb_phase_raw` vào truy vấn dựng bảng đã có.

### Cột phẳng + metadata nhóm — để `SignboardCell` khỏi phải đổi
`rows[].cells` vẫn là **mảng phẳng 1:1** với `columns` (cột lá) như trước, nên `mergeCell`/`resolveCellStatus`/component vẽ ô không phải đụng. Cái mới chỉ là **thêm**: `columnGroups` lái header nhóm, `subtotals` cho cột Σ mỗi Sub-phase. Khoá gộp ô đổi từ `taskType` → `(subPhaseKey, taskType)`.

### Thứ tự Sub-phase mượn nguyên bộ máy Phase
`FUT_ConfirmPoint`/`FUT_TestCase` thường trùng mã một Phase, nên thay vì dựng bảng cấu hình Sub-phase mới, cổng `subPhaseMeta` tái dùng đúng truy vấn `phase_definition` mà `phases()` đã dùng — khoá theo `normalize(phase_code)` để khớp với `sbPhaseRaw` (đã chuẩn hoá cùng cách). Khớp cấu hình → theo `display_order` + lấy nhãn Phase; lạ → A→Z sau; thiếu bracket → nhóm "(No sub-phase)" cuối cùng.

### Việc nhóm cột nằm ở service, KHÔNG ở engine
`buildSignboard` ở `apps/api`, nên toàn bộ thay đổi tránh được ranh giới engine: logic quyết định trạng thái ô (thứ phụ thuộc "hôm nay") giữ nguyên, hai hàng rào lint vẫn xanh.

### Test
Thêm 8 test đơn vị ở `signboard.routes.test.ts` (nhóm theo `[Sub-phase]`, thứ tự theo config, khớp trước lạ sau, ô xếp đúng nhóm, cột Σ, nhóm dự phòng cuối, `totalCells`) và 1 e2e (hai Sub-phase → header nhóm + cột lặp). Các test cũ giữ nguyên nhờ mặc định một Sub-phase.

### Sửa kèm: mock e2e trả sai hình dạng cho `/phases`
Trong lúc chạy e2e phát hiện `installApi` trả **board body** cho endpoint `/phases`, làm PhaseNav báo lỗi và trang có hai `role="alert"` — một lỗi **có sẵn từ trước**, chỉ không lộ vì môi trường này thiếu đúng bản trình duyệt Playwright. Đã thêm nhánh `/phases` trả đúng hình dạng `{ epicKey, phases }`; test banner "hơn 30%" hết va vào alert thứ hai.

## Bổ sung sau (theo yêu cầu tiếp theo của PM)

Hai điều chỉnh giao diện thuần web (`signboard/index.tsx` + `styles.css` + e2e), không đụng API/engine:

1. **Ô trống tô xám.** Ô `present:false` (Function không có khâu đó) nay có nền `--tone-neutral-bg` phủ cả ô để lùi ra sau. Vẫn khác hẳn `NO_PLAN` (giữ kẻ sọc, nổi lên).
2. **Tô nền cả ô theo trạng thái** (PRD §6.1, bảng màu mới): Done → đen/chữ trắng, On schedule → xanh dương, Late start/finish → đỏ, NYS → không tô, NO_PLAN → giữ kẻ sọc. `data-status` được đưa lên `<td>` (không chỉ `<span>`) để màu phủ hết ô; badge trên ô đã tô chuyển sang viền trắng nền trong suốt, chữ trạng thái vẫn còn nên màu không phải thứ duy nhất mang nghĩa. Áp cho cả cột Σ và Overall để lướt là thấy hàng đỏ.
3. **Thanh tóm tắt / chú giải khớp bảng màu mới.** Chip số đếm ở thanh tóm tắt bỏ badge sắc thái cũ (xanh lá/hổ phách nhạt), chuyển sang `.signboard__count[data-status]` **dùng chung đúng bộ màu solid với ô** (một nguồn màu duy nhất trong CSS, không lệch được). NO_PLAN giữ chip tím nhạt vì ô của nó cũng không tô đặc.
4. **Ghi ô "không có task" vào chú giải.** Dòng "empty cells" cũ (chữ mờ) đổi thành chip xám `.signboard__count--empty` đúng bằng nền ô trống, kèm số đếm. Nhân đó đổi chip `NYS` từ xám sang **trắng + viền** (khớp ô NYS *không tô*) để không trùng màu với chip ô trống.
5. **Hint "chỉnh thứ tự Sub-phase ở đâu".** PM phản hồi: chọn Phase có nhiều Sub-phase nhưng "chưa tìm thấy chỗ setting thứ tự hiển thị sub-phase trên signboard". Vòng đầu chỉ thêm hint trỏ về ② Phase list (nơi thứ tự đang được "mượn"); PM phản hồi tiếp rằng ② là setting của **Phase**, không phải chỗ khai thứ tự Sub-phase trong một Phase cố định → làm hẳn chỗ setting riêng ở mục 6, hint đổi sang trỏ tới đó.

6. **Khu "⑤ Sub-phase order" — chỗ setting riêng cho thứ tự Sub-phase** (vòng hai, có đổi API + schema, KHÔNG đổi engine):
   - **Phần cấu hình mới `subPhaseOrders`** trong đúng bộ máy version của `phase_config_set`: bảng mới `sub_phase_order` (migration `20260810000000_sub_phase_order` + ROLLBACK), mỗi dòng `(phase_code, sub_phase_code, display_order)`; đi qua `saveNewVersion`/`rollbackToVersion` như mọi phần, kế thừa GLOBAL→PROJECT **theo phần** như PRD §2.2.6. Validate lúc lưu: trùng cặp (Phase, Sub-phase) sau chuẩn hoá E-31 → ERROR `DUPLICATE_SUB_PHASE`; trỏ Phase không có trong danh sách → WARNING `SUB_PHASE_UNKNOWN_PHASE` (dòng thừa vô hại, không chặn).
   - **UI**: khu ⑤ mới ở màn **Signboard columns** (`/config/signboard`), nhóm theo Phase — mỗi nhóm một ô mã Phase + danh sách Sub-phase có mũi tên lên/xuống; `displayOrder` đánh lại 1..n TRONG nhóm. Phase không có Sub-phase thì không khai gì (đúng yêu cầu). Kế thừa project có nhãn + nút Override riêng như khu ④.
   - **Đường tắt từ bảng**: hint ở màn Signboard (khi ≥ 2 nhóm) giờ là link "Set sub-phase order" mở thẳng khu ⑤ với **Phase đang xem + đúng các Sub-phase đang có trên bảng điền sẵn** (`?orderPhase=…&subs=…`, gửi khoá đã chuẩn hoá chứ không gửi nhãn — nhãn đẹp của Phase trùng mã sẽ không khớp lại được với tiêu đề).
   - **Thứ tự trên bảng** giờ có 4 bậc: khai ở khu ⑤ (`pinned`, thắng tuyệt đối, theo đúng thứ tự PM xếp) → trùng mã Phase thì "mượn" `display_order` như cũ → lạ A→Z → "(No sub-phase)" cuối. Bảng chưa khai gì thì y hệt trước — không đổi hành vi ngầm.
