# Thiết kế: Phân tầng linh động theo dự án (Dynamic Tiers)

> **Trạng thái:** BẢN THẢO để thảo luận — chưa chốt, chưa code.
> **Nguồn gốc:** yêu cầu "hệ thống vẫn single-tenant nhưng cho phép mỗi dự án cấu
> hình từ **1 đến N tầng** thay vì cứng **3 tầng** (Epic → Phase → Sub-task) như
> hiện tại".
> **Tài liệu nền:** [PRD §2.1 "Cấu trúc 3 tầng"](./PRD_Burndown_Engine.md),
> [PHASE-MAPPING.md](./PHASE-MAPPING.md), [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 0. Bốn quyết định đã chốt (và một điểm cần xác nhận)

| # | Câu hỏi | Lựa chọn |
|---|---|---|
| 1 | Số tầng linh động lấy từ đâu? | **Nhóm logic theo cấu hình** — bóc từ title/label/custom field, KHÔNG phụ thuộc độ sâu cây Jira |
| 2 | Gốc & lá có linh động không? | **Giữ cố định** — tầng trên cùng = đơn vị theo dõi (Epic, vẽ burndown); tầng đáy = đơn vị mang số liệu (leaf) |
| 3 | "Phase" ứng xử ra sao? | **Một tầng được đánh dấu là Phase** — giữ Signboard / per_phase / plan-shift gắn vào đúng tầng đó |
| 4 | Phạm vi | **Tái kiến trúc N-tầng đầy đủ** — làm mô hình tổng quát tử tế, không chắp vá |

**Điểm "căng" cần bạn xác nhận (giữa #4 và #2/#3):** "Tái kiến trúc đầy đủ"
KHÔNG có nghĩa là làm cho gốc/lá/Phase cũng linh động. Cách hiểu của tôi:

> Xây một **mô hình N-tầng tổng quát, tử tế** (schema + engine + ingest + UI làm
> lại đàng hoàng, không hack), NHƯNG trong đó vẫn giữ 3 bất biến: **gốc = Epic**,
> **lá = đơn vị số liệu**, và **đúng một tầng giữa là Phase**. Phần "linh động" là
> **số tầng nhóm ở giữa (1..N)** và **cách mỗi tầng lấy khoá nhóm**.

Nếu bạn thực sự muốn gốc/lá/Phase cũng cấu hình được thì phạm vi lớn hơn nhiều —
xem [§10 Câu hỏi mở](#10-câu-hỏi-mở).

---

## 1. Hiện trạng: vì sao "3 tầng" đang bị viết cứng

PRD §2.1 định nghĩa cây cứng **EPIC → TASK(=Phase) → SUB-TASK**:

- **EPIC** = đơn vị theo dõi. Có `tracked_epic`, có `daily_snapshot`, vẽ burndown.
- **TASK = PHASE** = tầng nhóm. Không mang số liệu; `phase_code` bóc từ **title của
  chính Task** (2 tầng parse: mẫu tiêu đề → luật từ khoá).
- **SUB-TASK** = lá. **Chỉ tầng này mang số liệu thật**: estimate, worklog,
  `wbs_start/end`, changelog trạng thái. Nó **kế thừa `phase_code` của Task cha**.

Điểm mấu chốt: **toàn bộ engine quy về đúng MỘT khoá nhóm trên mỗi lá — `phaseCode`.**

```
Ingest  (apps/worker/src/pipeline/persist-issues.ts):
        Task.title --parse--> phaseOfTask ; Sub-task --kế thừa--> phaseCode (trên lá)

Engine  (packages/engine/src/{snapshot,rollup}):
        groupBy(sub.phaseCode)          ← DUY NHẤT một chiều nhóm

DB:     jira_issue.phase_code           ← khoá nhóm
        phase_rollup (PK epic_key + phase_code)
        daily_snapshot.per_phase (JSON)

API:    mọi adapter (signboard, burndown, phase-subtasks, plan-conflicts) key theo phase_code
```

Vì chỉ có một khoá nhóm, "thêm tầng" = **thay `phaseCode: string` bằng một VECTƠ
khoá theo thứ tự `groupKeys: string[]`**, và đánh dấu một phần tử là Phase.

---

## 2. Mô hình đích

### 2.1. Bất biến (từ quyết định #2)

- **Gốc** = Epic (đơn vị theo dõi). Luôn trên cùng.
- **Lá** = đơn vị mang số liệu. Luôn dưới cùng. Cộng dồn chảy **từ lá lên**.
- Giữa gốc và lá: một **danh sách có thứ tự các tầng nhóm** `T1 … Tn` (n ≥ 1),
  **đúng một tầng** đánh dấu `role = PHASE`.

### 2.2. Mỗi lá mang một VECTƠ khoá (thay cho một `phaseCode`)

```
Hiện tại:   leaf.phaseCode = "DESIGN"
Đích:       leaf.groupKeys = ["STREAM_A", "DESIGN", "SCREEN"]   // [T1, T2(Phase), T3]
```

Cây phân tầng = **các tiền tố (prefix) của vectơ**:

```
Epic
├─ (STREAM_A)                      ← nút tầng 1
│   ├─ (STREAM_A, DESIGN)          ← nút tầng 2  [Phase]
│   │   ├─ (…, DESIGN, SCREEN)     ← nút tầng 3
│   │   └─ (…, DESIGN, DB)
│   └─ (STREAM_A, DEV)
└─ (STREAM_B) …
```

Đây là **hierarchy lồng nhau (drill-down)** theo thứ tự tầng, không phải các facet
độc lập. Cộng dồn: số liệu của lá được cộng vào **mọi nút tiền tố** trên đường đi
tới gốc.

### 2.3. Cấu hình mỗi tầng

Mỗi tầng trong config của project khai:

| Trường | Ý nghĩa |
|---|---|
| `tierOrder` (1..n) | vị trí từ trên xuống |
| `code`, `labelVi/Ja` | mã + tên tầng (VD "Stream", "Phase", "Screen") |
| `role` | `PHASE` cho đúng một tầng; còn lại `GROUP` |
| `source` | **cách bóc khoá nhóm cho tầng này** (xem dưới) |
| `definitions[]` | danh sách giá trị hợp lệ của tầng (code, label, color, displayOrder) — như `phaseDefinitions` hiện nay; không khớp → bucket `UNCLASSIFIED` của tầng |
| `rules[]`, `titlePatterns[]` | luật/mẫu để ánh xạ (chỉ tầng nào cần) |

**Các `source` đề xuất cho v1:**

| `source` | Bóc khoá từ | Tái dùng code hiện có |
|---|---|---|
| `PARENT_TASK_TITLE` | title của Task cha → mẫu tiêu đề + luật từ khoá | `TaskTitleParser` (nguyên xi Phase hôm nay) |
| `SUBTASK_TITLE_TOKEN` | một token trong mẫu tiêu đề Sub-task (`{team}`, `{function}`…) | `SubtaskTitleParser` |
| `LABEL` | Jira label (lọc theo tiền tố, VD `team:`) | mới, nhỏ |
| `CUSTOM_FIELD` | một custom field Jira (map như `wbs_*`) | mới, nhỏ (để v2 nếu cần) |

> Nhờ giữ `PARENT_TASK_TITLE`, **mô hình 3 tầng hôm nay = cấu hình mặc định có
> đúng 1 tầng nhóm** (role=PHASE, source=PARENT_TASK_TITLE). Không có gì mất đi.

---

## 3. Ánh xạ 3-tầng-hiện-tại → cấu hình mặc định

Bộ config hiện tại (`phase_config_set` + con của nó) trở thành **một tầng duy nhất**:

```
group_tier {
  tierOrder: 1, code: "PHASE", role: PHASE, source: PARENT_TASK_TITLE,
  titlePatterns:  ← phase_title_pattern
  rules:          ← phase_match_rule
  definitions:    ← phase_definition
}
```

`signboard_column`, `subtask_title_pattern`, `sub_phase_order` vẫn gắn với **tầng
Phase + parse lá** (Signboard vốn là tính năng của tầng Phase — quyết định #3).

Kết quả: sau migration, mọi Epic đang chạy **không đổi hành vi** — vẫn 1 tầng Phase.

---

## 4. Thay đổi schema DB + chiến lược migration

Tuân thủ **C-13: cấm sửa migration đã merge — chỉ thêm migration mới.**

### 4.1. Bảng cấu hình (versioned, đứng cạnh `phase_config_set`)

```
group_tier(config_set_id, tier_order, code, label_vi, label_ja,
           role, source_type, source_config JSONB, display_order)
group_tier_definition(config_set_id, tier_order, group_code, label_vi, label_ja,
                      color_hex, display_order)
group_tier_rule(config_set_id, tier_order, keyword, match_mode, group_code, match_priority)
group_tier_title_pattern(config_set_id, tier_order, pattern_text, compiled_regex, sort_order)
```

`phase_definition` / `phase_match_rule` / `phase_title_pattern` → **di trú vào các
bảng trên tại tầng Phase**, rồi ngưng dùng (bỏ ở migration sau khi cutover xong).

### 4.2. Khoá nhóm trên lá

Đề xuất chính: thêm cột **`jira_issue.group_path JSONB`** = mảng mã theo thứ tự
`["k1","k2",…]`. Engine vốn nạp cả cây vào RAM rồi mới cộng, nên JSONB là đủ và
đơn giản nhất. **Giữ `phase_code`** = phần tử của tầng Phase (cho Signboard + tương
thích ngược + truy vấn lọc theo Phase).
*Phương án thay thế:* bảng con `issue_group_key(issue_key, tier_order, group_code)`
nếu cần lọc/nhóm nặng bằng SQL — đánh đổi bằng nhiều JOIN hơn.

### 4.3. Rollup & snapshot

- `phase_rollup`: **giữ cho tầng Phase** (đường Kế hoạch + Signboard cần plan/actual
  dates theo Phase). Nếu cần đường Kế hoạch cho tầng khác khi drill-down → bảng
  tổng quát `group_rollup(epic_key, tier_order, group_path, …)` (đề xuất **hoãn**,
  xem câu hỏi mở #6).
- `daily_snapshot.per_phase` (đã là JSON): **đổi nội dung** thành cây tổng hợp theo
  tầng (`per_tier`/nested) — không cần đổi kiểu cột. Giữ một "view Phase" để API cũ đọc.

---

## 5. Thay đổi engine (`packages/engine`)

| File | Thay đổi |
|---|---|
| `rollup/compute-phase-rollups.ts` | tổng quát hoá thành cộng dồn theo **mọi nút tiền tố**; giữ kết quả tầng Phase cho đường Kế hoạch |
| `snapshot/build-snapshot-for-day.ts` | `byPhase: Map<code,acc>` → `byNode: Map<pathPrefix,acc>`; `perPhase` giữ cho tầng Phase, thêm cây `perTier` |
| `planned/compute-planned-remaining.ts` | giữ tính ở **tầng Phase** (quyết định #3); drill-down theo tầng khác = tính theo yêu cầu |
| `signboard/*` | **gần như không đổi** — Signboard là tính năng tầng Phase; `phaseCode` = `groupKeys[idxPhase]` |
| `parser/*` (mới) | `resolveGroupKeys(leaf, parentTask, config): string[]` — điều phối các `source` |

Ràng buộc vàng vẫn nguyên: engine **thuần tính toán**, không đụng db/jira, không đọc
đồng hồ; cộng dồn **không lọc bỏ gì** (C-11). 20 golden dataset (PRD §8.2) phải xanh;
thêm golden cho n=1 (phẳng) và n=3.

---

## 6. Thay đổi ingest/pipeline (`apps/worker`)

- **Giữ ingest vật lý Epic → Task → Sub-task** (`fetch-epic-tree.ts` gần như nguyên
  xi). Tầng Task vật lý vẫn còn, nhưng giờ chỉ là **một nguồn** khoá tầng
  (`PARENT_TASK_TITLE`). Vì tầng là **logic**, ta KHÔNG phụ thuộc độ sâu cây Jira
  (khớp quyết định #1). *(Đọc độ sâu Jira tuỳ ý = ngoài phạm vi lần này.)*
- `persist-issues.buildRecords`: thay việc gán một `phaseCode` bằng
  `resolveGroupKeys(...)` → ghi `group_path`; `phase_code` = phần tử tầng Phase.
- `dirty:epics` sweep + resync "Toàn bộ" (PHASE-MAPPING §5, §7) vẫn là đường lan
  truyền khi đổi cấu hình tầng — không đổi cơ chế.

---

## 7. Thay đổi API + shared types

- `packages/shared`: `SubtaskRecord.phaseCode` → thêm `groupKeys: string[]` (giữ
  `phaseCode` phái sinh trong giai đoạn chuyển tiếp). Thêm `group-config.ts` (zod
  cho tầng) song song `phase-config.ts`.
- Burndown API: thêm breakdown/drill-down theo tầng; giữ per-phase cho tương thích.
- Signboard / phase-subtasks / plan-conflicts: **giữ key theo tầng Phase**.
- Config API mới: CRUD tầng + validate + **Preview** (xem trước phân loại theo
  cấu hình nháp, như Phase settings hôm nay).

---

## 8. Thay đổi Web UI (`apps/web`)

- Màn hình **"Cấu trúc phân tầng"** mới: khai danh sách tầng có thứ tự, mỗi tầng
  chọn `source` + definitions + rules; đánh dấu một tầng là Phase. Tái dùng khối UI
  của Phase settings.
- **Burndown**: thêm bộ chọn tầng để drill-down (nhóm theo tầng nào); chú giải
  per-phase hiện tại tổng quát hoá thành per-tầng-đang-chọn.
- **Phase settings** cũ → trở thành trình sửa "tầng Phase" nằm trong màn hình mới.
- **Signboard**: khái niệm không đổi (tầng Phase); có thể thêm bộ lọc theo tầng trên.

---

## 9. Lộ trình theo vòng (đúng tinh thần "cần nhiều vòng")

| Vòng | Nội dung | Kết quả có thể ship | Rủi ro |
|---|---|---|---|
| **0** | Tài liệu này + chốt câu hỏi mở | *(đang ở đây)* | — |
| **1** | Schema tầng + migration (3-tầng→config mặc định) + shared types + Config API/validate. **Engine vẫn đọc tier1=Phase, hành vi KHÔNG đổi** | Nền tảng, xanh toàn bộ test cũ | Thấp — không đổi hành vi |
| **2** | Engine tổng quát N-tầng (rollup/snapshot) + `resolveGroupKeys` + ghi `group_path`. Golden n=1/n=3 | Cộng dồn N-tầng chạy được | Trung bình — lõi tính toán |
| **3** | API drill-down + màn hình "Cấu trúc phân tầng" | PM tự cấu hình tầng | Trung bình |
| **4** | Burndown/Signboard drill-down UI + docs + UAT | Trọn tính năng | Trung bình |

Mỗi vòng: `pnpm typecheck && pnpm lint && pnpm test` xanh trước khi sang vòng sau.

---

## 10. Câu hỏi mở

1. **Số tầng tối thiểu.** `role=PHASE` là bắt buộc ⇒ tối thiểu **1 tầng nhóm**
   (Phase luôn có). Có project nào muốn **0 tầng** (Epic → lá phẳng, không Phase)
   không? Nếu có thì Phase phải thành tuỳ chọn — mở rộng #3.
2. **Lồng nhau vs facet độc lập.** Xác nhận mô hình **lồng nhau có thứ tự** (§2.2),
   không phải các chiều nhóm rời rạc.
3. **Ingest vật lý.** Xác nhận **giữ** Epic→Task→Sub-task và bóc tầng từ thuộc tính
   (title cha/label/field/token) — KHÔNG đọc độ sâu cây Jira tuỳ ý.
4. **`source` cho v1.** Đề xuất: `PARENT_TASK_TITLE` + `SUBTASK_TITLE_TOKEN` +
   `LABEL`. `CUSTOM_FIELD` để v2. Đồng ý?
5. **Signboard.** Xác nhận Signboard **vẫn là tính năng tầng Phase**, không tổng
   quát hoá cho mọi tầng (khớp #3).
6. **Đường Kế hoạch drill-down.** Cần đường Kế hoạch cho tầng ≠ Phase khi drill-down
   không, hay chỉ Epic + Phase như hôm nay? (ảnh hưởng có làm `group_rollup` hay không)
7. **Xác nhận cách hiểu ở §0** (full re-architecture nhưng gốc/lá/Phase vẫn cố định).

---

## 11. Rủi ro chính

- **R-A. Di trú dữ liệu sống.** Có Epic đang chạy với `phase_code`. Migration phải
  bọc config cũ thành "tầng 1 = Phase" và backfill `group_path` = `[phase_code]` mà
  không làm thủng biểu đồ. → Vòng 1 giữ hành vi cũ, có script backfill idempotent.
- **R-B. `phaseCode` rải khắp nơi.** ~15 file shared/api tham chiếu. Giữ `phaseCode`
  như bí danh phái sinh của tầng Phase trong suốt quá trình để không phải sửa tất cả
  cùng lúc.
- **R-C. Golden dataset.** 20 bộ vàng khoá theo per_phase. Phải tương thích (n=1 ra
  y hệt) + thêm bộ mới cho N-tầng.
- **R-D. Hiệu năng cộng dồn.** N-tầng nhân số nút; vẫn trong RAM nên chấp nhận được,
  nhưng cần đo với Epic ~500 lá.
