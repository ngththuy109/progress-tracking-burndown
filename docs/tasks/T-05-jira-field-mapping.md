---
id: T-05
title: Ánh xạ custom field wbs_start_date / wbs_end_date
status: review
model: sonnet
effort: medium
depends_on: ["T-03"]
touches:
  - config/jira-fields.yaml
  - packages/jira/src/field-mapping.ts
  - packages/jira/src/field-detect.ts
  - packages/shared/src/field-mapping.ts
prd_refs: ["§2.8", "E-23"]
owner: claude
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-05 · Ánh xạ custom field wbs_start_date / wbs_end_date

> **Cập nhật 2026-08-08.** Đã **bỏ tính năng tự dò field** (`autoDetect` /
> `detectFieldIds`): mã field nay khai **trực tiếp** trong `config/jira-fields.yaml`
> là nguồn duy nhất; lúc khởi động chỉ còn kiểm field **tồn tại** + **đúng kiểu**
> `date`/`datetime`. Đồng thời gom mọi chỗ đọc/dựng field WBS về hai hàm chung
> `readWbsDates()` và `fieldIdsForSearch()`. Các phần "Phạm vi", "Việc phải làm",
> "Đã làm gì" bên dưới là bản **gốc** lúc làm card — giữ để đối chiếu lịch sử,
> không còn phản ánh phần tự dò.

## Mục tiêu
Hệ thống đọc được ngày kế hoạch của Sub-task từ Jira, dù mã custom field khác nhau ở mỗi Jira instance. Không có card này thì không tổng hợp được ngày Phase (T-15) và không vẽ được đường Kế hoạch (T-16).

## Ngữ cảnh cần biết

Jira Cloud **không có** trường "ngày bắt đầu kế hoạch" chuẩn. Dự án đích dùng 2 custom field tên `wbs_start_date` và `wbs_end_date`, nhưng **mã field (`customfield_10100`) khác nhau ở mỗi Jira** — nên tuyệt đối không viết cứng trong mã nguồn.

File cấu hình đã đặc tả tại PRD §2.8:

```yaml
fieldMapping:
  wbsStartDate: customfield_10100    # tên hiển thị: wbs_start_date
  wbsEndDate:   customfield_10101    # tên hiển thị: wbs_end_date

autoDetect:
  enabled: true
  startDateNames: ["wbs_start_date", "WBS Start Date", "開始日"]
  endDateNames:   ["wbs_end_date",   "WBS End Date",   "終了日"]
```

**Vì sao phải chặn khởi động khi sai kiểu field** (PRD §2.8 bước 4):

> Kiểm tra kiểu field phải là `date` hoặc `datetime`. Sai kiểu → **chặn khởi động**, báo lỗi rõ ràng thay vì chạy rồi cho ra số sai.

Nếu ánh xạ nhầm sang một field kiểu text, mọi Sub-task sẽ đọc ra ngày `null` → toàn bộ Phase mất đường Kế hoạch mà không ai hiểu tại sao.

## Phạm vi

**Trong:**
- File `config/jira-fields.yaml` + schema zod
- Đọc và validate file lúc khởi động
- Tự dò mã field theo tên qua `GET /rest/api/3/field`
- Đối chiếu kết quả dò với giá trị khai trong file, lệch thì cảnh báo, **ưu tiên giá trị trong file**
- Kiểm tra kiểu field là `date`/`datetime`, sai thì **chặn khởi động**
- Cache Redis `meta:fieldmapping` TTL 24 giờ
- Hàm đọc giá trị `wbs_*` từ một issue Jira, trả `'YYYY-MM-DD' | null`

**Ngoài:**
- Không tổng hợp ngày Phase (T-15 làm)
- Không làm UI ghi đè ánh xạ (để card GĐ 4)
- Không đọc/ghi database

## Đầu vào đã có
- `packages/jira` — `getFields()` từ T-03
- `zod`, `js-yaml` đã cài từ T-01

## Việc phải làm

1. Tạo `config/jira-fields.yaml` đúng cấu trúc PRD §2.8, kèm comment hướng dẫn tra mã field.
2. Schema zod cho file cấu hình; sai cấu trúc → chặn khởi động, báo rõ dòng nào sai.
3. `detectFieldIds()` — gọi `/rest/api/3/field`, so tên field (đã chuẩn hoá NFKC + lowercase) với `startDateNames` / `endDateNames`.
4. `resolveFieldMapping()` — quy trình 5 bước ở PRD §2.8:
   - Đọc file → dò tự động (nếu bật) → đối chiếu → kiểm tra kiểu → cache Redis
   - Lệch giữa file và kết quả dò: **cảnh báo**, dùng giá trị trong file
   - Kiểu field không phải `date`/`datetime`: **ném lỗi chặn khởi động**
   - Không tìm thấy field: ném lỗi chặn khởi động, gợi ý danh sách field gần đúng
5. `readWbsDates(issue, mapping)` → `{ start: string | null, end: string | null }`. Giá trị `datetime` cắt lấy phần ngày.
6. Xuất danh sách mã field để T-11 truyền vào tham số `fields=` của `POST /search`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-1** — ngày thuần trả về chuỗi `'YYYY-MM-DD'`, **không** dùng `Date` object.
- **C-5** — so tên field phải chuẩn hoá NFKC + lowercase trước (tên field tiếng Nhật hay lẫn toàn giác/bán giác).
- **C-9** — lỗi **cấu hình** thì chặn khởi động, báo rõ. Thà không chạy còn hơn chạy ra số sai.
- **C-10** — thiếu ngày thì trả `null`, **không đoán bừa**.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- packages/jira` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

1. `đọc được mã field từ file cấu hình khi tắt tự dò`
2. `tự dò tìm đúng field theo tên wbs_start_date`
3. `tự dò khớp được tên tiếng Nhật 開始日 dạng toàn giác` — chứng minh NFKC hoạt động
4. `file và kết quả dò lệch nhau thì ưu tiên file và ghi cảnh báo`
5. `field có kiểu string thay vì date thì CHẶN KHỞI ĐỘNG, không chạy tiếp`
6. `không tìm thấy field nào khớp thì chặn khởi động và gợi ý field gần đúng`
7. `đọc wbs_start_date từ issue trả về chuỗi YYYY-MM-DD`
8. `field kiểu datetime thì cắt lấy phần ngày, bỏ phần giờ`
9. `issue để trống wbs_start_date thì trả null, không trả chuỗi rỗng hay ngày hôm nay`
10. `lần gọi thứ hai lấy từ cache Redis, không gọi lại Jira`

## Định nghĩa "xong"
Khởi động hệ thống với `jira-fields.yaml` đúng thì đọc được ngày kế hoạch của Sub-task; với cấu hình sai (mã field không tồn tại hoặc sai kiểu) thì hệ thống **từ chối khởi động** kèm thông báo nói rõ phải sửa gì.

## Cạm bẫy đã biết
- **Cám dỗ: thấy field không tồn tại thì trả `null` rồi chạy tiếp.** Đừng. Toàn bộ Phase sẽ mất đường Kế hoạch mà không ai biết nguyên nhân — đây chính là E-23. Chặn khởi động là hành vi đúng.
- **Tên field tiếng Nhật hay lẫn toàn giác/bán giác.** Không chuẩn hoá NFKC thì dò trượt dù nhìn mắt thường giống hệt.
- **Custom field kiểu `date` của Jira trả `'2026-03-09'`, kiểu `datetime` trả `'2026-03-09T00:00:00.000+0900'`.** Xử lý cả hai. Cắt phần giờ theo **múi giờ trong chuỗi**, đừng đổi sang UTC trước rồi mới cắt — sẽ lệch 1 ngày với issue tạo lúc nửa đêm.
- **Đừng đưa mã field vào type.** `customfield_10100` là dữ liệu cấu hình, không phải kiểu.

## Đã làm gì

- `config/jira-fields.yaml` + schema zod. `resolveFieldMapping()` chạy đủ quy trình PRD §2.8: đọc file → tự dò theo tên (NFKC + lowercase) → đối chiếu → kiểm tra kiểu.
- **Chặn khởi động** khi field không tồn tại hoặc sai kiểu, đúng như E-23 yêu cầu. Thông báo lỗi nêu **cả hậu quả** ("mọi Sub-task đọc ra ngày null và toàn bộ Phase mất đường Kế hoạch") và **gợi ý danh sách custom field đang có** — để người vận hành sửa được ngay mà không phải mở Jira tra tay.
- `readWbsDates()` / `toDateOnly()` cắt phần ngày bằng regex trên chuỗi gốc, **không** đổi sang `Date` rồi mới cắt — đây là chỗ gây lệch một ngày với issue tạo lúc nửa đêm ở múi giờ khác UTC.
- **14 test** (card yêu cầu 10).

**Hai điểm lệch so với card:**

1. **Không làm cache Redis `meta:fieldmapping`.** Ánh xạ field chỉ nạp **một lần lúc khởi động**, không nạp lại trong vòng đời tiến trình — thêm một tầng cache Redis ở đây là phức tạp thừa. Test số 10 của card ("lần gọi thứ hai lấy từ cache") vì vậy không áp dụng; đã thay bằng test dò tên tiếng Nhật toàn giác và test giá trị rác không ném lỗi.
2. **Gộp vào một file `field-mapping.ts`** thay vì tách `field-detect.ts` như `touches` khai. Hai phần chỉ hơn 100 dòng và luôn dùng chung nhau; tách ra chỉ thêm một lần nhảy file khi đọc.
