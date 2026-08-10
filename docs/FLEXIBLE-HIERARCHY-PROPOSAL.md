# Đề xuất: Burndown & Signboard linh hoạt theo cấu trúc dự án — chỉ cần config, không sửa code

> **Trạng thái: ĐỀ XUẤT — chưa triển khai.** Tài liệu này phân tích hiện trạng và đề xuất
> thiết kế; mọi tên bảng/cột mới chỉ là dự kiến.

Bối cảnh: hệ thống hiện giả định cây **3 tầng** `Epic → Task (Phase) → Sub-task`. Nhiều dự
án quản lý khác đi — ví dụ chỉ **2 tầng**: một ticket Task đóng vai "project", các Sub-task
bên dưới là task của từng phase. Mục tiêu của đề xuất: một dự án có cấu trúc khác chỉ cần
**khai báo cấu hình** là dùng được Burndown + Signboard, không sửa code, không deploy.

---

## 1. Hiện trạng: giả định "3 tầng" nằm ở đâu trong code

Điểm mấu chốt sau khi rà soát: **phần lõi tính toán vốn đã không biết cây có mấy tầng.**

- `packages/engine/src/snapshot/build-snapshot-for-day.ts` nhận vào một danh sách
  `SubtaskRecord[]` (ticket **lá** — nơi có estimate/worklog) và cộng dồn theo `phaseCode`.
  Nó không hề hỏi "cha của ticket này là gì".
- `packages/engine/src/signboard/*` quyết định trạng thái từng ô từ ngày plan/actual của
  chính ticket lá — cũng không quan tâm tầng.
- `packages/engine/src/rollup/*` gộp MIN/MAX ngày theo `phaseCode` — cũng vậy.

Giả định 3 tầng chỉ nằm ở **tầng đồng bộ + phân loại + truy vấn**, gồm 4 chỗ:

| # | Chỗ | Giả định cứng |
|---|---|---|
| 1 | `apps/worker/src/pipeline/fetch-epic-tree.ts` | Đúng 2 bước JQL: `key = epic OR parent = epic` rồi `parent IN (tasks)` — độ sâu 3 viết chết trong luồng fetch |
| 2 | `apps/worker/src/pipeline/persist-issues.ts` | Gán `issueType` EPIC/TASK/SUBTASK theo vị trí trong cây; tiêu đề **Task** → Phase (TaskTitleParser); tiêu đề **Sub-task** → project/team/function/task (SubtaskTitleParser); Phase của Task cha luôn thắng `[phase]` trong tiêu đề Sub-task (PRD §2.9.2) |
| 3 | Các repository (`packages/db/src/repositories/*`) | Lọc `issueType = 'SUBTASK'` để lấy ticket lá, `= 'TASK'` để đếm Phase |
| 4 | `tracked_epic` | Đơn vị theo dõi (root) mặc định là một **Epic** |

Ngoài ra hai thứ **đã** cấu hình được từ trước và nên giữ nguyên làm nền:

- Bộ `PhaseConfigSet` (bảng 7A–7F): mẫu tiêu đề, luật từ khoá → Phase, cột Signboard —
  đã có version, preview → confirm, scope GLOBAL/PROJECT.
- `wbs_start_date`/`wbs_end_date` đã dò field-id động theo từng Jira (T-05), không viết cứng.

**Hệ quả:** không cần "viết lại engine cho từng dạng dự án". Chỉ cần một lớp cấu hình mô tả
*cây thật của dự án ánh xạ vào các vai trừu tượng thế nào*, và làm 4 chỗ trên đọc cấu hình
đó thay vì hằng số.

---

## 2. Mô hình đề xuất: 3 VAI trừu tượng thay cho 3 TẦNG cố định

Mọi dạng cây quy về ba vai (role):

| Vai | Nghĩa | Ở hệ thống hiện tại |
|---|---|---|
| `ROOT` | Đơn vị theo dõi — 1 dòng `tracked_epic`, 1 biểu đồ burndown, 1 signboard | Epic |
| `GROUP` | Tầng trung gian mang thông tin nhóm (Phase) — **0..n tầng** | Task (Phase) |
| `LEAF` | Đơn vị công việc: có estimate, worklog, ngày WBS — nguồn của mọi con số | Sub-task |

Cấu trúc nào cũng biểu diễn được:

- **3 tầng (hiện tại):** ROOT=Epic, GROUP=Task, LEAF=Sub-task. Phase lấy từ tiêu đề GROUP.
- **2 tầng (ticket Task là project):** ROOT=Task, LEAF=Sub-task, **không có GROUP**.
  Phase lấy từ chính LEAF — từ ô `[phase]` trong tiêu đề (đã bóc sẵn vào `sb_phase_raw`
  nhưng hiện chỉ để đối chiếu) hoặc từ một field Jira.
- **2 tầng kiểu khác (Epic → Task, không Sub-task):** ROOT=Epic, LEAF=Task.
- **4 tầng (Initiative → Epic → Task → Sub-task):** ROOT=Initiative, GROUP=2 tầng giữa,
  LEAF=Sub-task; Phase lấy từ tầng GROUP nào thì khai trong config.
- **1 tầng phẳng:** ROOT là một filter/board, LEAF là mọi issue khớp; Phase = FIXED
  (cả dự án là một phase) hoặc theo field.

### 2.1 Hierarchy Profile — cấu hình mô tả cây

Thêm khái niệm **Hierarchy Profile**, sống **trong `PhaseConfigSet`** (bảng 7G mới) để thừa
hưởng trọn: version, scope GLOBAL/PROJECT, luồng preview → confirm, quay lui.

```jsonc
// Profile "mặc định 3 tầng" — tương đương hành vi hiện tại (seed sẵn)
{
  "levels": [
    { "role": "ROOT" },                       // issue gốc được đăng ký theo dõi
    { "role": "GROUP", "phaseCarrier": true },// con trực tiếp của ROOT
    { "role": "LEAF" }                        // con của GROUP
  ],
  "phaseSource": { "type": "GROUP_TITLE" },   // Phase bóc từ tiêu đề tầng GROUP
  "signboard": {
    "row":    { "source": "TITLE_SLOT", "slot": "function" },
    "column": { "source": "TITLE_SLOT", "slot": "task" }
  }
}
```

```jsonc
// Profile "2 tầng — ticket Task là project"
{
  "levels": [
    { "role": "ROOT" },
    { "role": "LEAF" }
  ],
  "phaseSource": { "type": "SELF_TITLE_SLOT", "slot": "phase" },
  // hoặc: { "type": "FIELD", "field": "components" } / { "type": "FIXED", "phaseCode": "MAIN" }
  "signboard": {
    "row":    { "source": "TITLE_SLOT", "slot": "function" },
    "column": { "source": "TITLE_SLOT", "slot": "task" }
  }
}
```

Bốn nguồn Phase (`phaseSource.type`) — đây là chỗ linh hoạt quan trọng nhất:

| Type | Nghĩa | Dùng khi |
|---|---|---|
| `GROUP_TITLE` | Bóc từ tiêu đề tầng GROUP qua `PhaseTitlePattern` + `PhaseMatchRule` (hành vi hiện tại) | 3+ tầng |
| `SELF_TITLE_SLOT` | Bóc từ chính tiêu đề LEAF — ô `{phase}` của `SubtaskTitlePattern`, rồi vẫn đi qua `PhaseMatchRule` để chuẩn hoá về `phase_code` | 2 tầng, tiêu đề có `[phase]` |
| `FIELD` | Đọc từ một field Jira của LEAF (component / label / custom field — dò field-id qua cơ chế T-05 sẵn có), rồi qua `PhaseMatchRule` | Dự án không đặt tên theo mẫu |
| `FIXED` | Cả ROOT là một phase duy nhất | Dự án nhỏ, không chia phase |

Điểm đáng giá: cả bốn đường đều **đổ về cùng một chỗ** — `jira_issue.phase_code` — nên từ
đó trở đi (rollup, snapshot, signboard, API, UI) **không đổi một dòng nào**.

Tương tự, `signboard.row/column` cho phép hàng/cột lấy từ ô tiêu đề (hiện tại) **hoặc** từ
field Jira (`{ "source": "FIELD", "field": "components" }`) — dự án không có quy ước đặt
tên vẫn dựng được Signboard. Giá trị bóc ra vẫn đổ về `function_key` / `task_type` như cũ,
và cột vẫn khớp chính xác qua `SignboardColumn`.

### 2.2 Vì sao chọn "vai theo vị trí trong cây" chứ không theo tên issue type

Tên issue type khác nhau ở mỗi Jira ("Sub-task", "サブタスク", type tuỳ chế). Định nghĩa vai
theo **quan hệ** (tầng thứ i = con của tầng i−1, tính từ ROOT) thì không phụ thuộc tên,
đúng với mọi Jira, và khớp luôn cách `fetch-epic-tree` đang phân tầng (theo `parent`, không
theo `issuetype`). Config vẫn cho phép khai `match.issueTypes` tuỳ chọn ở mỗi tầng để loại
nhiễu (ví dụ tầng con của ROOT có lẫn Bug không muốn tính).

---

## 3. Thay đổi cụ thể ở từng lớp

### 3.1 Schema (migration mới — C-13, không sửa migration cũ)

1. **Bảng 7G `hierarchy_profile`** — 1-1 với `phase_config_set` (cascade như 7B–7F):
   cột có kiểu rõ (`phase_source_type`, `phase_source_ref`, `signboard_row_source`, …) +
   một cột JSON `levels`. Không nhét cả profile vào JSON tự do: cột có kiểu để DB và
   validator chặn sai sớm, JSON chỉ cho phần lặp theo tầng.
2. **`jira_issue.resolved_role`** (`ROOT | GROUP | LEAF`) — ghi lúc đồng bộ theo profile
   đang hiệu lực. Đây là bước **mở khoá chính**: mọi chỗ đang lọc
   `issueType = 'SUBTASK'` đổi một lần thành `resolved_role = 'LEAF'`, từ đó thêm dạng cây
   mới không đụng code nữa. Giữ nguyên `issue_type` (EPIC/TASK/SUBTASK) làm dữ liệu mô tả.
3. **`tracked_epic`** thêm `root_issue_type` (mô tả, ví dụ "Task") — bảng và tên cột
   `epic_key` giữ nguyên để không phải đổi cả hệ; hiểu là "root key". Đổi tên bảng là việc
   thẩm mỹ, tách riêng, không nằm trong đề xuất này.

### 3.2 Đồng bộ (`apps/worker`)

`fetchEpicTree` tổng quát hoá từ "đúng 2 bước" thành **vòng lặp theo số tầng của profile**:

```
keys[0] = { rootKey }                                  // JQL: key = root
keys[i] = con của keys[i-1]                            // JQL: parent IN (keys[i-1])
```

- Bộ lọc `updated >=` (tăng dần) **chỉ áp cho tầng LEAF** — đúng nguyên lý sẵn có: tầng
  trên là câu hỏi cấu trúc, tầng lá mới là khối lượng. Quét `liveKeys` riêng cho tầng lá
  giữ nguyên.
- 2 tầng ⇒ vòng lặp chạy 2 lượt, **ít call hơn hiện tại**; 4 tầng ⇒ 4 lượt. Trần độ sâu
  khai trong config, validator chặn (đề xuất ≤ 5).

`persist-issues.ts`: thay nhánh cứng EPIC/TASK/SUBTASK bằng gán `resolved_role` theo tầng,
và chọn chiến lược Phase theo `phaseSource` (bảng ở §2.1). Cả bốn chiến lược là hàm thuần,
test được ngay — đúng tinh thần file này đang giữ.

### 3.3 Repository + engine

Đổi bộ lọc `issueType` → `resolved_role` (thay đổi cơ học, hành vi giữ nguyên với profile
mặc định). Engine core **không đổi**: `SubtaskRecord` đọc là "bản ghi ticket lá"; có thể
đổi tên dần thành `LeafRecord` khi thuận tay, không bắt buộc.

### 3.4 UI quản trị

Thêm mục **"Cấu trúc dự án"** vào màn Phase settings sẵn có: chọn số tầng, nguồn Phase,
nguồn hàng/cột Signboard. Bắt buộc đi qua **Preview → Confirm** như sửa mẫu tiêu đề — đổi
profile là tái phân loại ticket thật, phải thấy trước ticket nào đổi vai/đổi phase rồi mới
lưu. Preview tái dùng đúng cơ chế preview của Phase settings hiện có.

---

## 4. Cái gì CỐ TÌNH không cho config (hàng rào)

Config chọn **dữ liệu đến từ đâu**, không chọn **toán chạy thế nào**. Giữ cứng:

- Ba luật tính remaining (Done = 0 → tay sửa thắng → hiệu số) — PRD, README.
- Nguyên tắc no-baseline + ⚑ plan-shift; lịch làm việc/ngày nghỉ; C-11 "cộng dồn không
  lọc bỏ gì".
- Ngữ nghĩa snapshot (chốt cuối ngày địa phương, chống ghi đè E-19, idempotent C-6).

Mở các thứ này ra config sẽ tạo ra n hệ thống khác nhau đội lốt một — chi phí vận hành và
niềm tin vào con số không gánh nổi.

---

## 5. Trình tự triển khai (mỗi bước chạy được, rollback được)

| Bước | Việc | Rủi ro |
|---|---|---|
| 1 | Migration: `hierarchy_profile` + `resolved_role`; seed profile mặc định 3 tầng; backfill `resolved_role` từ `issue_type` | Thấp — chưa đổi hành vi |
| 2 | Repos + engine callers lọc theo `resolved_role`; toàn bộ test hiện có phải xanh nguyên trạng | Thấp — cơ học |
| 3 | `fetchEpicTree` thành vòng lặp theo profile; `persist-issues` gán vai theo tầng | Vừa — có test fakes JQL sẵn |
| 4 | 4 chiến lược `phaseSource` (GROUP_TITLE là hành vi cũ, tách ra trước, 3 cái mới thêm sau) | Vừa |
| 5 | Nguồn hàng/cột Signboard theo config (TITLE_SLOT giữ nguyên, thêm FIELD) | Vừa |
| 6 | UI "Cấu trúc dự án" + preview; tài liệu ONBOARDING cập nhật | Vừa |

Tương thích ngược: **không có profile ⇒ dùng profile mặc định 3 tầng** — mọi Epic đang
theo dõi không đổi một con số nào. Dự án 2 tầng đầu tiên chỉ là: tạo config PROJECT, khai
profile 2 tầng, đăng ký ticket Task làm root, preview, confirm.

---

## 6. Ca biên cần chốt khi làm chi tiết

1. **GROUP cũng có estimate/worklog** (dự án log giờ lên cả Task): mặc định bỏ qua như hiện
   tại; cân nhắc cờ `countGroupWork` sau nếu có nhu cầu thật — đừng làm trước.
2. **LEAF lại có con** (ai đó tạo Sub-task dưới lá 2 tầng): tầng dưới LEAF không fetch —
   khối lượng nằm ở đâu là quyết định của profile, không suy diễn.
3. **Phase từ FIELD nhiều giá trị** (2 component): lấy theo `matchPriority` của
   `PhaseMatchRule`, không khớp ⇒ `UNCLASSIFIED` + đếm cảnh báo — đúng nếp E-27/C-11.
4. **Đổi profile giữa chừng**: như đổi mẫu tiêu đề hôm nay — cần RECOMPUTE để snapshot cũ
   phân bổ lại theo phase mới; preview phải nói rõ điều này.
5. **Ticket root 2 tầng trùng key với Task trong Epic 3 tầng khác cùng Jira**: `epic_key`
   (root key) đã là cột phân vùng mọi bảng, không đụng nhau.
