---
id: T-08
title: Phân tách tiêu đề Sub-task — tách Function và loại task
status: review
model: opus
effort: high
depends_on: ["T-06", "T-07"]
touches:
  - packages/engine/src/parser/parse-subtask-title.ts
  - packages/engine/src/parser/function-key.ts
  - packages/shared/src/subtask-parse.ts
  - packages/engine/src/parser/safe-regex.ts        # sửa lỗi ngoài phạm vi, xem "Đã làm gì"
  - packages/engine/src/parser/safe-regex-engine.test.ts
prd_refs: ["§2.9", "E-27", "E-28", "E-29", "E-31"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-08 · Phân tách tiêu đề Sub-task — tách Function và loại task

## Mục tiêu
Từ tiêu đề Sub-task, tách ra **Function** (hàng của bảng Signboard) và **loại task** (cột). Không có card này thì không dựng được bảng Signboard.

## Ngữ cảnh cần biết

**Format** (PRD §2.9.1):

```
[ProjectName][Team][Phase][FunctionName]_TaskName
```

| Tiêu đề | project | team | phase | **function** | **task** |
|---|---|---|---|---|---|
| `[PAY][TeamA][Design][Login]_Create` | PAY | TeamA | Design | `Login` | `Create` |
| `[PAY][TeamA][Design][Login_Form]_BALReview` | PAY | TeamA | Design | `Login_Form` | `BALReview` |
| `［PAY］［TeamA］［Design］［決済］_JMReview` | PAY | TeamA | Design | `決済` | `JMReview` |

> **Dấu `_` bên trong `FunctionName` không gây mơ hồ**, vì `FunctionName` đã được cặp ngoặc vuông bao lại. Dấu `_` dùng để tách chỉ là dấu nằm **ngay sau `]` cuối cùng**.

**Phase của Task cha luôn thắng** (PRD §2.9.2) — đây là quyết định đã chốt, không phải chỗ để agent tự nghĩ lại:

```
Task cha:  [Phase] Design                                  → DESIGN
  └─ Sub-task: [PAY][TeamA][Development][Login]_Create     → DEVELOPMENT   ⚠ lệch
```

> Cây Jira là cấu trúc thật, tiêu đề chỉ là chữ. Nếu để tiêu đề thắng thì một Task cha có thể chứa Sub-task thuộc nhiều Phase → số liệu cộng dồn không khớp cây Jira.

Phần `[Phase]` trong tiêu đề Sub-task **chỉ dùng để đối chiếu**, lệch thì ghi `PHASE_MISMATCH`.

**Khớp `TaskName` chính xác, không khớp kiểu "chứa"** (PRD §2.9.3):

> Các mã ở đây rất giống nhau (`BALReview` / `FixCommentBAL`). Khớp kiểu "chứa" sẽ sinh nhập nhằng — không đáng, vì đây là danh sách đóng và ngắn.

**`function_key` để gộp hàng** (PRD E-31): `Login` / `login` / `Ｌｏｇｉｎ` phải về **một hàng**. Không gộp thì một Function bị tách thành 3 hàng thiếu dữ liệu.

## Phạm vi

**Trong:**
- Biên dịch mẫu 5 ô giữ chỗ `[{project}][{team}][{phase}][{function}]_{task}`
- Tách 5 thành phần, chấp nhận ngoặc toàn giác
- `function_key` = `function_name` sau NFKC + lowercase
- Khớp `task_type` **chính xác** với danh sách cột trong cấu hình
- Đặt `sb_parse_status`: `OK` / `UNPARSED` / `UNKNOWN_TASK_TYPE`
- So `[Phase]` trong tiêu đề với `phaseCode` của Task cha, lệch thì cảnh báo `PHASE_MISMATCH`

**Ngoài:**
- **Không quyết định Phase** — Phase đã do T-07 xác định từ Task cha, card này chỉ đối chiếu
- Không tính trạng thái Signboard (T-22 làm)
- Không dựng bảng Signboard (card GĐ 4)
- Không đọc/ghi database

## Đầu vào đã có
- `normalize.ts`, `safe-regex.ts`, `compile-pattern.ts` từ **T-07** — **dùng lại, không viết lại**
- `getEffectiveConfig()` từ T-06 — nhận qua tham số
- `signboard_column` (danh sách cột) nằm trong `EffectiveConfig`

## Việc phải làm

1. Mở rộng `compile-pattern.ts` của T-07 để hỗ trợ thêm ô `{project}`, `{team}`, `{phase}`, `{function}`, `{task}`.

   Regex chuẩn (PRD §2.9.1):
   ```
   ^\s*[\[［](?<project>[^\]］]+)[\]］]\s*
        [\[［](?<team>[^\]］]+)[\]］]\s*
        [\[［](?<phase>[^\]］]+)[\]］]\s*
        [\[［](?<function>[^\]］]+)[\]］]\s*
        _\s*(?<task>.+?)\s*$
   ```

2. `function-key.ts` — `toFunctionKey(name)` = NFKC + lowercase. Đây là khoá gộp hàng.

3. `parse-subtask-title.ts`:
   ```typescript
   function parseSubtaskTitle(
     title: string,
     parentPhaseCode: string,      // Phase của Task cha — nguồn sự thật
     config: EffectiveConfig,
   ): {
     sbProject: string | null;
     sbTeam: string | null;
     sbPhaseRaw: string | null;    // [Phase] trong TIÊU ĐỀ, chỉ để đối chiếu
     functionName: string | null;  // dạng hiển thị, giữ nguyên gốc
     functionKey: string | null;   // NFKC + lowercase, để gộp hàng
     taskType: string | null;      // null nếu không khớp cột nào
     sbParseStatus: 'OK' | 'UNPARSED' | 'UNKNOWN_TASK_TYPE';
     warnings: ParseWarning[];
   }
   ```

4. Bảng quyết định `sb_parse_status`:

   | Tình huống | `sbParseStatus` | `functionName` | `taskType` |
   |---|---|---|---|
   | Khớp đủ 5 thành phần, `task` có trong cột | `OK` | có | có |
   | Khớp format nhưng `task` lạ | `UNKNOWN_TASK_TYPE` | có | `null` |
   | Không khớp format | `UNPARSED` | `null` | `null` |
   | Thiếu một cặp ngoặc | `UNPARSED` | `null` | `null` |

5. Đối chiếu Phase: chuẩn hoá `sbPhaseRaw`, chạy qua luật khớp từ khoá (dùng lại T-07) ra một `phaseCode` suy đoán. Khác `parentPhaseCode` → cảnh báo `PHASE_MISMATCH` kèm **cả hai giá trị**. **Kết quả trả về vẫn dùng `parentPhaseCode`.**

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-5** — chuẩn hoá NFKC 4 bước; `function_key` dùng đúng hàm này.
- **C-8** — `re2`, ≤ 200 ký tự, timeout 100ms.
- **C-9** — mã cảnh báo `PHASE_MISMATCH`.
- **C-10** — không đoán bừa: `task` lạ thì để `taskType = null`, **không** tự tạo cột mới.
- **C-11** — Sub-task `UNPARSED` **vẫn được cộng dồn** vào Burndown; card này chỉ đánh dấu, không loại bỏ gì.
- **C-12** — hàm thuần, engine không import `db`/`jira`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Tách thành phần:**
1. `tách đúng 5 thành phần từ "[PAY][TeamA][Design][Login]_Create"`
2. `dấu _ trong FunctionName không gây mơ hồ` — `[PAY][A][Design][Login_Form]_BALReview` → function `Login_Form`, task `BALReview`
3. `ngoặc toàn giác ［］ kiểu Nhật được chấp nhận`
4. `FunctionName tiếng Nhật 決済 tách đúng`

**Gộp hàng:**
5. `Login, login và Ｌｏｇｉｎ cho ra cùng một function_key`
6. `functionName giữ nguyên dạng gốc, chỉ functionKey bị chuẩn hoá`

**Khớp loại task:**
7. `_Create khớp chính xác cột Create`
8. `_CreateScreen KHÔNG khớp cột Create` — chứng minh khớp chính xác, không phải "chứa"
9. `_BALReview khớp BALReview, KHÔNG khớp FixCommentBAL`
10. `_UnitTest cho sbParseStatus = UNKNOWN_TASK_TYPE, functionName vẫn có, taskType = null`

**Phase:**
11. `Phase trong tiêu đề khác Task cha thì kết quả VẪN lấy Phase của Task cha`
12. `trường hợp lệch sinh cảnh báo PHASE_MISMATCH kèm cả hai giá trị`
13. `Phase trong tiêu đề trùng Task cha thì không có cảnh báo nào`

**Không khớp:**
14. `tiêu đề "Họp review thiết kế với khách" cho sbParseStatus = UNPARSED, mọi trường bằng null`
15. `tiêu đề thiếu một cặp ngoặc cho UNPARSED`

## Định nghĩa "xong"
Cho một tiêu đề Sub-task bất kỳ, hàm trả đúng `functionKey`, `taskType` và `sbParseStatus`; ba cách viết khác nhau của cùng một Function gộp về một khoá; và Phase luôn lấy từ Task cha bất kể tiêu đề ghi gì.

## Cạm bẫy đã biết
- **Cám dỗ lớn nhất: dùng `[Phase]` trong tiêu đề Sub-task để phân loại Phase.** Nó nằm ngay đó và trông đáng tin. Nhưng quyết định đã chốt là Task cha thắng — làm ngược lại sẽ khiến cộng dồn không khớp cây Jira, và lỗi này im lặng (biểu đồ vẫn vẽ, chỉ là sai).
- **Đừng viết lại `normalize.ts` và `safe-regex.ts`.** T-07 đã có. Viết lại thì hai parser chuẩn hoá khác nhau và `function_key` sẽ không gộp đúng với chỗ khác.
- **`UNPARSED` không có nghĩa là bỏ qua Sub-task đó.** Nó vẫn phải được cộng dồn đầy đủ vào Burndown (C-11, PRD E-27). Card này chỉ gắn cờ.
- **Tách bằng `split('_')` là sai** khi `FunctionName` chứa `_`. Phải dùng regex có nhóm đặt tên, để cặp ngoặc làm ranh giới.
- **`.+?` trong nhóm `{task}` là non-greedy**, kết hợp với `\s*$` sẽ cắt đúng. Đổi thành `.+` (greedy) vẫn chạy nhưng khoảng trắng cuối lọt vào `taskType` → khớp chính xác thất bại mà nhìn không ra.

## Đã làm gì

**26 test xanh** (card yêu cầu 15). `typecheck` · `lint` · `test` toàn workspace xanh, `test:engine` 1.9s.

### Lỗi phát hiện ngoài phạm vi: `re2` chưa bao giờ chạy

Card bắt tuân C-8 (*"`re2`, ≤ 200 ký tự, timeout 100ms"*). Kiểm tra thì thấy **`re2` không hề được dùng** — không ở test, không ở production. `safe-regex.ts` của T-07 gọi thẳng `require('re2')`, nhưng package này là ESM nên `require` **không tồn tại**: lệnh đó ném `ReferenceError`, rơi vào `catch`, và lùi về `RegExp` gốc trong im lặng.

Bằng chứng: cho chạy `(?=x)x` thì nó **khớp** và không sinh cảnh báo nào. `re2` không hỗ trợ lookahead nên đáng lẽ phải báo `REGEX_INVALID`.

Hậu quả: lớp chống ReDoS quan trọng nhất đã tắt. Đồng hồ 100ms **không thay thế được** — nó chỉ đo *sau khi* `exec()` trả về, nên một regex quay vòng theo hàm mũ vẫn chặn đứng event loop, đồng hồ chỉ ghi nhận lại khi mọi chuyện đã rồi.

Đã sửa bằng `createRequire(import.meta.url)` (giữ được tính đồng bộ mà `await import()` không có), thêm cờ `REGEX_ENGINE` phơi ra bộ máy đang chạy, và thêm `safe-regex-engine.test.ts` với **test hành vi** chứ không chỉ đọc cờ: khẳng định lookahead bị từ chối và bom ReDoS `(a+)+$` trả lời tức thì. 27 test của T-07 vẫn xanh dưới bộ máy nghiêm hơn.

### Bốn quyết định

1. **`SubtaskTitleParser` là class**, không phải hàm rời như chữ ký trong card — cùng lý do T-07: biên dịch mẫu, bảng tra cột và bộ đếm timeout chỉ có nghĩa khi giữ trạng thái qua 500 Sub-task.

2. **Thêm `phaseCode` vào kết quả trả về**, luôn bằng `parentPhaseCode`. Card mô tả kết quả chỉ có `sbPhaseRaw`, nhưng như vậy quy tắc "Task cha luôn thắng" không có gì để test và chỗ gọi vẫn có thể nhặt nhầm `sbPhaseRaw`. Một trường tường minh biến quy tắc thành thứ kiểm chứng được.

3. **Đối chiếu Phase dùng lại `TaskTitleParser`** với hai chỗ ghi đè cấu hình: `titlePatterns: []` (để rơi thẳng xuống tầng khớp từ khoá — `sbPhaseRaw` đã là chữ bóc sẵn) và `fallbackScanFullTitle: true`. Chỗ thứ hai quan trọng: cờ đó vốn dành cho tiêu đề **Task**; nếu PM tắt nó thì việc đối chiếu Sub-task sẽ ngừng hoạt động trong im lặng và `PHASE_MISMATCH` không bao giờ xuất hiện nữa. Có test riêng cho tình huống này.

4. **`[Phase]` không khớp luật nào → KHÔNG báo lệch.** `UNCLASSIFIED` nghĩa là *không biết*, không phải *lệch*. Báo mismatch ở đó là đoán bừa (C-10) và sẽ chôn mất những ca lệch thật.

### Hai thứ thêm ngoài card

- **`tightenDelimiters`** — biểu thức chuẩn ở PRD §2.9.1 có `\s*` giữa các cặp ngoặc, nhưng `compilePattern` escape chữ nguyên văn chứ không tự sinh `\s*`. Siết khoảng trắng cạnh `[` `]` `_` ở **cả tiêu đề lẫn mẫu** (chỉ áp một phía thì mẫu PM gõ có dấu cách sẽ không khớp được nữa). Khoảng trắng *giữa chữ* giữ nguyên: `[Login Form]` không bị đụng tới.
- **`AMBIGUOUS_TASK_COLUMN`** — kiểm tra lúc lưu chỉ chặn mã cột trùng y hệt, không chặn trùng *sau chuẩn hoá*. `Create` và `Ｃreate` là hai dòng khác nhau trên màn hình cấu hình nhưng gộp làm một ở đây, im lặng thì mất hẳn một cột.
