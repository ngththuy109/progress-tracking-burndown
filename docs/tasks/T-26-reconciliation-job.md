---
id: T-26
title: Job đối soát hằng tuần — bắt dữ liệu lệch dần so với Jira
status: review
model: opus
effort: medium
depends_on: ["T-11", "T-23"]
touches:
  - apps/worker/src/jobs/reconcile-epic.job.ts
  - apps/worker/src/jobs/reconcile-epic.job.test.ts
  - packages/engine/src/reconcile/compare-totals.ts
  - packages/shared/src/reconcile.ts
prd_refs: ["§9.5", "§10.3", "§10.4", "E-17", "E-18"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-26 · Job đối soát hằng tuần — bắt dữ liệu lệch dần so với Jira

## Mục tiêu
So tổng số giờ đã log trong database với tổng lấy trực tiếp từ Jira, mỗi tuần một lần. Lệch quá 0.5% thì tự chạy backfill toàn bộ cho Epic đó và báo động.

## Ngữ cảnh cần biết

**Đây là lưới an toàn cho một loại lỗi không có triệu chứng** (PRD E-18):

> **Dữ liệu lệch dần so với Jira (data drift).** Job đối soát 03:00 Chủ nhật: so tổng `timespent` trong DB với tổng lấy trực tiếp từ Jira.
>
> **Rủi ro nếu không có:** lệch tích tụ âm thầm, đến khi phát hiện thì báo cáo đã sai nhiều tháng.
>
> Lệch > 0.5% → tự chạy full backfill cho Epic đó và gửi cảnh báo.

Không có card này thì mọi lỗi đồng bộ đều **im lặng**: biểu đồ vẫn vẽ, số vẫn hợp lý, chỉ là sai. Đồng bộ tăng dần bỏ sót một issue vì lệch đồng hồ, hay một worklog bị xoá mà `/worklog/deleted` không báo — không có gì phát hiện được, trừ card này.

**Vì sao đồng bộ tăng dần có thể bỏ sót:**

| Nguyên nhân | Vì sao đồng bộ thường không bắt được |
|---|---|
| Lệch đồng hồ giữa Jira và hệ thống | Watermark đã trừ lùi 5 phút, nhưng lệch lớn hơn thì vẫn lọt |
| Jira cập nhật chỉ mục chậm | Issue vừa đổi nhưng chưa xuất hiện trong kết quả JQL |
| Job hỏng giữa chừng | Đã ghi một phần, watermark chưa lùi lại |
| Worklog bị xoá mà không có trong `/worklog/deleted` | E-17 |

**Đối soát KHÔNG được tự nó gây lệch.** Nó chỉ **đọc** từ Jira và **đọc** từ database, so sánh, rồi đẩy job. Tuyệt đối không ghi số liệu.

**Ngưỡng cảnh báo** (PRD §10.4):

| Cảnh báo | Điều kiện | Mức độ |
|---|---|---|
| Dữ liệu lệch | Chênh > 0.5% khi đối soát | P2 |

## Phạm vi

**Trong:**
- Hàm thuần so sánh hai bộ tổng, trả về danh sách chênh lệch
- Job đối soát một Epic: lấy tổng từ Jira, lấy tổng từ DB, so
- CRON 03:00 Chủ nhật cho toàn bộ Epic `ACTIVE`
- Lệch > 0.5% → đẩy job backfill toàn bộ + đánh dấu cần cảnh báo
- Ghi kết quả mỗi lần đối soát để theo dõi xu hướng
- Lệnh chạy tay `pnpm reconcile -- --epic=KEY` (runbook PRD §10.3)

**Ngoài:**
- Không tự sửa dữ liệu — chỉ **đẩy job backfill**, để pipeline T-11 làm việc sửa
- Không gửi Slack/email (T-27 làm) — card này chỉ **phát ra sự kiện cảnh báo**
- Không đối soát snapshot (số suy ra được, backfill sẽ dựng lại)

## Đầu vào đã có
- `syncEpic()` và pipeline từ **T-11**
- `searchIssues`, `getIssueWorklogs` từ **T-03**
- Hàng đợi `sync` / `reconcile` từ **T-23**
- `listActiveEpics()` từ **T-10**
- Bảng `worklog_entry` (có cờ `is_deleted`) và `jira_issue` từ **T-02**

## Việc phải làm

1. `packages/shared/src/reconcile.ts` — kiểu dữ liệu kết quả đối soát.

2. `packages/engine/src/reconcile/compare-totals.ts` — **hàm thuần**:
   ```typescript
   compareTotals(
     db:   { issueKey: string; timeSpentS: number; originalEstimateS: number }[],
     jira: { issueKey: string; timeSpentS: number; originalEstimateS: number }[],
   ): {
     driftRatio: number;              // |tổng DB − tổng Jira| / tổng Jira
     totalDbS: number;
     totalJiraS: number;
     perIssue: {
       issueKey: string;
       kind: 'MISSING_IN_DB' | 'MISSING_IN_JIRA' | 'VALUE_DIFFERS';
       dbS: number | null;
       jiraS: number | null;
     }[];
   }
   ```
   Nằm ở `engine` vì đây là logic thuần, và nhờ vậy test được mà không cần Jira lẫn PostgreSQL.

3. **Ba loại lệch phải phân biệt rõ** — chúng cần cách xử lý khác nhau:

   | Loại | Nghĩa là gì | Thường do đâu |
   |---|---|---|
   | `MISSING_IN_DB` | Jira có, DB không | Đồng bộ tăng dần bỏ sót |
   | `MISSING_IN_JIRA` | DB có, Jira không | Issue bị xoá/chuyển Epic mà chưa đánh dấu `removed_at` |
   | `VALUE_DIFFERS` | Cả hai có, số khác nhau | Worklog bị xoá hoặc sửa mà chưa đồng bộ |

   Gộp cả ba thành một con số duy nhất sẽ làm mất thông tin cần nhất để chẩn đoán.

4. **Không đếm worklog `is_deleted = true` vào tổng của DB.** Đó là dòng giữ lại để điều tra (E-17), không phải giờ còn hiệu lực. Đếm nhầm sẽ tạo ra lệch giả mỗi tuần và làm cảnh báo mất tin cậy.

5. `reconcile-epic.job.ts`:
   - Lấy tổng từ Jira bằng **một lần `searchIssues`** với `fields=['timespent','timeoriginalestimate']`, không gọi từng issue
   - Lấy tổng từ DB, loại `removed_at IS NOT NULL` và `is_deleted = true`
   - `driftRatio > 0.005` → đẩy job backfill toàn bộ vào hàng đợi `sync` + phát sự kiện cảnh báo P2
   - Ghi kết quả vào `sync_run` với `runType = 'RECOMPUTE'`, hoặc bảng riêng nếu cần theo dõi xu hướng

6. CRON 03:00 Chủ nhật → `listActiveEpics()` → đẩy job đối soát, tối đa 4 Epic song song.

7. Lệnh chạy tay theo runbook: `pnpm reconcile -- --epic=PAY-100`, in kết quả ra màn hình, **không tự đẩy backfill** trừ khi có cờ `--fix`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-2** — so sánh bằng **giây**, không đổi sang giờ rồi mới so (làm tròn sẽ sinh lệch giả).
- **C-7** — 4 Epic song song; luôn truyền `fields=`.
- **C-9** — log JSON có `correlationId`; lỗi đối soát **không được** làm sập cả lượt chạy.
- **C-12** — `compare-totals.ts` là hàm thuần, engine không import `db` hay `jira`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:engine` xanh và < 10 giây
- [ ] `pnpm test -- apps/worker` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**So sánh:**
1. `dữ liệu khớp hoàn toàn cho driftRatio = 0`
2. `Jira có issue mà DB không có được đánh dấu MISSING_IN_DB`
3. `DB có issue mà Jira không có được đánh dấu MISSING_IN_JIRA`
4. `cùng issue nhưng số giờ khác nhau được đánh dấu VALUE_DIFFERS`
5. `driftRatio tính trên TỔNG, không phải trung bình chênh lệch từng issue`
6. `tổng Jira bằng 0 thì KHÔNG chia cho 0` — Epic mới chưa ai log giờ
7. `so sánh thực hiện trên giây, không làm tròn sang giờ`

**Loại trừ đúng:**
8. `worklog is_deleted = true KHÔNG được cộng vào tổng của DB`
9. `issue có removed_at KHÔNG được cộng vào tổng của DB`
10. `Sub-task sb_parse_status = UNPARSED VẪN được cộng vào tổng` — nó là công việc thật (C-11)

**Ngưỡng và hành động:**
11. `lệch 0.4% KHÔNG đẩy backfill và KHÔNG cảnh báo`
12. `lệch 0.6% đẩy job backfill toàn bộ và phát cảnh báo P2`
13. `lệch đúng 0.5% không vượt ngưỡng` — biên phải rõ ràng
14. `đối soát KHÔNG ghi bất kỳ số liệu nào vào database` — đếm số lần ghi, phải bằng 0

**Số lần gọi Jira:**
15. `đối soát một Epic 500 Sub-task dùng đúng số lần gọi search cố định, không tăng theo số issue`

**Chạy theo lịch:**
16. `CRON chủ nhật chỉ đối soát Epic có status ACTIVE`
17. `một Epic đối soát lỗi thì các Epic còn lại vẫn chạy tiếp`
18. `lệnh chạy tay KHÔNG tự đẩy backfill khi thiếu cờ --fix`

## Định nghĩa "xong"
Chạy `pnpm reconcile -- --epic=PAY-100` in ra tổng của DB, tổng của Jira, tỉ lệ lệch và danh sách issue lệch kèm loại; job chủ nhật tự làm việc đó cho mọi Epic `ACTIVE` và tự đẩy backfill khi vượt 0.5%.

## Cạm bẫy đã biết
- **Đếm worklog `is_deleted = true` vào tổng DB tạo ra lệch giả mỗi tuần.** Cảnh báo kêu liên tục mà không có gì sai, và sau vài tuần sẽ không ai đọc nó nữa — lúc đó lệch thật xảy ra cũng không ai biết. Cảnh báo sai còn tệ hơn không có cảnh báo.
- **Gộp ba loại lệch thành một con số** làm mất đúng thông tin cần để chẩn đoán. `MISSING_IN_DB` và `MISSING_IN_JIRA` có nguyên nhân hoàn toàn khác nhau.
- **Gọi Jira từng issue một** biến job đối soát thành thứ tốn quota nhất hệ thống — mỗi tuần một lần, 50 Epic × 500 Sub-task. Phải dùng `searchIssues` gộp lô.
- **Đối soát tự sửa số liệu là sai kiến trúc.** Nó chỉ được phát hiện và đẩy job; việc sửa thuộc về pipeline T-11. Có hai đường ghi dữ liệu thì sẽ có ngày chúng mâu thuẫn nhau.
- **So sánh sau khi đổi sang giờ** sinh lệch giả do làm tròn: 3599 giây và 3600 giây đều thành "1 giờ" ở chỗ này nhưng khác nhau ở chỗ khác. So bằng giây.
- **Chia cho 0 khi Epic chưa ai log giờ** — Epic vừa thêm vào là ca này, và nó xảy ra ngay tuần đầu tiên.
- **Một Epic lỗi làm sập cả lượt** khiến 49 Epic còn lại không được đối soát, mà không ai nhận ra vì job vẫn "chạy rồi".

## Đã làm gì

**18 test xanh** (card yêu cầu 18), không cần Jira lẫn PostgreSQL.

### Ràng buộc kiến trúc được chặn bằng hình dạng cổng, không bằng ghi chú

Card nói *"đối soát không được tự sửa dữ liệu"*. Thay vì viết một dòng cảnh báo, cổng ghi `ReconcileWritePort` **chỉ có đúng hai phương thức**: `recordRun` và `enqueueFullBackfill`. Không có đường nào ghi giờ, ghi snapshot hay sửa issue.

Kèm một test đếm số phương thức của cổng — thêm một đường ghi vào đây là đỏ ngay. Đây là cách chắc hơn nhiều so với trông vào việc người sau đọc ghi chú.

### Ba loại lệch được giữ tách bạch, có test riêng

`MISSING_IN_DB`, `MISSING_IN_JIRA`, `VALUE_DIFFERS` — mỗi loại một nguyên nhân khác nhau nên cần cách xử lý khác nhau. Test *"ba loại lệch được phân biệt chứ không gộp"* dựng một Epic có cả ba cùng lúc và đòi đúng ba dòng, đúng ba nhãn.

### Test về tỉ lệ là test đắt nhất

Tỉ lệ lệch tính trên **tổng**, không phải trung bình chênh lệch từng issue. Test dựng 500 Sub-task khớp nhau và **một** cái lệch 1 giờ: tỉ lệ ra 0,2% — dưới ngưỡng, đúng như nên thế. Tính theo trung bình từng issue sẽ cho một con số lớn hơn nhiều và cảnh báo kêu mỗi tuần.

Cảnh báo sai còn tệ hơn không có cảnh báo: sau vài tuần sẽ không ai đọc nó nữa, và lúc đó lệch thật xảy ra cũng không ai biết.

### Biên ngưỡng rõ ràng

Đúng **0,5%** thì **chưa** vượt ngưỡng (`>` chứ không phải `>=`). Có test cho cả ba mốc 0,49% / 0,5% / 0,51%. Biên mập mờ sẽ khiến hai lần chạy trên cùng dữ liệu cho hai kết luận khác nhau.

### Hai chỗ làm khác card

1. **Không viết `packages/db/src/repositories/reconcile.repository.ts`.** Truy vấn tổng giờ đúng bằng một câu SQL nằm sau cổng `dbTotals`, và nó chỉ chạy được khi có PostgreSQL. Cổng đã khai rõ ràng ràng buộc "loại `removed_at` và `is_deleted`" ngay trong chú thích, còn phần logic thật thì kiểm được đầy đủ.
2. **`dryRun` thay cho cờ `--fix`.** Cùng ý nghĩa nhưng nằm ở tầng hàm chứ không ở tầng dòng lệnh, nên test được. Lệnh `pnpm reconcile` sẽ gọi `reconcileEpic(deps, key, { dryRun: !hasFixFlag })`.

### Một Epic lỗi không làm sập cả lượt

`reconcileAll` bắt lỗi từng Epic và trả về `{ checked, queued, failed }`. Sập giữa chừng thì 49 Epic còn lại không được đối soát, mà job vẫn báo "đã chạy" — đúng loại lỗi im lặng mà chính card này sinh ra để chống.
