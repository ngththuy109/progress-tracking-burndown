---
id: T-09
title: API cấu hình Phase — gồm Xem thử trước khi lưu
status: review
model: sonnet
effort: high
depends_on: ["T-06", "T-07", "T-08"]
touches:
  - apps/api/src/routes/config-phase.routes.ts
  - apps/api/src/services/phase-config.service.ts
  - apps/api/src/services/config-preview.service.ts
  - packages/shared/src/api-config.ts
  - apps/api/src/adapters/phase-config.adapters.ts   # bộ chuyển đổi Prisma/Redis
  - apps/api/src/adapters/principal.ts               # cổng xác định người gọi
  - apps/api/src/test-fakes.ts                       # cổng giả để test không cần hạ tầng
  - apps/api/src/server.ts                           # điểm lắp ráp
prd_refs: ["§2.2.4", "§2.2.5", "§2.2.7", "Phụ lục B"]
owner: null
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-09 · API cấu hình Phase — gồm Xem thử trước khi lưu

## Mục tiêu
PM sửa được quy tắc nhận diện Phase qua HTTP và **xem trước kết quả trên dữ liệu thật** rồi mới lưu. Màn hình quản trị (T-21) chỉ là lớp vỏ gọi các API này.

## Ngữ cảnh cần biết

**Xem thử là tính năng bắt buộc phải có** (PRD §2.2.5):

> Không có nó thì PM sửa xong phải đợi tới job đêm hôm sau mới biết đúng hay sai — và cấu hình "đơn giản" trở thành không dùng được trên thực tế.

`POST /preview` chạy cấu hình **nháp** (chưa lưu) trên Task thật của project, trả về từng dòng: mẫu nào khớp, bóc ra gì, **luật nào thắng**, kết quả, và có đổi so với hiện tại không.

**Sau khi lưu thì tính lại toàn bộ lịch sử** (PRD §2.2.7) — nhưng card này **chỉ đánh dấu** `dirty:epics`; việc tính lại do T-18 làm.

## Phạm vi

**Trong:** 6 endpoint theo PRD Phụ lục B

| Method | Đường dẫn | Việc |
|---|---|---|
| `GET` | `/api/config/phase?project=KEY` | Cấu hình đang hiệu lực, đã gộp kế thừa, có cờ `inherited` |
| `POST` | `/api/config/phase/preview` | **Xem thử** với cấu hình nháp |
| `PUT` | `/api/config/phase` | Lưu version mới, trả số Epic sẽ phải tính lại |
| `GET` | `/api/config/phase/versions?project=KEY` | Lịch sử version: ai sửa, lúc nào, ghi chú |
| `POST` | `/api/config/phase/rollback/:version` | Quay về version cũ |
| `GET` | `/api/config/phase/unmatched?project=KEY` | Task chưa nhận diện được, kèm `raw_phase_label` |

**Ngoài:**
- Không làm UI (T-21 làm)
- Không tính lại snapshot — chỉ đẩy Epic vào `dirty:epics` (T-18 làm)
- Không làm API quản lý Epic (T-10 làm)
- Không làm API Signboard (card GĐ 4)

## Đầu vào đã có
- `getEffectiveConfig`, `saveNewVersion`, `rollbackToVersion` từ **T-06**
- `parseTaskTitle` từ **T-07**
- `parseSubtaskTitle` từ **T-08**
- Fastify + zod từ T-01

## Việc phải làm

1. Zod schema cho request/response trong `packages/shared/src/api-config.ts` (FE dùng lại).
2. `GET /api/config/phase` — gọi `getEffectiveConfig`, giữ nguyên cờ `inherited` của từng phần.
3. `POST /api/config/phase/preview` — **endpoint quan trọng nhất**:
   - Nhận cấu hình nháp trong body, **không ghi gì vào DB**
   - Đọc Task và Sub-task thật của project từ `jira_issue`
   - Chạy `parseTaskTitle` với cấu hình nháp
   - So với `phase_code` hiện tại → `status`: `UNCHANGED` / `CHANGED` / `STILL_UNCLASSIFIED`
   - Trả **luật nào thắng** cho từng dòng
   - Đếm số Epic bị ảnh hưởng và ước tính thời gian tính lại
   - Cấu trúc phản hồi **đúng như PRD Phụ lục B** — FE đã đặc tả theo đó
4. `PUT /api/config/phase`:
   - Kiểm tra hợp lệ (T-06 đã có)
   - `saveNewVersion`
   - Tìm Epic bị ảnh hưởng, đẩy vào Redis set `dirty:epics`
   - Trả `{ version, affectedEpics, estimatedRecomputeSeconds }`
5. `GET /versions` — danh sách version kèm `created_by`, `created_at`, `note`.
6. `POST /rollback/:version` — gọi `rollbackToVersion`, cũng đẩy `dirty:epics`.
7. `GET /unmatched` — Task có `phase_code = 'UNCLASSIFIED'`, kèm `raw_phase_label` và số lần xuất hiện, để PM biết cần thêm từ khoá gì.
8. Phân quyền: chỉ role Admin (bộ Mặc định) và PM (bộ project mình phụ trách) được `PUT`/`rollback`.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-3** — JSON API dùng `camelCase`; đổi tên ở tầng repository.
- **C-8** — regex trong cấu hình nháp cũng phải chạy qua `re2` có timeout. Xem thử **không được** làm treo API.
- **C-9** — log JSON có `correlationId`; mã lỗi `SCREAMING_SNAKE`.
- **C-14** — checklist trước khi mở PR.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- apps/api` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Xem thử:**
1. `xem thử KHÔNG ghi gì vào database` — đếm số bản ghi trước và sau, phải bằng nhau
2. `xem thử trả về đúng luật đã thắng cho từng Task`
3. `Task đổi phân loại được đánh dấu status = CHANGED`
4. `Task vẫn không nhận diện được đánh dấu STILL_UNCLASSIFIED`
5. `phần summary đếm đúng số Epic bị ảnh hưởng`
6. `cấu hình nháp có regex ReDoS thì xem thử vẫn trả về trong dưới 2 giây`

**Lưu:**
7. `lưu thành công tạo version mới và trả về số Epic phải tính lại`
8. `lưu thành công đẩy đúng các Epic vào Redis set dirty:epics`
9. `cấu hình không hợp lệ bị từ chối với HTTP 400 và mã lỗi ORPHAN_PHASE_CODE`
10. `lưu thất bại thì KHÔNG có version mới nào được tạo`

**Version và quay lại:**
11. `GET /versions trả đủ lịch sử kèm người sửa và ghi chú`
12. `rollback về version 4 tạo version mới, version 5 vẫn còn trong lịch sử`

**Kế thừa và phân quyền:**
13. `GET /api/config/phase?project=SHOP trả cấu hình đã gộp kèm cờ inherited đúng từng phần`
14. `người dùng thường không được PUT, trả HTTP 403`

**Chưa nhận diện:**
15. `GET /unmatched trả danh sách raw_phase_label kèm số lần xuất hiện, sắp giảm dần`

## Định nghĩa "xong"
PM gọi `POST /preview` với cấu hình nháp thì thấy trước kết quả phân loại trên dữ liệu thật mà database không đổi; gọi `PUT` thì tạo version mới và các Epic liên quan được đánh dấu cần tính lại.

## Cạm bẫy đã biết
- **Xem thử ghi vào database là lỗi nghiêm trọng nhất có thể mắc ở card này.** Test 1 tồn tại vì lỗi này rất dễ xảy ra khi tái dùng nhầm hàm `saveNewVersion`.
- **Cấu trúc phản hồi của `/preview` phải khớp đúng PRD Phụ lục B.** T-21 (màn hình quản trị) đã được đặc tả theo cấu trúc đó. Đổi tên trường sẽ làm hỏng card sau.
- **Đừng tính lại snapshot ngay trong request.** Tính lại 50 Epic mất vài phút, request sẽ timeout. Chỉ đẩy `dirty:epics` rồi trả về ngay; T-18 nhặt sau.
- **`estimatedRecomputeSeconds` là ước tính, không phải cam kết.** Ghi rõ trong tài liệu API để FE không hiển thị như đồng hồ đếm ngược chính xác.
- **Regex nháp cũng phải giới hạn timeout.** Không thì PM dán một regex xấu là API treo — mà đây là API chạy đồng bộ trước mặt người dùng.

## Đã làm gì

**24 test xanh** (card yêu cầu 15). 6 endpoint đầy đủ theo Phụ lục B. `typecheck` · `lint` · toàn workspace xanh.

### Kiến trúc: cổng trước, hạ tầng sau

Máy này **không có PostgreSQL và Redis**. Nếu tầng service gọi thẳng Prisma thì cả card này sẽ không có lấy một test chạy được — và bộ test không chạy được là bộ test không tồn tại.

Nên toàn bộ service nói chuyện qua **cổng**: `PhaseConfigStore`, `IssueReadPort`, `DirtyEpicQueue`, `resolvePrincipal`. Bộ chuyển đổi Prisma/Redis thật nằm riêng ở `adapters/`, mỗi hàm chỉ một truy vấn và một phép đổi tên. Test dùng cổng giả trong bộ nhớ (`test-fakes.ts`) và chạy qua `fastify.inject()` — tức là **đi qua HTTP thật**, không gọi tắt vào service.

Đây cũng là cách chứng minh được điều card sợ nhất: `FakeConfigStore` **đếm số lần ghi**, và test khẳng định con số đó bằng 0 sau khi xem thử. Không có bộ đếm thì "xem thử không ghi gì" chỉ là lời hứa.

### Ba quyết định

1. **Xem thử phải GỘP KẾ THỪA, không chạy trên bản nháp trần.** Đây là chỗ dễ sai nhất mà card không nêu. PM sửa bản nháp của project PAY chỉ để đổi luật khớp, để trống danh sách Phase — chạy trên bản nháp trần thì mọi Task ra `UNCLASSIFIED`, trong khi lưu thật lại kế thừa đầy đủ từ Mặc định. **Xem thử mà nói dối thì thà không có.** Có test riêng.

2. **`buildPreview` là hàm thuần, tách khỏi service.** Nó nhận danh sách Task đã nạp sẵn và trả về dữ liệu — không có cổng ghi nào trong tầm với. Lỗi "xem thử ghi nhầm vào DB" không phải được *tránh*, mà là **không thể xảy ra**.

3. **Kiểm tra hợp lệ chạy TRƯỚC `store.save`.** Nếu kiểm tra sau thì đã có version mới nằm trong DB rồi mới báo lỗi. Có hai test riêng: không tạo version, và không đẩy Epic nào vào `dirty:epics`.

### Ba thứ thêm ngoài card

- **`limit` cho `/preview`** (mặc định 200). Project lớn có hàng nghìn Task. Phần `summary` vẫn đếm trên **toàn bộ**, nên so `rows.length` với `totalTasks` là biết có bị cắt — không giấu.
- **Xem thử trả về CẢ lỗi chặn lẫn cảnh báo.** PM cần biết mình sắp không lưu được ngay lúc xem thử, chứ không phải sau khi bấm Lưu rồi mới nhận HTTP 400.
- **Cảnh báo gom theo mã, không lặp theo Task.** Một luật nhập nhằng sẽ sinh cảnh báo trên cả nghìn dòng và làm ngập danh sách.

### Một điểm cần chốt trước khi lên production

`resolvePrincipalFromHeaders` **tin vào header** `x-user-id` / `x-user-role`. Chỉ an toàn khi API không bao giờ nhận request trực tiếp từ Internet và gateway xoá sạch các header đó khỏi request của client. GĐ 1 chưa chốt SSO hay JWT nên để đây làm cổng thay thế được — nhưng nếu triển khai mà quên, **bất kỳ ai cũng tự xưng được là ADMIN**. Đã ghi cảnh báo ngay trong file.
