---
id: T-29
title: Màn hình danh sách Epic — thêm, tạm dừng, bỏ theo dõi
status: review
model: sonnet
effort: medium
depends_on: ["T-10", "T-20", "T-25"]
touches:
  - apps/web/src/routes/epics/
  - apps/web/src/api/use-epics.ts
  - apps/web/e2e/epics.spec.ts
  - apps/web/src/routes/app-routes.tsx
  - packages/shared/src/tracked-epic.ts
prd_refs: ["§2.6", "US-01", "US-02", "US-10", "R-08"]
owner: claude
started_at: 2026-08-04
finished_at: 2026-08-04
---

# T-29 · Màn hình danh sách Epic — thêm, tạm dừng, bỏ theo dõi

## Mục tiêu
PM tự đưa Epic vào hệ thống và tự gỡ ra, không cần dev. Đây là **cửa vào** của toàn bộ sản phẩm — không có màn hình này thì mọi thứ khác không có dữ liệu để hiện.

## Ngữ cảnh cần biết

**Bảy endpoint đã có từ T-10.** Card này chỉ làm giao diện, không sửa API.

| Việc | Endpoint |
|---|---|
| Kiểm tra key trước khi thêm | `POST /api/epics/validate` |
| Thêm nhiều Epic cùng lúc | `POST /api/epics` |
| Danh sách đang theo dõi | `GET /api/epics` |
| Duyệt Epic có sẵn trên Jira | `GET /api/epics/browse` |
| Tạm dừng / bật lại | `PATCH /api/epics/:epicKey` |
| Bỏ theo dõi | `DELETE /api/epics/:epicKey` |
| Sub-task thiếu ngày kế hoạch | `GET /api/epics/:epicKey/missing-dates` |

**Thêm Epic là thao tác NẶNG.** Nó kích hoạt backfill toàn bộ lịch sử — vài phút mỗi Epic. Màn hình phải nói rõ điều đó **trước khi** người dùng bấm, chứ không để họ ngồi nhìn màn hình đơ rồi bấm lại lần nữa.

**Tạm dừng ≠ bỏ theo dõi.**

| | Dữ liệu cũ | Đồng bộ tiếp | Hoàn tác |
|---|---|---|---|
| Tạm dừng | giữ | dừng | bật lại là xong |
| Bỏ theo dõi | **xoá** | dừng | phải backfill lại từ đầu |

Hai thao tác này phải **trông khác nhau rõ ràng** trên màn hình.

## Phạm vi

**Trong:**
- Bảng Epic đang theo dõi: key, tên, project, trạng thái đồng bộ, lần đồng bộ cuối, số Sub-task, số thiếu ngày
- Thêm Epic: dán danh sách key **hoặc** duyệt từ Jira, có bước kiểm tra trước
- Tạm dừng / bật lại
- Bỏ theo dõi, có hộp xác nhận nói rõ **dữ liệu sẽ bị xoá**
- Khu "Sub-task thiếu ngày kế hoạch" — danh sách việc phải làm của PM (R-08)
- Nút mở sang biểu đồ và sang Signboard của Epic đó

**Ngoài:**
- Không sửa API
- Không vẽ biểu đồ (T-30 làm)
- Không làm phân quyền theo người dùng

## Đầu vào đã có
- Bảy endpoint từ **T-10**, zod schema trong `packages/shared`
- `DataTable`, `EmptyState`, `ErrorState`, `Badge`, `LoadingState` từ **T-20**
- API trạng thái đồng bộ từ **T-25**

## Việc phải làm

1. `use-epics.ts` — hook cho cả bảy endpoint, mutation tự xoá cache danh sách sau khi ghi.
2. **Luồng thêm Epic hai bước, không được gộp một bước:**
   ```
   dán key hoặc chọn từ Jira
        → gọi /validate
        → hiện bảng: cái nào thêm được, cái nào không và VÌ SAO
        → nói rõ "sẽ mất khoảng N phút để dựng lịch sử"
        → bấm Xác nhận mới gọi POST /api/epics
   ```
3. Trạng thái đồng bộ hiện bằng `Badge` có màu, kèm **thời điểm** đồng bộ gần nhất. Chưa từng đồng bộ thì nói *"đang dựng lịch sử lần đầu, khoảng N phút"* chứ không để trống.
4. Cảnh báo `NO_CHILD_TASK` và `MISSING_WBS_DATES` từ `/validate` hiện ngay tại dòng Epic tương ứng.
5. Bỏ theo dõi: hộp xác nhận buộc **gõ lại key Epic**. Thao tác này xoá dữ liệu và không hoàn tác được.
6. Khu "thiếu ngày kế hoạch": gọi `/missing-dates`, nhóm theo Phase, mỗi dòng có link sang Jira để PM sửa.
7. Bảng sắp xếp được theo lần đồng bộ cuối và theo số Sub-task thiếu ngày — hai cột PM nhìn nhiều nhất.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-3** — component `PascalCase`, file `kebab-case.tsx`.
- **C-9** — mọi thông báo nói **cả điều sai lẫn cách khắc phục**, bằng tiếng Việt.
- **C-14** — checklist trước khi mở PR.

Từ [ARCHITECTURE.md](../ARCHITECTURE.md): chỉ `apps/web/src/api/` được gọi `fetch`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test:web` xanh
- [ ] `pnpm e2e` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**E2E:**
1. `dán 3 key rồi bấm Kiểm tra thì thấy cái nào thêm được cái nào không, và CHƯA thêm gì cả`
2. `key không tồn tại hiện lý do đọc được, không phải mã lỗi`
3. `bấm Xác nhận thêm thì Epic xuất hiện trong bảng với trạng thái đang dựng lịch sử`
4. `tạm dừng rồi bật lại KHÔNG làm mất dữ liệu cũ`
5. `bỏ theo dõi bắt gõ lại key Epic trước khi cho bấm`
6. `Epic có Sub-task thiếu ngày hiện số lượng và bấm vào xem được danh sách`

**Đơn vị:**
7. `màn hình nói rõ thời gian ước tính TRƯỚC khi người dùng bấm thêm`
8. `chưa từng đồng bộ thì hiện "đang dựng lịch sử lần đầu", không để ô trống`
9. `nhãn Tạm dừng và Bỏ theo dõi nói rõ cái nào xoá dữ liệu`

## Định nghĩa "xong"
PM mở màn hình, dán 3 key Epic, thấy trước cái nào hợp lệ, bấm thêm, và theo dõi được tiến trình dựng lịch sử — toàn bộ không cần dev.

## Cạm bẫy đã biết
- **Thêm Epic mà không có bước kiểm tra trước là cách nhanh nhất để PM thêm nhầm 20 Epic.** Backfill 20 Epic mất hàng chục phút và không có nút huỷ. Bước `/validate` tồn tại chính vì lý do đó.
- **Hộp xác nhận chỉ có nút "Đồng ý" là chưa đủ cho thao tác xoá dữ liệu.** Bắt gõ lại key nghe phiền nhưng đây là thao tác duy nhất trong sản phẩm không hoàn tác được.
- **Đừng hiện thời gian ước tính dưới dạng đồng hồ đếm ngược.** `RECOMPUTE_SECONDS_PER_EPIC` là ước tính thô; đếm ngược sẽ sai và làm mất lòng tin vào mọi con số khác.
- **Trạng thái "đang đồng bộ" phải tự cập nhật.** Nhưng đừng hỏi lại mỗi giây — dùng `refetchInterval` chỉ khi có Epic đang chạy, tắt hẳn khi mọi Epic đã xong.
- **`GET /api/epics/browse` gọi thẳng Jira nên chậm.** Hiện `LoadingState` riêng cho khu đó, đừng để cả trang treo.

## Đã làm gì

**10 test E2E xanh** (card yêu cầu 9). Không cần API thật — máy chủ giả trong spec **đọc thân request** và trả lời theo nội dung.

### Đã phải bổ sung schema phản hồi vào `packages/shared`

T-10 chỉ khai `TrackedEpicSummary` bằng `interface`. `interface` **biến mất lúc chạy**, nên frontend không kiểm được gì tại biên — và một trường vắng mặt sẽ lộ ra dưới dạng `undefined` ở giữa màn hình, cách chỗ gây lỗi rất xa.

Đã thêm `trackedEpicSummarySchema`, `validateEpicsResponseSchema`, `missingDatesResponseSchema` và ba cái nữa. Đây là lần thứ hai gặp đúng khoảng trống này (lần đầu ở T-21 với `effectiveConfigSchema`).

### Ba test bảo vệ đúng những chỗ card cảnh báo

1. **"Kiểm tra KHÔNG được ghi gì"** — spec đếm số lần gọi `POST /epics` và đòi bằng 0 sau khi bấm Kiểm tra. Đây là hàng rào chống việc gộp hai bước làm một, mà gộp thì PM rất dễ thêm nhầm 20 Epic và backfill mất hàng chục phút không có nút huỷ.
2. **"Bỏ theo dõi bắt gõ lại mã Epic"** — test gõ sai (`PAY-9`) rồi gõ đúng (`PAY-1`), khẳng định nút chỉ mở khi khớp. Đây là thao tác duy nhất trong sản phẩm không hoàn tác được.
3. **"Epic chưa từng đồng bộ hiện *đang dựng lịch sử lần đầu*"** — ô trống trông y hệt "hệ thống hỏng".

### Một lỗi của chính tôi, do khớp chuỗi gần đúng

Test đầu tiên đỏ với *"expected 2, received 3"*: chuỗi **"không thêm được" chứa "thêm được"**, nên `getByText` khớp cả ba dòng. Phải dùng `{ exact: true }`.

Đây là loại lỗi rất dễ đi theo hướng ngược lại — nếu tôi viết nhãn là "Thêm được" và "Không thêm được" thì test sẽ **xanh nhầm**, và sẽ không phát hiện được khi một dòng hợp lệ biến mất.

### Tự làm mới có điều kiện

`refetchInterval` chỉ bật khi **có Epic đang ở `PENDING` hoặc `BACKFILLING`**; mọi Epic xong thì tắt hẳn. Hỏi lại liên tục là tự tạo tải cho chính mình; không hỏi lại lần nào thì PM phải bấm F5 để biết đã xong chưa.

### Chi tiết khác

- **Nhãn nói thẳng hậu quả**: *"Tạm dừng (giữ dữ liệu)"* và *"Bỏ theo dõi (xoá dữ liệu)"*. Hộp xác nhận còn nhắc lại: chỉ muốn dừng đồng bộ thì dùng nút Tạm dừng.
- **Lỗi của Epic hiện nguyên văn** (`Jira trả 401: token hết hạn`), không rút gọn thành "Sync failed".
- **Ước tính là "khoảng N phút"**, làm tròn lên, cố ý không phải đồng hồ đếm ngược.
- **Cảnh báo khác hẳn lý do từ chối**: `NO_CHILD_TASK` và `MISSING_WBS_DATES` vẫn cho thêm, chỉ hiện huy hiệu vàng để PM biết trước.
- **Cột "Đồng bộ lần cuối" sắp theo `lastSyncedAt`** nên Epic chưa đồng bộ xuống cuối bảng, không lên đầu (luật `null` của `DataTable` từ T-20).
