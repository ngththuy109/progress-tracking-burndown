---
id: T-07
title: Phân tách tiêu đề Task — nhận diện Phase
status: review
model: opus
effort: high
depends_on: ["T-06"]
touches:
  - packages/engine/src/parser/normalize.ts
  - packages/engine/src/parser/compile-pattern.ts
  - packages/engine/src/parser/parse-task-title.ts
  - packages/engine/src/parser/safe-regex.ts
  - packages/engine/src/parser/index.ts
  - packages/shared/src/parse-result.ts
prd_refs: ["§2.2.1", "§2.2.2", "§2.2.3", "§2.2.8", "E-20", "E-31"]
owner: claude
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-07 · Phân tách tiêu đề Task — nhận diện Phase

## Mục tiêu
Từ tiêu đề một Task, xác định nó thuộc giai đoạn nào (`DESIGN`, `DEVELOPMENT`…) hoàn toàn theo cấu hình PM khai — không viết cứng bất kỳ từ khoá nào trong mã nguồn.

## Ngữ cảnh cần biết

**Hai tầng, xử lý lần lượt** (PRD §2.2.1):

```
Tiêu đề Jira:  "[Phase] 基本設計"
      │
      ├─ Tầng 1: mẫu "[Phase] {name}"  →  bóc ra:  "基本設計"
      │
      └─ Tầng 2: từ khoá "基本設計"     →  kết quả:  DESIGN
```

**Cú pháp `{name}` là mấu chốt để PM không phải học regex** (PRD §2.2.1):

| PM gõ | Khớp tiêu đề | Bóc ra |
|---|---|---|
| `[Phase] {name}` | `[Phase] Design` | `Design` |
| `【{name}】` | `【基本設計】画面一覧` | `基本設計` |
| `{no}. {name}` | `01. Thiết kế` | `Thiết kế` |

Hệ thống tự dịch `{name}` → `(?<name>.+?)`, `{no}` → `(?<no>\d+)`, và **escape toàn bộ phần còn lại**.

**Quy tắc ưu tiên khi khớp nhiều từ khoá** (PRD §2.2.3) — tách bạch hai khái niệm dễ lẫn:

| Trường | Nghĩa |
|---|---|
| `display_order` | Thứ tự **hiển thị trên biểu đồ** |
| `match_priority` | Thứ tự **ưu tiên khi so khớp**, số nhỏ thắng |

Xét lần lượt: (1) `match_priority` nhỏ hơn thắng → (2) bằng nhau thì **từ khoá dài hơn thắng** → (3) vẫn bằng thì lấy dòng trên cùng + cảnh báo `AMBIGUOUS_PHASE_RULE`.

> Nhờ quy tắc 2, `[Phase] Design Review` tự khớp `Design Review` (13 ký tự) thay vì `Design` (6 ký tự) — PM không phải cấu hình gì thêm.

## Phạm vi

**Trong:**
- Chuẩn hoá NFKC 4 bước (dùng chung với T-08)
- Biên dịch mẫu `{name}` → regex an toàn, escape phần còn lại
- Bọc `re2` có timeout (dùng chung với T-08)
- Thử lần lượt nhiều mẫu, mẫu nào khớp trước thì dùng
- Lưới an toàn: không mẫu nào khớp → tìm từ khoá trên **toàn bộ** tiêu đề (nếu `fallback_scan_full_title` bật)
- Khớp từ khoá 2 chế độ `CONTAINS` / `REGEX` + quy tắc ưu tiên 3 bước
- Trả về `UNCLASSIFIED` + `raw_phase_label` khi không nhận diện được

**Ngoài:**
- Không phân tách tiêu đề Sub-task (T-08 làm) — nhưng **chia sẻ** `normalize.ts` và `safe-regex.ts`
- Không đọc cấu hình từ DB — nhận qua tham số
- Không đọc/ghi database
- Không làm API hay UI

## Đầu vào đã có
- `getEffectiveConfig()` từ T-06 — card này **nhận kết quả qua tham số**, không tự gọi
- Type `EffectiveConfig`, `MatchRule` từ T-06
- `re2` đã cài từ T-01

## Việc phải làm

1. `normalize.ts` — 4 bước theo C-5: NFKC → lowercase → gộp khoảng trắng → trim.
2. `safe-regex.ts` — bọc `re2`: giới hạn 200 ký tự, timeout 100ms mỗi chuỗi, quá timeout trả "không khớp" + cảnh báo `REGEX_TIMEOUT`, một luật timeout > 5 lần thì tự vô hiệu hoá.
3. `compile-pattern.ts` — `{name}` → `(?<name>.+?)`, `{no}` → `(?<no>\d+)`, **escape mọi ký tự khác** (`[`, `]`, `.`, `-`, `(`, `)`…). Chấp nhận ngoặc toàn giác `［］`.
4. `parse-task-title.ts`:
   ```typescript
   function parseTaskTitle(
     title: string,
     config: EffectiveConfig,
   ): { phaseCode: string; rawPhaseLabel: string | null; warnings: ParseWarning[] }
   ```
   - Thử từng mẫu theo `sort_order`, mẫu nào khớp trước thì lấy `{name}`
   - Không mẫu nào khớp và `fallback_scan_full_title` bật → dùng cả tiêu đề làm chuỗi tìm
   - Khớp từ khoá theo quy tắc ưu tiên 3 bước
   - Không khớp → `UNCLASSIFIED`, `rawPhaseLabel` = phần bóc được (hoặc `null`)
5. Trả về **luật nào đã thắng** để màn hình Xem thử (T-09) hiển thị được.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-5** — chuẩn hoá NFKC đúng 4 bước, áp dụng cho **cả** tiêu đề lẫn từ khoá.
- **C-8** — dùng `re2`, giới hạn 200 ký tự, timeout 100ms, quá timeout thì coi như không khớp và **không làm sập job**.
- **C-9** — mã cảnh báo `AMBIGUOUS_PHASE_RULE`, `REGEX_TIMEOUT`.
- **C-10** — không đoán bừa: không khớp thì `UNCLASSIFIED`, không tự gán Phase gần đúng.
- **C-12** — hàm thuần, `pnpm test:engine` < 10 giây. Engine không được import `db`/`jira`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Chuẩn hoá:**
1. `ﾃｽﾄ nửa giác và テスト toàn giác được coi là cùng một chuỗi`
2. `Ａ toàn giác và A bán giác được coi là cùng một chuỗi`

**Biên dịch mẫu:**
3. `mẫu [Phase] {name} khớp được "[Phase] Design" và bóc ra "Design"` — chứng minh `[` `]` được escape đúng
4. `mẫu 【{name}】 khớp được tiêu đề Nhật và bóc ra 基本設計`
5. `mẫu {no}. {name} khớp "01. Thiết kế" và bóc ra "Thiết kế"`
6. `mẫu thiếu ô {name} bị từ chối biên dịch`

**Ưu tiên khớp:**
7. `"[Phase] Design Review" khớp Design Review chứ không khớp Design` — từ khoá dài hơn thắng
8. `match_priority nhỏ hơn thắng dù từ khoá ngắn hơn`
9. `hai luật cùng priority cùng độ dài thì lấy dòng trên và cảnh báo AMBIGUOUS_PHASE_RULE`
10. `display_order KHÔNG ảnh hưởng tới kết quả khớp` — đổi `display_order` không đổi `phaseCode`

**Lưới an toàn và không khớp:**
11. `tiêu đề "詳細設計" không có tiền tố vẫn nhận ra DESIGN khi bật fallback_scan_full_title`
12. `tắt fallback thì tiêu đề không có tiền tố trả UNCLASSIFIED`
13. `khớp mẫu nhưng tên lạ thì trả UNCLASSIFIED kèm rawPhaseLabel giữ nguyên tên gốc`

**Regex an toàn:**
14. `regex ReDoS (a+)+$ bị timeout sau 100ms, trả không-khớp, KHÔNG ném lỗi`
15. `luật bị timeout 6 lần thì tự vô hiệu hoá và ghi cảnh báo`

## Định nghĩa "xong"
Cho một `EffectiveConfig` và một tiêu đề bất kỳ, hàm trả về đúng `phaseCode` theo quy tắc ưu tiên 3 bước, và một regex độc hại do PM nhập không thể làm treo tiến trình.

## Cạm bẫy đã biết
- **Escape sai khi biên dịch mẫu là lỗi nguy hiểm nhất ở đây.** `[Phase] {name}` mà không escape thì `[Phase]` trở thành character class khớp một ký tự bất kỳ trong `Phase` — mẫu vẫn "chạy" nhưng khớp lung tung. Test 3 tồn tại chính vì lỗi này im lặng.
- **Quy tắc "từ khoá dài hơn thắng" phải so trên chuỗi **đã chuẩn hoá**,** không phải chuỗi gốc — toàn giác và bán giác có độ dài khác nhau.
- **Đừng gộp `display_order` và `match_priority`.** Chúng là hai khái niệm khác nhau; PRD §2.2.3 dành riêng một mục để tách bạch. Gộp lại sẽ khiến đổi thứ tự hiển thị trên biểu đồ làm đổi luôn kết quả phân loại.
- **`re2` không hỗ trợ lookahead/lookbehind.** Nếu PM nhập regex có `(?=...)`, `re2` sẽ ném lỗi biên dịch. Bắt lỗi đó lúc lưu (T-06) chứ đừng để nổ lúc chạy job đêm.
- **Timeout phải áp cho từng chuỗi, không phải cho cả lô.** Áp cho cả lô thì một tiêu đề độc hại vẫn kịp treo 100ms × 500 issue.

## Đã làm gì

- `normalize.ts` — 4 bước NFKC, thêm `normalizePreservingCase` cho ca cần so khớp không phân biệt hoa thường nhưng vẫn trả chuỗi gốc để hiển thị (T-08 dùng cho `functionName`).
- `compile-pattern.ts` — `{name}` `{no}` và 5 ô cho T-08, escape toàn bộ phần còn lại, **mở rộng ngoặc vuông sang toàn giác** `［］`.
- `safe-regex.ts` — `SafeRegexRunner` giữ trạng thái: nhớ mẫu đã biên dịch và **đếm timeout theo từng mẫu** để đạt ngưỡng tự vô hiệu hoá.
- `parse-task-title.ts` — `TaskTitleParser` dựng sẵn từ một `EffectiveConfig`, **sắp xếp luật một lần trong constructor** thay vì sắp lại cho mỗi tiêu đề.
- **27 test** (card yêu cầu 15). `pnpm test:engine` 3.1s.

**Bốn quyết định thiết kế:**

1. **Dùng class thay vì hàm thuần như card mô tả.** Card viết `parseTaskTitle(title, config)`. Nhưng biên dịch mẫu và đếm timeout regex chỉ có ý nghĩa khi trạng thái giữ qua nhiều lần gọi — gọi hàm rời cho 500 Sub-task thì biên dịch lại 500 lần và bộ đếm timeout không bao giờ đạt ngưỡng 5. `TaskTitleParser` vẫn thuần theo nghĩa không I/O và không đọc đồng hồ hệ thống.
2. **Độ dài từ khoá đo trên chuỗi ĐÃ CHUẨN HOÁ**, đúng như cạm bẫy card cảnh báo. Đã sắp xếp sẵn trong constructor bằng `normalize(b.keyword).length - normalize(a.keyword).length`.
3. **Chỉ cảnh báo `AMBIGUOUS_PHASE_RULE` khi hai luật cùng ưu tiên, cùng độ dài VÀ trỏ về Phase khác nhau.** Hai luật cùng trỏ về một Phase thì không nhập nhằng gì, cảnh báo chỉ gây nhiễu.
4. **`MAX_REGEX_LENGTH` gộp về `safe-regex.ts`.** T-06 khai riêng một bản, gây lỗi trùng export lúc typecheck — nhưng vấn đề thật là hai chỗ có thể lệch nhau: kiểm tra lúc lưu cho qua mà lúc chạy lại từ chối. `merge-inheritance.ts` giờ import từ nguồn duy nhất.

**Ba test thêm ngoài card, đều cho ca escape sai:** mẫu `[Phase] {name}` **không** khớp chuỗi thiếu ngoặc vuông; dấu `.` trong `{no}. {name}` là chữ nguyên văn chứ không phải ký tự bất kỳ; ô giữ chỗ lặp hai lần bị từ chối. Escape sai là lỗi im lặng — mẫu vẫn chạy nhưng khớp lung tung, nên cần test khẳng định cả chiều **không khớp**.
