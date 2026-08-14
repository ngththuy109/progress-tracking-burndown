# Thiết kế: Phân tầng linh động theo dự án (Dynamic Tiers)

> **Trạng thái:** ĐÃ TRIỂN KHAI — Vòng 1–5 xong (xem lộ trình §9). Engine, config, ingest
> (CONTAINER + QUERY), persist N tầng, drill-down UI, và ca "Giai đoạn" (GĐ trong title Task
> cha, Signboard lọc theo nhóm, Xem thử) đều đã có; 20 golden dataset giữ byte-identical
> suốt các vòng (không đổi hành vi Epic 3 tầng đang chạy).
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
| 2 | Gốc & lá có linh động không? | **Giữ cố định VAI TRÒ** — tầng trên cùng = đơn vị theo dõi (vẽ burndown); tầng đáy = đơn vị mang số liệu (leaf). *Loại issue của gốc thì linh động — xem §2.1.* |
| 3 | "Phase" ứng xử ra sao? | **Một tầng được đánh dấu là Phase** — giữ Signboard / per_phase / plan-shift gắn vào đúng tầng đó |
| 4 | Phạm vi | **Tái kiến trúc N-tầng đầy đủ** — làm mô hình tổng quát tử tế, không chắp vá |

**Điểm "căng" cần bạn xác nhận (giữa #4 và #2/#3):** "Tái kiến trúc đầy đủ"
KHÔNG có nghĩa là làm cho gốc/lá/Phase cũng linh động. Cách hiểu của tôi:

> Xây một **mô hình N-tầng tổng quát, tử tế** (schema + engine + ingest + UI làm
> lại đàng hoàng, không hack), NHƯNG trong đó vẫn giữ 3 bất biến **về VAI TRÒ**:
> **gốc = đơn vị theo dõi** (issue được đăng ký, BẤT KỲ loại — Epic/Task/Story…),
> **lá = đơn vị số liệu**, và **đúng một tầng là Phase**. Phần "linh động" là
> **số tầng nhóm (1..N)**, **cách mỗi tầng lấy khoá nhóm**, và **loại + độ sâu
> vật lý của cây Jira** (2 tầng, 3 tầng…).

Nếu bạn thực sự muốn gốc/lá/Phase cũng cấu hình được thì phạm vi lớn hơn nhiều —
xem [§10 Câu hỏi mở](#10-câu-hỏi-mở).

### 0.1. Chốt để vào Vòng 1

| # | Chốt |
|---|---|
| Phạm vi | Tái kiến trúc N-tầng; **cố định VAI TRÒ** gốc/lá/Phase, nhưng loại issue gốc + độ sâu + selector `CONTAINER`/`QUERY` linh động |
| Tối thiểu | **1 tầng nhóm** (Phase bắt buộc) |
| Nguồn khoá v1 | `PARENT_TASK_TITLE` + `SELF_TITLE` + `SUBTASK_TITLE_TOKEN` + `LABEL` (`CUSTOM_FIELD` → v2) |
| Xác định lá | khai **loại issue lá** trong config + lưới an toàn "không có con" |
| Signboard | thuộc **tầng Phase** |
| Burndown case phẳng | **(B)** — mỗi scope = một burndown |
| `QUERY` selector | tách **vòng riêng** (nặng nhất — R-F), không nhồi Vòng 2 |

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

### 2.1. Bất biến (từ quyết định #2) — cố định VAI TRÒ, không cố định loại issue

- **Gốc** = **đơn vị theo dõi được đăng ký** — **hoặc** một issue container (Epic,
  Task đóng vai "Project", Story…) mà lá là hậu duệ của nó, **hoặc** — khi cây
  **phẳng** không có container — **một phạm vi truy vấn (JQL)** mà lá là các ticket
  khớp. Luôn trên cùng. Có `daily_snapshot`, vẽ burndown. *Loại issue và **độ sâu
  vật lý** của cây Jira là linh động* — xem [§2.4](#24-ví-dụ-project-2-tầng-task--sub-task)
  và [§2.5](#25-ví-dụ-project-phẳng-chỉ-có-task-mọi-tầng-bóc-từ-title).
- **Lá** = đơn vị mang số liệu (estimate/worklog/`wbs_*`/status). Luôn dưới cùng.
  Cộng dồn chảy **từ lá lên**. "Lá" = issue mang số liệu, xác định theo cấu hình
  (loại issue lá, hoặc "issue không có con") — KHÔNG cứng là "Sub-task".
- Giữa gốc và lá: một **danh sách có thứ tự các tầng nhóm LOGIC** `T1 … Tn` (n ≥ 1),
  **đúng một tầng** đánh dấu `role = PHASE`. Các tầng này là **logic** (bóc từ thuộc
  tính), **không** nhất thiết trùng tầng issue vật lý nào.

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
| `PARENT_TASK_TITLE` | title của Task **cha** → mẫu tiêu đề + luật từ khoá | `TaskTitleParser` (nguyên xi Phase hôm nay) |
| `SELF_TITLE` | title của **chính lá** → mẫu tiêu đề + luật từ khoá | `TaskTitleParser` chạy trên title lá (case 2 tầng — §2.4) |
| `SUBTASK_TITLE_TOKEN` | một token trong mẫu tiêu đề Sub-task (`{team}`, `{function}`…) | `SubtaskTitleParser` |
| `LABEL` | Jira label (lọc theo tiền tố, VD `team:`) | mới, nhỏ |
| `CUSTOM_FIELD` | một custom field Jira (map như `wbs_*`) | mới, nhỏ (để v2 nếu cần) |

> Nhờ giữ `PARENT_TASK_TITLE`, **mô hình 3 tầng hôm nay = cấu hình mặc định có
> đúng 1 tầng nhóm** (role=PHASE, source=PARENT_TASK_TITLE). Không có gì mất đi.

### 2.4. Ví dụ: project 2 tầng (Task → Sub-task)

Kịch bản: **Jira chỉ có 2 tầng vật lý. Task đóng vai Project (đơn vị theo dõi),
Sub-task là lá. Phase gom từ title của CHÍNH sub-task**, sub-task cùng phase cộng
dồn khi vẽ Burndown.

```
Task PAY (đăng ký làm "tracked root")          ← GỐC = đơn vị theo dõi (vẽ burndown)
├─ Sub-task "[Design] Vẽ màn hình"   Est 16h    ─┐
├─ Sub-task "[Design] Thiết kế DB"   Est 24h    ─┼─ gom logic theo Phase (bóc từ
├─ Sub-task "[Dev] API giao dịch"    Est 40h    ─┘   title của chính sub-task)
└─ Sub-task "[Test] Viết test case"  Est 40h
```

Cấu hình cho project này:

```
tracked root = PAY   (issueType = Task, KHÔNG phải Epic)
tiers = [
  { tierOrder: 1, code: "PHASE", role: PHASE, source: SELF_TITLE,
    titlePatterns: ["[{name}] {rest}"], rules: [Design→DESIGN, Dev→DEV, Test→TEST] }
]
leaf = Sub-task
```

**Kết quả:** mỗi Sub-task `groupKeys = ["DESIGN"|"DEV"|"TEST"]` (n=1 tầng, nguồn =
title của lá). Engine `groupBy` khoá đó → cộng dồn per-phase → Burndown Task PAY,
và burndown-by-phase như thường. **Không cần Epic, không cần tầng Task-cha vật lý.**

Điểm khác duy nhất so với mô hình mặc định: **gốc là Task (2 tầng vật lý)** và
**source = `SELF_TITLE`** thay vì `PARENT_TASK_TITLE`. Cả hai đều nằm trong khả năng
của thiết kế — chỉ cần ingest linh động độ sâu và cho đăng ký gốc là issue bất kỳ
(xem [§6](#6-thay-đổi-ingestpipeline-appsworker)).

### 2.5. Ví dụ: project phẳng (chỉ có Task, mọi tầng bóc từ title)

Kịch bản: Jira **KHÔNG có phân cấp** — chỉ một rổ ticket **Task phẳng**. Mỗi Task tự
mang số liệu (est/worklog) → **Task CHÍNH LÀ lá**. Project, Phase, Sub-phase đều bóc
từ `summary` của cùng ticket đó. Tính toán gom nhóm theo **Phase**.

```
Title ví dụ:  "[PAY][Design][Screen] Vẽ màn hình thanh toán"

tracked scope = QUERY( jql: "project = PAY AND type = Task" )   ← KHÔNG có issue container
tiers = [
  { tierOrder:1, code:"PROJECT",  role:GROUP, source:SELF_TITLE, token:{project}  },
  { tierOrder:2, code:"PHASE",    role:PHASE, source:SELF_TITLE, token:{phase}    },
  { tierOrder:3, code:"SUBPHASE", role:GROUP, source:SELF_TITLE, token:{subphase} },
]
leaf = Task   (loại issue lá khai trong config)
```

**Kết quả:** mỗi Task `groupKeys = ["PAY","DESIGN","SCREEN"]`. Engine `groupBy` tầng
Phase → cộng dồn → Burndown; drill-down `PROJECT → PHASE → SUBPHASE`. **Không có Epic,
không có bất kỳ ticket container nào** — phạm vi theo dõi định nghĩa bằng **JQL**.

Khác biệt so với 2 ví dụ trên: gốc là **`QUERY` selector**, không phải một issue.
Đây là mức tổng quát cao nhất trong ba case — và là lý do cần khái niệm **"tracked
scope"** ở [§6](#6-thay-đổi-ingestpipeline-appsworker).

> **ĐÃ CHỐT (câu hỏi mở #8): phương án (B)** — mỗi tracked scope = **một** burndown;
> "Project" là một tầng drill-down. Muốn tách burndown theo Project thì đăng ký
> nhiều scope JQL. → không cần "auto-split theo tầng trên cùng", key snapshot vẫn
> theo scope id.

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

- **Khái niệm "tracked scope" với 2 kiểu selector** (thay cho "đăng ký một Epic"):
  `tracked_epic` hiện chỉ nhận Epic key. Tổng quát thành một selector:
  - `CONTAINER(issueKey)` — lá = hậu duệ của issue, mọi độ sâu (Epic 3 tầng §2.1,
    Task 2 tầng §2.4).
  - `QUERY(jql)` — lá = ticket khớp JQL, KHÔNG cần container (project phẳng §2.5).

  Giữ tên cột/bảng `tracked_epic`/`epic_key` cho tương thích, nhưng ngữ nghĩa mở
  rộng thành "scope id". `POST /api/epics/validate|browse` cũng nới để nhận cả loại
  issue theo cấu hình lẫn JQL, không chỉ Epic.
- **Ingest linh động theo selector.** `fetch-epic-tree.ts` đang cứng 2 query giả
  định đúng Epic→Task→Sub-task. Phải tổng quát theo selector rồi **xác định LÁ** =
  issue mang số liệu theo cấu hình (loại issue lá đã khai, hoặc "issue không có
  con"):
  - `CONTAINER`: gom gốc + toàn bộ hậu duệ. Case 2 tầng: con trực tiếp chính là lá
    (bỏ query tầng ba); case 3 tầng: như hiện tại.
  - `QUERY`: chạy JQL của scope, kết quả CHÍNH LÀ lá (cây phẳng, không có tầng vật
    lý ở giữa).

  Tầng issue vật lý ở giữa (nếu có) chỉ là **một nguồn** khoá tầng
  (`PARENT_TASK_TITLE`), không bắt buộc — cây phẳng dùng `SELF_TITLE` cho mọi tầng.
- `persist-issues.buildRecords`: thay việc gán một `phaseCode` bằng
  `resolveGroupKeys(leaf, ancestors, config)` → ghi `group_path`; `phase_code` =
  phần tử tầng Phase. `resolveGroupKeys` điều phối các `source` (title cha / title
  lá / token / label), nên cùng một hàm phục vụ cả case 2 tầng lẫn 3 tầng.
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

| Vòng | Nội dung | Trạng thái |
|---|---|---|
| **0** | Tài liệu này + chốt câu hỏi mở | ✅ Xong |
| **1** | Schema tầng + migration + shared types (`group_tier*`, `group_path`). Engine vẫn đọc phase_*, hành vi KHÔNG đổi | ✅ Xong |
| **2** | Engine tổng quát N tầng (`computeGroupRollups`/`buildTierSnapshotForDay`) + `GroupKeyResolver` ghi `group_path`. Test n=1/n=3 | ✅ Xong |
| **3** | Config API mở tiers (3.1) + màn "Cấu trúc tầng" (3.2) + nguồn TOKEN/LABEL (3.3) + ingest CONTAINER/QUERY (3.4) + đăng ký scope QUERY (3.5) | ✅ Xong |
| **4** | Persist N tầng `group_rollup`/`per_tier` (4.1) + Burndown drill-down API + UI (4.2) | ✅ Xong |
| **5** | Ca "Giai đoạn" (một Epic chia 2+ GĐ, GĐ nằm trong title Task `[{epic}][{team}]TênPhase`): tầng GROUP nguồn `PARENT_TASK_TITLE` parse title cha bằng mẫu/luật RIÊNG của tầng (tầng ✦PHASE vẫn lấy `parentPhase` — byte-identical); Burndown drill tự bỏ qua cấp chỉ có một nút (Epic 1 GĐ nhìn như cũ); Signboard lọc theo nhóm tầng-1 (`?stage=`, chỉ hiện khi ≥2 nhóm); ô chọn CONTAINS/REGEX cho luật tầng; Xem thử `tiers-preview` (dán title Task → group_path) | ✅ Xong |

Mỗi vòng: `pnpm typecheck && pnpm lint && pnpm test` xanh; 20 golden dataset byte-identical
suốt các vòng làm bằng chứng "không đổi hành vi".

> **Công thức cấu hình ca "Giai đoạn" (Vòng 5):** một bộ GLOBAL dùng cho MỌI Epic — tầng 1
> `GIAI_DOAN` (GROUP, nguồn title Task cha) với luật ánh xạ `offshore_P1 → GD1`,
> `offshore_P2 → GD2` + luật **catch-all** (`[` CONTAINS, hoặc REGEX `.`, ưu tiên 90) → `GD1`;
> tầng 2 ✦PHASE giữ nguyên. Epic không có team ánh xạ rơi hết về `GD1` ⇒ một nhóm duy nhất
> ⇒ Burndown/Signboard **tự ẩn** cấp GĐ — không Epic nào phải đổi tên ticket hay khai thêm gì.

> **Còn để sau (không chặn):** đường Kế hoạch drill-down cho tầng ≠ Phase khi cần
> (câu hỏi mở #6); `CUSTOM_FIELD` làm nguồn khoá (v2); tổng quát hoá ingest CONTAINER cho
> cây sâu > 3 tầng vật lý (hiện QUERY đã phủ project phẳng, CONTAINER phủ Epic→Task→Sub-task).

---

## 10. Câu hỏi mở

1. **Số tầng tối thiểu.** `role=PHASE` là bắt buộc ⇒ tối thiểu **1 tầng nhóm**
   (Phase luôn có). Có project nào muốn **0 tầng** (Epic → lá phẳng, không Phase)
   không? Nếu có thì Phase phải thành tuỳ chọn — mở rộng #3.
2. **Lồng nhau vs facet độc lập.** Xác nhận mô hình **lồng nhau có thứ tự** (§2.2),
   không phải các chiều nhóm rời rạc.
3. **Xác định "lá".** Cách nào chốt đâu là lá mang số liệu: (a) khai **loại issue lá**
   trong config (VD "Sub-task", hoặc "Task" ở case 2 tầng), hay (b) suy ra "**issue
   không có con**", hay (c) "**issue có estimate/worklog**"? Đề xuất (a) làm chính,
   (b) làm lưới an toàn.
4. **`source` cho v1.** Đề xuất: `PARENT_TASK_TITLE` + `SELF_TITLE` +
   `SUBTASK_TITLE_TOKEN` + `LABEL`. `CUSTOM_FIELD` để v2. Đồng ý?
   (`SELF_TITLE` là thứ case 2 tầng của bạn cần.)
5. **Signboard.** Xác nhận Signboard **vẫn là tính năng tầng Phase**, không tổng
   quát hoá cho mọi tầng (khớp #3).
6. **Đường Kế hoạch drill-down.** Cần đường Kế hoạch cho tầng ≠ Phase khi drill-down
   không, hay chỉ Epic + Phase như hôm nay? (ảnh hưởng có làm `group_rollup` hay không)
7. **Xác nhận cách hiểu ở §0** (full re-architecture; cố định VAI TRÒ gốc/lá/Phase,
   nhưng loại issue gốc + độ sâu + selector CONTAINER/QUERY thì linh động).
8. ✅ **CHỐT: (B)** — mỗi tracked scope = một burndown; "Project" là tầng drill-down.
   Không cần auto-split; key snapshot theo scope id. Muốn tách theo Project → đăng
   ký nhiều scope JQL.

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
- **R-E. Ingest linh động độ sâu + gốc bất kỳ loại (case 2 tầng).** Đây là phần
  mới thêm sau khi rà case Task→Sub-task. `fetch-epic-tree.ts` (đang cứng 3 tầng) và
  sổ đăng ký `tracked_epic` (đang cứng Epic) phải tổng quát hoá. Rủi ro chính: query
  Jira đọc **thiếu lá** một cách im lặng nếu suy sai đâu là lá (E-nhóm liveKeys/xoá
  mềm). → có test riêng cho cây 2 tầng, và đối chiếu số lá đọc được với `/search`.
- **R-F. `QUERY` selector cho project phẳng (case §2.5).** Đọc lá bằng JQL thay vì
  `parent = key` là đường ingest MỚI hẳn: phân trang JQL, xoá mềm khi ticket rời
  khỏi tập kết quả, và (nếu chọn phương án 8-A) tách một scope thành nhiều burndown
  theo tầng trên cùng. Đây là phần nặng nhất của việc tổng quát hoá — cân nhắc tách
  thành vòng riêng, không nhồi chung Vòng 2.
