---
id: T-06
title: Kho cấu hình nhận diện Phase — có version và kế thừa theo project
status: review
model: opus
effort: high
depends_on: ["T-02"]
touches:
  - packages/db/src/repositories/phase-config.repository.ts
  - packages/db/src/seed/default-phase-config.ts
  - packages/shared/src/phase-config.ts
  - packages/engine/src/config/merge-inheritance.ts
prd_refs: ["§2.2.1", "§2.2.6", "§2.2.7", "E-22"]
owner: claude
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-06 · Kho cấu hình nhận diện Phase — có version và kế thừa theo project

## Mục tiêu
Lưu, đọc và tạo version mới cho toàn bộ cấu hình nhận diện Phase, kèm cơ chế kế thừa giữa bộ Mặc định và bộ ghi đè theo project. Hai parser (T-07, T-08) và API cấu hình (T-09) đều đọc từ đây.

## Ngữ cảnh cần biết

**Nguyên tắc gốc của cả nhóm cấu hình** (PRD §2.2):

> **Toàn bộ quy tắc nhận diện Phase đều là cấu hình, không có gì viết cứng trong mã nguồn.** PM tự sửa qua màn hình quản trị, xem thử kết quả rồi mới lưu — không cần nhờ dev, không cần deploy lại.

Đây là mấu chốt để giảm rủi ro **R-01** (dữ liệu Jira không sạch, khả năng **Cao**).

**Kế thừa từng phần** (PRD §2.2.6) — ba phần kế thừa **độc lập nhau**:

```
BỘ MẶC ĐỊNH (GLOBAL)
  ├─ mẫu tiêu đề
  ├─ danh sách Phase
  └─ luật khớp từ khoá
        │
        ├── PAY:  không khai gì        → dùng y hệt mặc định
        ├── SHOP: GHI ĐÈ mẫu tiêu đề   → Phase và từ khoá vẫn kế thừa
        └── CRM:  GHI ĐÈ từ khoá       → mẫu và Phase vẫn kế thừa
```

**Version không bao giờ bị xoá** (PRD §2.2.7) — lưu bản mới là tạo version mới, bản cũ giữ nguyên để quay lại được (US-09).

## Phạm vi

**Trong:**
- Repository đọc/ghi 6 bảng cấu hình: `phase_config_set`, `phase_title_pattern`, `phase_definition`, `phase_match_rule`, `subtask_title_pattern`, `signboard_column`
- `getEffectiveConfig(projectKey)` — trả cấu hình **đã gộp kế thừa**, mỗi phần có cờ `inherited: true/false`
- `saveNewVersion()` — tạo version mới, chuyển `is_active` sang bản mới trong **một transaction**
- `rollbackToVersion()` — tạo version mới có nội dung y hệt version cũ
- Kiểm tra hợp lệ theo bảng PRD §2.2.4
- Seed bộ Mặc định: 6 Phase + từ khoá Việt/Nhật/Anh + 5 cột Signboard (PRD §2.2.2, §2.9.3)
- Cache Redis `meta:phaseconfig:{projectKey}` TTL 1 giờ, **xoá ngay khi lưu**

**Ngoài:**
- Không phân tách tiêu đề (T-07, T-08 làm)
- Không làm API HTTP (T-09 làm)
- Không làm UI (T-21 làm)
- Không tính lại snapshot khi đổi cấu hình (T-18 làm)

## Đầu vào đã có
- 6 bảng cấu hình từ T-02
- Enum `ConfigScope`, `MatchMode` từ T-02

## Việc phải làm

1. Type trong `packages/shared/src/phase-config.ts`: `PhaseConfigSet`, `TitlePattern`, `PhaseDefinition`, `MatchRule`, `SignboardColumn`, `EffectiveConfig`.
2. `getEffectiveConfig(projectKey)`:
   - Đọc bộ `GLOBAL` đang `is_active`
   - Đọc bộ `PROJECT` của `projectKey` nếu có
   - Gộp **từng phần độc lập**: phần nào project có khai thì lấy của project, không thì lấy global
   - Mỗi phần gắn cờ `inherited` để UI hiện nhãn "kế thừa từ Mặc định"
3. Logic gộp đặt trong `packages/engine/src/config/merge-inheritance.ts` (hàm thuần, test không cần DB).
4. `saveNewVersion(scope, projectKey, payload, createdBy, note)`:
   - Kiểm tra hợp lệ (bảng dưới)
   - `version = MAX(version) + 1`
   - Trong **một transaction**: đặt `is_active = false` cho bản cũ, thêm bản mới `is_active = true`
   - Xoá cache Redis **ngay**
5. Bảng kiểm tra hợp lệ:

   | Kiểm tra | Mức |
   |---|---|
   | Có ít nhất 1 Phase | ❌ Chặn lưu |
   | `phase_code` không trùng | ❌ Chặn lưu |
   | Luật khớp trỏ tới `phase_code` có tồn tại | ❌ Chặn lưu (E-22) |
   | Regex biên dịch được, ≤ 200 ký tự | ❌ Chặn lưu |
   | Mẫu tiêu đề có đúng một ô `{name}` | ❌ Chặn lưu |
   | Cùng một từ khoá trỏ về 2 Phase khác nhau | ⚠️ Cảnh báo |

6. `rollbackToVersion(scope, projectKey, version)` — đọc nội dung version cũ, gọi `saveNewVersion` với đúng nội dung đó.
7. Seed bộ Mặc định theo bảng PRD §2.2.2 (6 Phase) và §2.9.3 (5 cột Signboard).
8. **Xoá cache khi sửa bộ Mặc định phải xoá `meta:phaseconfig:*` của TẤT CẢ project** — dùng `SCAN`, không dùng `KEYS`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-3** — bảng/cột `snake_case`, JSON API `camelCase`; đổi tên ở tầng repository.
- **C-6** — mọi ghi dùng UPSERT theo khoá tự nhiên.
- **C-8** — regex do người dùng nhập: `re2`, ≤ 200 ký tự, thử biên dịch ngay lúc lưu.
- **C-9** — mã lỗi `SCREAMING_SNAKE`, dùng đúng `ORPHAN_PHASE_CODE`, `AMBIGUOUS_PHASE_RULE`.
- **C-13** — không sửa migration đã merge.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- packages/db` xanh (Testcontainers)
- [ ] `pnpm test:engine` xanh (logic gộp kế thừa)
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Kế thừa** (hàm thuần, không cần DB):
1. `project không khai gì thì kế thừa toàn bộ bộ Mặc định, mọi phần có inherited = true`
2. `project ghi đè mẫu tiêu đề thì Phase và từ khoá vẫn kế thừa` — chứng minh kế thừa **từng phần**
3. `project ghi đè từ khoá thì mẫu tiêu đề và Phase vẫn kế thừa`

**Version** (Testcontainers):
4. `lưu bản mới tạo version tăng dần và chuyển is_active sang bản mới`
5. `version cũ vẫn còn nguyên trong database sau khi lưu bản mới`
6. `mỗi phạm vi chỉ có đúng một bản is_active tại một thời điểm`
7. `quay lại version 4 tạo ra version 6 có nội dung y hệt version 4, version 5 vẫn còn`

**Kiểm tra hợp lệ:**
8. `chặn lưu khi luật khớp trỏ tới phase_code không tồn tại` — mã lỗi `ORPHAN_PHASE_CODE`
9. `chặn lưu khi không có Phase nào`
10. `chặn lưu khi mẫu tiêu đề thiếu ô {name}`
11. `chặn lưu khi regex dài quá 200 ký tự`
12. `chặn lưu khi regex không biên dịch được`
13. `cảnh báo (không chặn) khi một từ khoá trỏ về 2 Phase khác nhau`

**Cache:**
14. `lưu cấu hình project thì cache của project đó bị xoá ngay lập tức`
15. `lưu bộ Mặc định thì cache của TẤT CẢ project bị xoá`

## Định nghĩa "xong"
`getEffectiveConfig('SHOP')` trả về cấu hình đã gộp đúng ba phần kế thừa độc lập, và mọi thao tác lưu đều tạo version mới mà không mất version cũ.

## Cạm bẫy đã biết
- **Kế thừa "tất cả hoặc không có gì" là sai.** Ba phần kế thừa độc lập. Làm nhầm thì project chỉ muốn đổi mẫu tiêu đề sẽ mất sạch danh sách Phase — đây là lỗi im lặng, cấu hình vẫn lưu được nhưng mọi Task rơi vào `UNCLASSIFIED`.
- **Chuyển `is_active` phải nằm trong transaction.** Tách ra 2 lệnh thì có khoảnh khắc không bản nào active (hoặc hai bản cùng active) — partial unique index sẽ ném lỗi giữa chừng.
- **Xoá cache dùng `SCAN`, không dùng `KEYS`.** `KEYS` khoá cả Redis (PRD §4.7).
- **TTL 1 giờ không thay được việc xoá cache chủ động.** PM sửa xong mà cả tiếng sau mới có hiệu lực sẽ tưởng hệ thống hỏng và sửa đi sửa lại.
- **`rollbackToVersion` không được sửa `is_active` của version cũ trực tiếp.** Phải tạo version mới — nếu không, lịch sử bị viết lại và không giải thích được với người dùng.

## Đã làm gì

- `packages/shared/src/phase-config.ts` — zod schema cho toàn bộ cấu hình + `EffectiveConfig` có cờ `inherited` từng phần.
- `packages/engine/src/config/merge-inheritance.ts` — hàm **thuần** `mergeInheritance` (kế thừa 3 phần độc lập) và `validateConfigPayload` (6 lỗi chặn + 1 cảnh báo). Test không cần DB.
- `packages/db/src/repositories/phase-config.repository.ts` — `saveNewVersion` trong **một transaction**, `rollbackToVersion` tạo version mới thay vì sửa `is_active` cũ, `listVersions`, xoá cache ngay khi lưu.
- `DEFAULT_PHASE_CONFIG` — 6 Phase + 29 luật khớp (Việt/Nhật/Anh) + 5 cột Signboard theo PRD §2.2.2 và §2.9.3.
- **19 test** cho phần thuần.

**Ba quyết định thiết kế:**

1. **Mảng rỗng của project = KHÔNG khai, vẫn kế thừa.** Nếu coi mảng rỗng là "đã ghi đè" thì PM lỡ xoá hết luật sẽ mất luôn cả bộ Mặc định, không có đường quay lại ngoài khai lại từ đầu. Đã có test riêng cho ca này.
2. **Mọi `ValidationIssue` đều có `path`** trỏ tới đúng trường gây lỗi (`matchRules[0].phaseCode`). Hiện lỗi thành banner chung ở đầu trang thì PM không biết sửa dòng nào — nhất là khi có 20 luật khớp. T-21 dựa vào trường này để neo thông báo.
3. **Giới hạn 200 ký tự chỉ áp cho `matchMode: REGEX`**, không áp cho `CONTAINS`. Từ khoá thường dài bao nhiêu cũng vô hại; chỉ regex mới có rủi ro ReDoS.

**Chưa làm, để lại cho card sau:** `getEffectiveConfig()` mức repository (ghép `findActiveConfigSet` + `mergeInheritance` + cache) sẽ do **T-09** lắp, vì nó cần cả tầng cache Redis mà card này không đụng tới. Cột `compiledRegex` hiện lưu chuỗi rỗng — **T-07** sinh regex thật khi biên dịch mẫu.
