---
id: T-19
title: 20 golden dataset và bộ test theo tính chất
status: review
model: opus
effort: high
depends_on: ["T-17", "T-22"]
touches:
  - packages/engine/test/fixtures/
  - packages/engine/test/golden/
  - packages/engine/test/property/
  - packages/engine/test/helpers/
  - packages/engine/test/perf-baseline.json
  - packages/engine/tsconfig.test.json
  - packages/engine/package.json
  - vitest.config.ts
  - package.json
prd_refs: ["§8.2", "§8.3", "§8.5"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-19 · 20 golden dataset và bộ test theo tính chất

## Mục tiêu
Khoá hành vi của toàn bộ engine bằng 20 kịch bản cố định có kết quả tính tay sẵn, cộng một bộ test theo tính chất. Đây là lưới an toàn cho mọi thay đổi engine về sau.

## Ngữ cảnh cần biết

**PRD §8.2 gọi đây là "trái tim của việc kiểm thử"**: fixture JSON cố định + kết quả mong đợi đã tính tay. Mọi thay đổi engine đều phải chạy qua bộ này.

**20 kịch bản** (PRD §8.2):

| Mã | Kịch bản | Điểm cần bắt |
|---|---|---|
| `GD-01` | Đường đi lý tưởng: 3 Phase, 10 Sub-task, log đều | Actual bám sát Planned |
| `GD-02` | Sub-task có sửa `timeestimate` giữa chừng | Quy tắc 2 thắng quy tắc 3 |
| `GD-03` | Log giờ vượt Original Estimate | Kết quả 0, không âm |
| `GD-04` | Log giờ lùi 3 ngày | Snapshot quá khứ sửa đúng |
| `GD-05` | Thêm 5 Sub-task giữa chừng, 1 cái có `wbs_end_date` muộn hơn | `scope_added_s` đúng; `plan_end` dịch; sinh 1 bản ghi `plan_shift_history` |
| `GD-06` | Done → reopen → Done lại | Trạng thái từng ngày đúng |
| `GD-07` | Toàn bộ tên trạng thái tiếng Nhật | Ánh xạ statusCategory hoạt động |
| `GD-08` | Epic vắt qua Tết Nguyên đán | Ngày nghỉ bị loại khỏi Planned |
| `GD-09` | 500 Sub-task, 5000 worklog | Hiệu năng và bộ nhớ |
| `GD-10` | `timeestimate` bị xoá về null | Rơi đúng xuống quy tắc 3 |
| `GD-11` | Task đổi tiêu đề làm đổi Phase | Phân loại lại toàn bộ lịch sử |
| `GD-12` | Epic vắt qua ngày DST (múi Nhật) | Không lệch mất 1 giờ |
| `GD-13` | Config nhiều mẫu tiêu đề, xung đột ưu tiên, NFKC | Luật ưu tiên chọn đúng; cảnh báo `AMBIGUOUS_PHASE_RULE` |
| `GD-14` | Project ghi đè mẫu tiêu đề `【{name}】` | Kế thừa từng phần đúng |
| `GD-15` | Tổng hợp ngày Phase: 1 thiếu ngày, 1 có reopen | MIN/MAX đúng; `missing_date_count` = 1; `actual_end` lần Done cuối |
| `GD-16` | Thêm Sub-task `wbs_end_date` muộn hơn | `plan_end` dịch; Planned vẽ lại; `shifted_workdays` đúng |
| `GD-17` | Cả Phase thiếu `wbs_*` | Không vẽ Planned, **không đoán bừa**; Actual vẫn vẽ |
| `GD-18` | Sub-task chuyển Phase | `phase_rollup` cả hai Phase tính lại |
| `GD-19` | Phân tách tiêu đề: toàn giác, `_` trong Function, 3 kiểu viết, sai format, TaskName lạ, Phase lệch | Tách đúng; `function_key` gộp; `sb_parse_status` đúng |
| `GD-20` | Cây quyết định Signboard: đủ 6 ca + 2 ca gộp ô | Trạng thái khớp bảng; gộp lấy thứ hạng xấu nhất |

**Test theo tính chất** (PRD §8.3) — 6 tính chất chung + 7 tính chất riêng cho Signboard.

## Phạm vi

**Trong:**
- 20 thư mục fixture `GD-01` → `GD-20`, mỗi thư mục có `input.json` + `expected.json`
- Test runner chạy qua toàn bộ 20 bộ
- 13 test theo tính chất dùng `fast-check`
- Helper dựng fixture (`makeSubtask`, `makeChangelog`, `makeWorklog`)
- Đo hiệu năng `GD-09`, ghi kết quả

**Ngoài:**
- Không sửa code engine — card này **chỉ viết test**. Test đỏ nghĩa là engine sai, phải sửa ở card tương ứng
- Không viết integration test có DB (đã nằm trong card tương ứng)
- Không viết E2E

## Đầu vào đã có
Toàn bộ engine từ T-04, T-07, T-08, T-12, T-13, T-14, T-15, T-16, T-17, T-22.

## Việc phải làm

1. Helper trong `test/helpers/` để dựng fixture gọn, không phải gõ tay JSON dài.
2. **Kết quả mong đợi phải tính tay**, không lấy từ đầu ra hiện tại của code. Ghi cách tính vào comment của `expected.json` — nếu không thì golden test chỉ đóng băng bug hiện có.
3. 20 fixture theo bảng trên. Mỗi bộ có `README.md` ngắn giải thích kịch bản.
4. Runner:
   ```typescript
   describe.each(GOLDEN_IDS)('%s', (id) => {
     it('cho ra đúng kết quả đã tính tay', () => {
       const input = loadFixture(id, 'input.json');
       const expected = loadFixture(id, 'expected.json');
       expect(runEngine(input)).toEqual(expected);
     });
   });
   ```
5. **Mọi fixture cố định ngày "hôm nay"** — truyền `asOfDate` trong `input.json`.
6. 6 tính chất chung (PRD §8.3):
   - Không bao giờ âm
   - Đơn điệu giảm khi không phát sinh và không sửa `timeestimate`
   - Kết thúc bằng 0 khi mọi Sub-task Done
   - Cộng dồn khớp: tổng Phase = Epic, sai số 0
   - Chạy lại không đổi
   - Trần trên: `actual_remaining_s <= total_scope_s + scope_added_s`
7. 7 tính chất Signboard (PRD §8.3):
   - Ô gộp lấy đúng thứ hạng xấu nhất
   - `present = false` ⟹ không có `status`
   - Cột Tổng nhất quán với hàng
   - Done ⟹ luôn `Completed`
   - Chưa Done + thiếu ngày ⟹ luôn `NoPlan`
   - Tổng số ô khớp: `Σ(trạng thái) + emptyCells = hàng × cột`
   - Đổi `asOfDate` chỉ đổi `status`, không đổi `plan_*` và `actual_*`
8. `GD-09` đo thời gian và bộ nhớ, ghi vào `test/perf-baseline.json`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-12** — độ phủ engine ≥ 90%; `pnpm test:engine` **< 10 giây**; test đặt tên theo **hành vi nghiệp vụ**; golden dataset đặt tại `packages/engine/test/fixtures/GD-NN/`; test phụ thuộc ngày phải đóng băng đồng hồ.
- **C-2** — fixture ghi thời lượng bằng **giây**.
- **C-1** — ngày trong fixture là chuỗi `'YYYY-MM-DD'`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:engine` xanh, **đủ 20 golden dataset**, và < 10 giây
- [ ] Độ phủ `packages/engine` ≥ 90%
- [ ] Ghi kết quả đo `GD-09` vào PR
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

Chính card này **là** bộ test. Danh sách:

1. 20 test golden `GD-01` → `GD-20`
2. 6 test theo tính chất chung
3. 7 test theo tính chất Signboard
4. `GD-09 chạy dưới 5 giây với 500 Sub-task và 5000 worklog`
5. `GD-09 dùng dưới 512MB RAM`
6. `mọi fixture đều khai asOfDate tường minh` — meta-test quét thư mục fixture
7. `chạy toàn bộ golden 2 lần cho kết quả giống nhau`

## Định nghĩa "xong"
`pnpm test:engine` chạy xong 20 golden dataset và 13 test theo tính chất trong dưới 10 giây, độ phủ engine ≥ 90%, và mỗi `expected.json` có comment giải thích cách tính tay.

## Cạm bẫy đã biết
- **Cạm bẫy lớn nhất: sinh `expected.json` bằng cách chạy code hiện tại rồi copy đầu ra.** Làm vậy thì golden test chỉ **đóng băng bug hiện có** — chạy xanh mãi mãi mà không chứng minh gì. Phải tính tay và ghi cách tính. Đây là điều dễ làm nhất và vô dụng nhất.
- **`GD-12` (DST) phải dùng múi giờ THẬT SỰ có DST** để có tác dụng. Nhật không có DST từ 1952 — nếu chỉ test `Asia/Tokyo` thì không chứng minh được gì. Thêm một ca `America/New_York` làm lưới chống hồi quy, dù dự án không dùng múi giờ đó.
- **Fixture không khai `asOfDate` sẽ tạo test dễ vỡ.** Meta-test 6 tồn tại để chặn — quét thư mục, bắt lỗi ngay khi có người thêm fixture thiếu trường này.
- **`GD-09` với 500 Sub-task dễ làm `pnpm test:engine` vượt 10 giây.** Nếu vượt, tách nó sang script riêng `test:perf` chứ **đừng nới ngưỡng 10 giây** — ngưỡng đó tồn tại để dev thật sự chạy test thường xuyên.
- **Test theo tính chất "đơn điệu giảm" phải loại đúng hai điều kiện**: không phát sinh Sub-task **và** không ai sửa `timeestimate`. Thiếu một điều kiện thì test đỏ ngẫu nhiên và người sau sẽ tắt nó đi.
- **`toEqual` trên object có `BigInt` sẽ báo lỗi khó đọc.** Chuyển sang `number` ở biên trước khi so sánh.

## Đã làm gì

**20 golden dataset + 20 test theo tính chất + 3 test hiệu năng.** Tổng bộ engine **339 test, chạy 6,2 giây** (ngưỡng C-12 là 10). Độ phủ engine **97,2% dòng lệnh, 94,3% nhánh** (ngưỡng 90%).

### Kết quả mong đợi được tính tay — và đây là bằng chứng

**11 trên 20 bộ khớp ngay từ lần chạy đầu tiên.** Chín bộ còn lại lệch, và mỗi lần lệch tôi phải quyết định: sai ở phép tính của tôi hay sai ở engine?

Cả chín lần đều là **tôi sai**, và mỗi lần đều học được một điều đã ghi vào `_how`:

| Điều tôi hiểu sai | Sự thật | Ghi ở |
|---|---|---|
| Chưa Done thì `actualEnd` là `null` | Ban đầu spec lấy **ngày worklog cuối** kèm cờ `actualEndIsProvisional`; sau đã đổi lại đúng như tôi hiểu: chưa Done thì `actualEnd = null`, không tạm tính (PRD §2.7.2 bản hiện tại) | 7 bộ |
| Mẫu `[{name}]` khớp được đoạn `[Design]` giữa tiêu đề | Mẫu neo hai đầu (`^...$`) nên phải khớp **toàn bộ** tiêu đề; quy ước đúng là `[Phase] {name}` | GD-13 |
| Tiêu đề sai định dạng sinh cảnh báo `NO_SUBTASK_PATTERN` | Đó là cảnh báo mức **cấu hình**; một tiêu đề lẻ đặt sai chỉ mang trạng thái `UNPARSED` | GD-19 |

Nếu tôi sinh `expected.json` bằng cách chạy code rồi chép đầu ra, ba điều trên sẽ **không bao giờ** lộ ra — và đó chính là lý do cạm bẫy số một của card này tồn tại.

### Card thiếu một điều kiện, tìm ra khi viết test

Tính chất *"đơn điệu giảm khi không phát sinh và không sửa timeestimate"* còn thiếu điều kiện thứ ba: **không mở lại**. Một Sub-task Done rồi bị mở lại sẽ đẩy khối lượng còn lại vọt lên — đúng như GD-06 mô tả, và đó là hành vi **đúng**. Bộ sinh dữ liệu đã được ràng buộc để trạng thái chỉ đi tới, không đi lui, và lý do ghi ngay trong test.

Tương tự, trần trên *`actual ≤ scope + added`* chỉ đúng khi **không ai sửa tay ước lượng**: quy tắc 2 cho phép khai "còn 100 giờ" trên một Sub-task 8 giờ, và khi đó vượt trần là hợp lệ.

### Hai lỗi im lặng của bộ công cụ đã sửa

1. **`pnpm typecheck` không hề kiểm `packages/engine/test/`.** Project `tsconfig.json` của engine chỉ khai `include: ["src/**/*.ts"]`, nên cả nghìn dòng test mới viết không được kiểm một chữ nào mà mọi lệnh vẫn xanh. Đã thêm `tsconfig.test.json` và nối vào lệnh `typecheck` của root. Đây là lần thứ **hai** gặp đúng lỗi này trong dự án (lần đầu ở T-20 với `apps/web`).

2. **Test theo tính chất một mình ngốn 21 giây**, đẩy `pnpm test:engine` lên 23 giây. Đã thu nhỏ kịch bản sinh ngẫu nhiên (10 ngày × 6 Sub-task × 150 lượt → 5 ngày × 4 Sub-task × 60 lượt) chứ **không nới ngưỡng 10 giây**. Đánh đổi này được ghi thẳng vào comment: không gian tìm kiếm hẹp hơn thì xác suất bắt ca hiếm cũng thấp hơn.

### Năm meta-test canh chính bộ fixture

Bộ golden dataset tự nó cũng cần được canh, nếu không nó sẽ mục dần:

- đủ **đúng 20 bộ**, đánh số liên tục — thiếu một bộ là đỏ ngay;
- mọi fixture khai `asOfDate` tường minh — engine không được đọc đồng hồ;
- mọi `expected.json` có trường `_how` **dài hơn 60 ký tự** — buộc người viết nói ra mình đã tính thế nào;
- mọi thư mục có `README.md`;
- `id` trong file khớp tên thư mục.

Thêm một test riêng khẳng định GD-09 **đúng là 500 Sub-task và 5000 worklog** — không có nó thì có người rút xuống 5 Sub-task cho nhanh và bài đo hiệu năng biến thành bài đo không đo gì.

### Hiệu năng GD-09

**62ms và 2,3MB** cho 500 Sub-task + 5000 worklog — cách xa ngưỡng 5 giây và 512MB. Ngưỡng nằm ở `test/perf-baseline.json` và được **đọc vào**, không phải ghi ra: cho test tự ghi lại số đo mỗi lần chạy thì ngưỡng sẽ tự nới theo mỗi lần code chậm đi, tức là không còn ngưỡng nào cả. Đây là chỗ làm khác card (card ghi *"ghi vào perf-baseline.json"*).

### Ghi chú về GD-12

Dùng `America/New_York` chứ không dùng `Asia/Tokyo`. Nhật **không có giờ mùa hè từ năm 1952**, nên chỉ kiểm Tokyo thì test sẽ xanh kể cả khi mã nguồn cộng thêm một khoảng lệch cố định — nó không chứng minh được gì cả. Bộ này khẳng định mốc chốt sổ đi từ `04:59:59.999Z` sang `03:59:59.999Z` đúng ngày đổi giờ.
