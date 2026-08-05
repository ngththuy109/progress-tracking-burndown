---
id: T-17
title: Dựng snapshot một ngày và cộng dồn ba tầng
status: review
model: opus
effort: high
depends_on: ["T-13", "T-16"]
touches:
  - packages/engine/src/snapshot/build-snapshot-for-day.ts
  - packages/engine/src/snapshot/diff-scope.ts
  - packages/engine/src/snapshot/index.ts
  - packages/shared/src/snapshot.ts
prd_refs: ["§2.4", "§4.4", "E-01", "E-02"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-17 · Dựng snapshot một ngày và cộng dồn ba tầng

## Mục tiêu
Ghép mọi mảnh lại: cho một ngày, tính khối lượng còn lại của từng Sub-task, cộng dồn lên Phase rồi lên Epic, kèm đường Kế hoạch. Đây là hàm sinh ra một dòng `daily_snapshot`.

## Ngữ cảnh cần biết

**Cộng dồn 3 tầng** (PRD §2.4):

```
Số liệu của Phase  = TỔNG số liệu của các Sub-task thuộc Phase đó
Số liệu của Epic   = TỔNG số liệu của các Phase thuộc Epic đó
```

**Cộng dồn KHÔNG lọc bỏ gì cả** (PRD §2.4) — quy tắc quan trọng:

> **Mọi** Sub-task thuộc Phase đều được cộng vào, kể cả Sub-task `UNPARSED`, thiếu `wbs_*`, hoặc thuộc Phase `UNCLASSIFIED`. Công việc là **có thật** và giờ đã log là **có thật**.

**Chỉ Sub-task mang số liệu thật** (PRD §2.1) — Task và Epic không tự có số giờ riêng. Nếu ai đó nhập Original Estimate trực tiếp vào Task, hệ thống **bỏ qua** để tránh đếm hai lần.

**Sub-task đang hoạt động tại `T_d`** — đã tạo và chưa bị gỡ:

```typescript
const active = subtasks.filter(s =>
  s.createdAtMs <= T && (s.removedAtMs === null || s.removedAtMs > T)
);
```

**`scope_added_s` / `scope_removed_s` so với snapshot NGÀY HÔM TRƯỚC**, không so với baseline (baseline đã bị bỏ).

## Phạm vi

**Trong:**
- `buildSnapshotForDay(epic, subtasks, phaseRollups, dateStr, tz, calendar, statusIdMap)`
- Lọc Sub-task đang hoạt động tại `T_d`
- Cộng dồn `remaining`, `spent`, `original` lên từng Phase rồi lên Epic
- Đếm `count_todo` / `count_in_progress` / `count_done`
- Gọi `computePlannedRemaining` cho đường Kế hoạch
- `diffScopeAgainstPreviousDay` — chênh lệch tổng ước lượng so với ngày trước

**Ngoài:**
- Không lặp qua nhiều ngày (T-18 làm)
- Không ghi database (T-18 làm)
- Không xử lý khoá Redis (T-18 làm)
- Không đọc DB, không đọc đồng hồ

## Đầu vào đã có
- `resolveHistoricalRemaining()`, `totalSpentTill()`, `resolveOriginalEstimateAt()` từ **T-13**
- `computePlannedRemaining()` từ **T-16**
- `resolveStatusCategoryAt()` từ **T-04**
- `endOfDayUtcMs()` từ **T-12**
- `PhaseRollup` từ **T-15**

## Việc phải làm

1. Type `DailySnapshot` và `PhaseSnapshot` trong shared, khớp cột bảng `daily_snapshot` (T-02).
2. `buildSnapshotForDay`:
   ```typescript
   const T = endOfDayUtcMs(dateStr, tz);

   const active = subtasks.filter(s =>
     s.createdAtMs <= T && (s.removedAtMs === null || s.removedAtMs > T)
   );

   let actualRemaining = 0, totalSpent = 0, totalScope = 0;
   const perPhase: Record<string, PhaseSnapshot> = {};
   const counts = { todo: 0, inProgress: 0, done: 0 };

   for (const sub of active) {
     const remaining = resolveHistoricalRemaining(sub, T, statusIdMap);
     const spent     = totalSpentTill(sub, T);
     const original  = resolveOriginalEstimateAt(sub, T);
     const category  = resolveStatusCategoryAt(sub.changelog, statusIdMap, T);

     actualRemaining += remaining;
     totalSpent      += spent;
     totalScope      += original;
     counts[mapCategory(category)]++;

     const p = (perPhase[sub.phaseCode] ??= emptyPhaseSnapshot());
     p.remainingSeconds += remaining;
     p.spentSeconds     += spent;
     p.originalSeconds  += original;
   }

   const planned = computePlannedRemaining(phaseRollups, totalScope, dateStr, calendar);
   ```
3. **Cộng dồn theo `phaseCode` lấy từ Task cha**, không theo `sb_phase_raw`.
4. `diffScopeAgainstPreviousDay(prevSnapshot, currentTotalScope)`:
   - Tăng → `scope_added_s`, giảm → `scope_removed_s`
   - Không có snapshot ngày trước (ngày đầu tiên) → cả hai bằng 0
5. Đặt `source_read_at` = mốc job đọc dữ liệu từ Jira (nhận qua tham số), phục vụ chống ghi đè dữ liệu cũ (E-19).

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — `endOfDayUtcMs` dùng luxon; không đọc đồng hồ.
- **C-2** — mọi giá trị là **giây**.
- **C-4** — đếm trạng thái qua `statusCategory`.
- **C-10** — không đoán bừa.
- **C-11** — **cộng dồn không lọc bỏ gì**: Sub-task `UNPARSED`, thiếu `wbs_*`, `UNCLASSIFIED` đều được cộng đủ.
- **C-12** — hàm thuần.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Cộng dồn:**
1. `tổng của các Phase bằng đúng giá trị của Epic, sai số 0`
2. `Sub-task UNPARSED vẫn được cộng đủ vào tổng` — bỏ nó ra thì tổng thiếu
3. `Sub-task thiếu wbs_* vẫn được cộng đủ vào tổng`
4. `Sub-task thuộc Phase UNCLASSIFIED vẫn được cộng vào tổng của Epic`
5. `Original Estimate nhập trực tiếp trên Task cha KHÔNG được cộng` — tránh đếm hai lần

**Lọc theo thời điểm:**
6. `Sub-task tạo sau mốc T không xuất hiện trong snapshot ngày đó`
7. `Sub-task bị gỡ khỏi Epic vẫn xuất hiện trong snapshot của những ngày TRƯỚC khi gỡ`
8. `Sub-task bị gỡ không xuất hiện trong snapshot từ ngày gỡ trở đi`

**Đếm trạng thái:**
9. `count_todo, count_in_progress, count_done cộng lại bằng số Sub-task đang hoạt động`

**Chênh lệch phạm vi:**
10. `thêm Sub-task 30 giờ thì scope_added_s = 30 giờ quy ra giây`
11. `gỡ Sub-task 16 giờ thì scope_removed_s đúng bằng 16 giờ`
12. `ngày đầu tiên không có snapshot trước thì scope_added_s và scope_removed_s đều bằng 0`

**Ghép với đường Kế hoạch:**
13. `snapshot chứa cả plannedRemaining và actualRemaining`
14. `mọi Sub-task đều Done thì actualRemaining bằng 0`

## Định nghĩa "xong"
Cho một tập Sub-task và một ngày, hàm trả về một `DailySnapshot` đầy đủ trong đó tổng các Phase khớp chính xác giá trị của Epic, và Sub-task chưa tạo hoặc đã gỡ được lọc đúng theo mốc thời gian.

## Cạm bẫy đã biết
- **Cám dỗ: loại Sub-task `UNPARSED` ra khỏi phép cộng "cho sạch dữ liệu".** Đây là lỗi nghiêm trọng — tổng khối lượng Epic sẽ thiếu hụt và đường Burndown sai. C-11 và PRD §2.4 nói rõ điều ngược lại. Test 2–4 tồn tại vì cám dỗ này rất thật.
- **Cộng cả Original Estimate của Task cha là đếm hai lần.** Task chỉ là vật chứa; số liệu nằm ở Sub-task. Lỗi này làm tổng phồng gấp đôi mà nhìn biểu đồ không ra ngay.
- **Điều kiện gỡ phải là `removedAtMs > T`, không phải `>=`.** Dùng `>=` thì snapshot đúng ngày gỡ vẫn tính Sub-task đó — lệch một ngày.
- **`??=` trên object phải khởi tạo đủ mọi trường số về 0.** Thiếu một trường thì `undefined + 5 = NaN`, và `NaN` lan ra toàn bộ tổng mà không có lỗi nào.
- **`source_read_at` phải là mốc **đọc** Jira, không phải mốc **tính xong**.** Nhầm hai cái thì cơ chế chống ghi đè dữ liệu cũ (E-19) mất tác dụng.

## Đã làm gì

**22 test xanh** (card yêu cầu 14). Tổng của các Phase khớp giá trị Epic với **sai số 0** — kiểm bằng cách cộng lại `perPhase` và so với ba trường tổng.

### Test 5 của card không cài được, và đó là tin tốt

Card yêu cầu: *"Original Estimate nhập trực tiếp trên Task cha KHÔNG được cộng"*. Nhưng `buildSnapshotForDay` chỉ nhận `SubtaskRecord[]` — **không có đường nào** để số liệu của Task cha lọt vào. Lỗi đếm hai lần bị chặn ở tầng kiểu dữ liệu, không cần trông vào test.

Đã giữ lại một test khẳng định điều đó, nhưng nó kiểm chứng *hình dạng API* chứ không phải một nhánh logic.

### Hai thứ thêm ngoài card

1. **Đường Kế hoạch cho TỪNG Phase** (`PhaseSnapshot.plannedRemainingS`). Card chỉ nói cộng dồn `remaining`/`spent`/`original`. Nhưng chế độ xem "một Phase" ở PRD §5.1 cần đường Kế hoạch riêng của Phase đó, và dữ liệu ấy phải nằm sẵn trong `per_phase` để **đổi Phase không phải tải lại trang**. Phase không có rollup (ví dụ `UNCLASSIFIED`) thì trả `null` — không vẽ, không đoán.

2. **Test "mọi trường số của mọi Phase đều hữu hạn"** — duyệt toàn bộ trường bằng `Object.entries`. Card cảnh báo `undefined + 5 = NaN` lan ra toàn bộ tổng; một test quét sạch sẽ bắt được cả trường thêm sau này mà người viết quên khởi tạo.

### Một chỗ dễ sai đã kiểm chứng riêng

`removedAtMs > T` chứ **không** phải `>=`. Test dựng một Sub-task gỡ lúc 08:00 ngày 12/03 giờ VN rồi so snapshot ngày 11 với ngày 12: đúng ngày gỡ thì nó phải biến mất. Dùng `>=` sẽ lệch một ngày và không có gì báo.

### Đếm trạng thái TẠI MỐC T

Có test riêng: Sub-task Done ngày 20/03 thì snapshot ngày 10/03 phải đếm nó vào `countTodo`, không phải `countDone`. Dùng trạng thái *hiện tại* thay vì trạng thái *tại mốc* sẽ làm mọi snapshot quá khứ tự viết lại sau mỗi lần đồng bộ.
