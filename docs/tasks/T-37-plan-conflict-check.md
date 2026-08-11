---
id: T-37
title: Kiểm tra plan rơi vào ngày nghỉ theo phía làm (VN / JP)
status: review
model: opus
effort: medium
depends_on: ["T-08", "T-32", "T-36"]
touches:
  - packages/db/prisma/migrations/20260811000000_signboard_column_side/**
  - packages/shared/src/api-plan-conflicts.ts
  - packages/shared/src/phase-config.ts
  - apps/api/src/services/plan-conflicts.service.ts
  - apps/api/src/routes/plan-conflicts.routes.ts
  - apps/api/src/adapters/plan-conflicts.adapters.ts
  - apps/web/src/routes/phase-subtasks/**
  - apps/web/src/routes/epics/**
  - apps/web/src/routes/config-signboard/**
prd_refs: ["§2.9.3", "§9.3", "Phụ lục C (bổ sung 2026-08)"]
owner: null
started_at: 2026-08-11
finished_at: 2026-08-11
---

# T-37 · Kiểm tra plan rơi vào ngày nghỉ theo phía làm (VN / JP)

## Mục tiêu

Mỗi task do người VN làm và người JP (khách hàng) review — hai phía nghỉ khác
ngày nhau. Card này để PM phát hiện ngay sau mỗi lần sync: Sub-task nào có
ngày bắt đầu / kết thúc kế hoạch rơi trúng ngày nghỉ của **phía làm nó**, để
sửa plan trên Jira trước khi thành trễ thật.

## Ngữ cảnh cần biết

- **Quyết định đã chốt (trao đổi với PM, 2026-08-11):** phía làm được cấu hình
  trên **cột Signboard** (Create, BALReview, JMReview…) — mỗi cột một cờ
  `side: VN | JP`. Sub-task đã lưu sẵn `task_type` khớp cột (T-08), nên không
  cần cấu hình gì thêm ở mức từng ticket.
- **Chỉ soi hai mốc start/end.** Khoảng plan vắt qua ngày nghỉ là bình thường —
  đường Kế hoạch đã tự loại các ngày đó khi chia (T-16). Vi phạm là khi chính
  mốc rơi trúng ngày không làm việc.
- **Chọn lịch theo phía:** VN → lịch THỰC THI của chính Epic; JP → lịch chuẩn
  khách hàng `JP_STANDARD`.
- Hệ thống đồng bộ một chiều từ Jira, nên "kiểm tra khi làm plan" = báo cáo
  sau-sync, tính LÚC ĐỌC (lịch và cấu hình cột đổi được bất kỳ lúc nào).

## Phạm vi

**Trong:** migration thêm `side` vào `signboard_column` (mặc định `'VN'`,
CHECK VN|JP); ô chọn phía trên màn Signboard columns; hàm thuần
`computePlanConflicts`; API chi tiết theo Epic + API tổng hợp cho màn Epics;
badge ⚠ trên màn Phase sub-tasks; cột "On days off" trên màn Epics.

**Ngoài:** KHÔNG tách công thức burndown theo phía — task JP vẫn tính vào
scope và cháy theo lịch thực thi của Epic. KHÔNG chặn ghi gì lên Jira.

## Đầu vào đã có

- `jira_issue.task_type` (T-08) — khớp CHÍNH XÁC `task_code` cột Signboard.
- `isWorkday` (engine T-12), lịch + ngày lễ có dữ liệu thật từ T-36.
- Cơ chế version cấu hình (T-06) — `side` đi theo `phase_config_set` sẵn có.
- `assertCanRead` (T-24) — luật PM chỉ xem project mình (§9.3).

## Việc phải làm

1. Migration mới `20260811000000_signboard_column_side` (C-13: không sửa
   migration cũ) + cập nhật Prisma schema, zod `signboardColumnSchema`
   (`side` mặc định `'VN'` để payload cũ vẫn parse được), repository config,
   seed mặc định (JMReview → JP), bộ sinh SQL seed.
2. Hàm thuần `computePlanConflicts`: tra `task_type` → cột → phía → lịch;
   kiểm hai mốc; không tra được phía → kiểm theo VN và gắn
   `sideResolved: false` (C-10). Kết quả sắp theo `issueKey` (C-6).
3. Route `GET /api/epics/:epicKey/plan-conflicts` (404 / quyền như biểu đồ) và
   `GET /api/plan-conflicts/summary` (PM chỉ nhận project mình).
4. Web: banner tổng hợp + badge ⚠ kèm lý do trên màn Phase sub-tasks (không
   chặn màn hình khi API kiểm tra lỗi); cột "On days off" trên màn Epics bấm
   sang màn Sub-tasks.

## Quy ước bắt buộc

- **C-10** — không đoán bừa: không rõ phía thì nói rõ "checked as VN", không
  bỏ qua trong im lặng.
- **C-6** — thứ tự ổn định; **C-13** — cấm sửa migration đã merge.
- **§9.3** — PM chỉ thấy project mình phụ trách, kể cả ở endpoint tổng hợp.

## Checklist đầu ra

- [x] Typecheck: `pnpm typecheck` xanh
- [x] Test: `pnpm test` xanh (plan-conflicts.service.test.ts, plan-conflicts.routes.test.ts)
- [x] Cập nhật `status: review` + `finished_at`
- [x] Ghi "Đã làm gì" cuối card

## Test phải viết

1. `task phía VN bắt đầu thứ Bảy → vi phạm WEEKEND ở mốc START`
2. `task phía VN kết thúc đúng ngày Tết → HOLIDAY kèm tên ngày lễ`
3. `task JMReview (side JP) bị soi bằng lịch JP — cùng ngày đó phía VN không vi phạm`
4. `khoảng plan vắt qua cuối tuần/ngày lễ không phải vi phạm`
5. `taskType null hoặc cột đã xoá → kiểm theo VN, sideResolved=false, đếm sideUnknownCount`
6. `Epic không theo dõi 404; PM khác project 403; chưa đăng nhập 401`
7. `summary chỉ trả Epic có vi phạm; PM chỉ nhận project mình`
8. `phía VN dùng lịch thực thi của Epic, phía JP dùng JP_STANDARD`

## Định nghĩa "xong"

PM đặt cột JMReview sang phía JP, sync Epic; Sub-task JMReview có
`wbs_end_date` rơi đúng ngày lễ Nhật hiện badge ⚠ trên màn Phase sub-tasks kèm
tên ngày lễ, và màn Epics đếm được số vi phạm của từng Epic.

## Cạm bẫy đã biết

- **Soi cả khoảng thay vì hai mốc** sẽ báo vi phạm cho gần như mọi task dài
  hơn một tuần (vắt qua cuối tuần) — cảnh báo nhiều đến mức bị bỏ qua, chức
  năng chết vì "nhàm".
- `task_type` là kết quả parse tiêu đề: NULL rất phổ biến ở dự án đặt tên chưa
  chuẩn. Bỏ qua nhóm này trong im lặng là bỏ sót đúng chỗ dữ liệu bẩn nhất.
- Đừng chốt kết quả vào snapshot đêm: đổi `side` hoặc import thêm ngày lễ phải
  thấy hiệu lực ngay khi F5.

## Đã làm gì

- Migration `side` + toàn bộ đường ống schema/repo/seed/UI cấu hình cột.
- Hàm thuần `computePlanConflicts` + 2 route + adapter Prisma (Phase lấy từ
  Task cha theo PRD §2.9.2).
- Badge ⚠ và banner trên màn Phase sub-tasks; cột "On days off" trên màn Epics.
- 19 test mới cho service + route.
