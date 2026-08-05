---
id: T-21
title: Màn hình quản trị cấu hình Phase — có Xem thử và lịch sử version
status: review
model: opus
effort: high
depends_on: ["T-09", "T-20"]
touches:
  - apps/web/src/routes/config-phase/
  - apps/web/src/api/use-phase-config.ts
  - apps/web/e2e/phase-config.spec.ts
  - apps/web/e2e/smoke.spec.ts
  - apps/web/src/routes/app-routes.tsx
  - apps/web/src/styles.css
  - packages/shared/src/api-config.ts
prd_refs: ["§2.2.4", "§2.2.5", "§2.2.6", "US-07", "US-08", "US-09"]
owner: claude
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-21 · Màn hình quản trị cấu hình Phase — có Xem thử và lịch sử version

## Mục tiêu
PM tự sửa quy tắc nhận diện Phase, xem trước kết quả trên dữ liệu thật, rồi mới lưu — **không cần nhờ dev, không cần deploy**. Đây là màn hình làm giảm rủi ro R-01 (dữ liệu Jira không sạch, khả năng **Cao**).

## Ngữ cảnh cần biết

**Xem thử là tính năng bắt buộc phải có** (PRD §2.2.5):

> Không có nó thì PM sửa xong phải đợi tới job đêm hôm sau mới biết đúng hay sai — và cấu hình "đơn giản" trở thành không dùng được trên thực tế.

**Mockup màn hình** (PRD §2.2.4) — 3 khu:

```
┌─ Cấu hình nhận diện Phase ────────────────── [ Mặc định ▼ ] ──┐
│  ① MẪU TIÊU ĐỀ  (thử lần lượt từ trên xuống)                  │
│  ┌──────────────────────────────────────────────────┐         │
│  │ ≡  [Phase] {name}                          [🗑]  │         │
│  │ ≡  【{name}】                               [🗑]  │         │
│  │                                    [ + Thêm mẫu ] │         │
│  └──────────────────────────────────────────────────┘         │
│  ☑ Nếu không mẫu nào khớp → tìm từ khoá trên cả tiêu đề        │
│                                                                │
│  ② DANH SÁCH PHASE  (kéo ≡ để đổi thứ tự hiển thị)            │
│  ┌────┬─────────────┬────────────┬──────────┬───────┐         │
│  │ ≡  │ DESIGN      │ Thiết kế   │ 設計      │ ■ #4A │         │
│  │ ≡  │ DEVELOPMENT │ Phát triển │ 開発      │ ■ #2E │         │
│  └────┴─────────────┴────────────┴──────────┴───────┘         │
│                                                                │
│  ③ LUẬT KHỚP TỪ KHOÁ                                          │
│  ┌───────────────┬─────────┬─────────────┬─────────┐          │
│  │ Design Review │ chứa    │ TESTING     │   10    │          │
│  │ Design        │ chứa    │ DESIGN      │   50    │          │
│  └───────────────┴─────────┴─────────────┴─────────┘          │
├────────────────────────────────────────────────────────────────┤
│   [ 👁 Xem thử ]        [ Lịch sử ]           [ 💾 Lưu ]        │
└────────────────────────────────────────────────────────────────┘
```

**Bảng Xem thử** (PRD §2.2.5) — cột `Tiêu đề gốc | Mẫu khớp | Bóc ra | Luật thắng | → Phase | Kết quả`, kèm dòng tổng kết *"12 Task — 8 đổi phân loại, 1 vẫn chưa nhận diện được"*.

**Kế thừa theo project** (PRD §2.2.6) — phần chưa ghi đè hiện nhãn mờ *"kế thừa từ Mặc định"* kèm nút **Ghi đè cho project này**. Ba phần kế thừa **độc lập nhau**.

## Phạm vi

**Trong:**
- Bộ chọn phạm vi: Mặc định / từng project
- Khu ① mẫu tiêu đề: thêm, xoá, kéo đổi thứ tự, ô tích lưới an toàn
- Khu ② danh sách Phase: mã, tên VI, tên JA, màu, kéo đổi `display_order`
- Khu ③ luật khớp: từ khoá, chế độ `chứa`/`regex`, → Phase, `match_priority`
- Nhãn "kế thừa từ Mặc định" + nút Ghi đè cho từng phần
- Nút **Xem thử** → bảng kết quả + hộp thoại xác nhận trước khi lưu
- Tab **Lịch sử** → danh sách version + nút Quay lại
- Hiển thị lỗi kiểm tra hợp lệ tại đúng trường gây lỗi

**Ngoài:**
- Không sửa API (T-09 đã có đủ)
- Không làm màn hình cấu hình cột Signboard (card GĐ 4)
- Không tự tính lại snapshot — API đã lo

## Đầu vào đã có
- 6 endpoint từ **T-09**, gồm `POST /preview` với cấu trúc phản hồi trong PRD Phụ lục B
- Khung web, `DataTable`, `EmptyState`, `ErrorState` từ **T-20**
- Zod schema trong `packages/shared` từ T-09

## Việc phải làm

1. `use-phase-config.ts` — TanStack Query hooks: `useEffectiveConfig`, `usePreview` (mutation), `useSaveConfig`, `useVersions`, `useRollback`, `useUnmatched`.
2. **Trạng thái nháp nằm ở client.** Mọi thao tác sửa chỉ đổi state cục bộ; chỉ `Xem thử` và `Lưu` mới gọi API. Có chỉ báo "chưa lưu".
3. Kéo thả đổi thứ tự bằng `dnd-kit`. Phân biệt rõ trên UI:
   - Khu ② kéo đổi **`display_order`** — thứ tự hiển thị trên biểu đồ
   - Khu ③ sửa **`match_priority`** — ưu tiên khi khớp
   Hai thứ này khác nhau (PRD §2.2.3); nhãn phải nói rõ để PM không nhầm.
4. **Luồng Xem thử → Lưu** (PRD §2.2.7):
   ```
   PM bấm Xem thử → gọi POST /preview với cấu hình nháp
                  → hiện bảng kết quả từng dòng
                  → dòng tổng kết + số Epic phải tính lại
                  → [Quay lại sửa] hoặc [Xác nhận lưu]
   ```
   **Không cho bấm Lưu thẳng mà chưa Xem thử** — hoặc nếu cho thì phải cảnh báo.
5. Bảng Xem thử: đánh dấu màu theo `status` (`UNCHANGED` / `CHANGED` / `STILL_UNCLASSIFIED`), hiện rõ **luật nào thắng**.
6. Lỗi kiểm tra hợp lệ từ API → hiện ngay tại trường gây lỗi, không phải một banner chung chung.
7. Tab Lịch sử: version, người sửa, thời điểm, ghi chú, nút Quay lại có xác nhận.
8. Khu "Chưa nhận diện được" — gọi `GET /unmatched`, hiện `raw_phase_label` kèm số lần xuất hiện, có nút thêm nhanh thành luật mới.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-3** — JSON API `camelCase`.
- **C-9** — thông báo lỗi nói **cả điều sai lẫn cách khắc phục**, bằng tiếng Việt.
- **C-14** — checklist, gồm `pnpm e2e`.

Từ [ARCHITECTURE.md](../ARCHITECTURE.md):

- Chỉ `apps/web/src/api/` được gọi `fetch`; component nhận dữ liệu qua hook.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- apps/web` xanh
- [ ] `pnpm e2e -- phase-config.spec.ts` xanh
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**E2E — theo đúng US-07, US-08, US-09:**
1. `thêm luật từ khoá mới và bấm Xem thử thì thấy bảng kết quả, cấu hình CHƯA được lưu`
2. `bảng Xem thử hiện rõ luật nào đã thắng cho từng Task`
3. `dòng tổng kết đếm đúng số Task đổi phân loại`
4. `bấm Xác nhận lưu thì tạo version mới và hiện số Epic sẽ tính lại`
5. `luật trỏ tới Phase không tồn tại thì lỗi hiện ngay tại dòng luật đó, không phải banner chung`
6. `chọn project SHOP và bấm Ghi đè mẫu tiêu đề thì khu Phase vẫn hiện nhãn kế thừa từ Mặc định`
7. `mở tab Lịch sử và bấm Quay lại version cũ thì tạo version mới, version bị bỏ vẫn còn trong danh sách`

**Đơn vị:**
8. `sửa trường bất kỳ thì hiện chỉ báo chưa lưu`
9. `kéo đổi thứ tự trong khu Phase chỉ đổi display_order, KHÔNG đổi match_priority`
10. `nhãn của hai khu nói rõ display_order là thứ tự hiển thị, match_priority là ưu tiên khớp`
11. `API trả lỗi mạng thì hiện ErrorState với nút Thử lại`

## Định nghĩa "xong"
PM mở màn hình, thêm một từ khoá, bấm Xem thử thấy trước kết quả trên Task thật, bấm Xác nhận lưu thì tạo version mới — toàn bộ không cần dev can thiệp.

## Cạm bẫy đã biết
- **Gọi API mỗi lần gõ phím sẽ làm màn hình giật và tốn tài nguyên.** Trạng thái nháp phải nằm ở client; chỉ Xem thử và Lưu mới gọi API.
- **Cho bấm Lưu thẳng mà bỏ qua Xem thử làm hỏng giá trị của cả tính năng.** PRD §2.2.5 nói rõ Xem thử là bắt buộc. Ít nhất phải cảnh báo trước khi lưu mù.
- **Gộp `display_order` và `match_priority` trên UI là lỗi trực tiếp dẫn tới hiểu nhầm nghiệp vụ.** PRD §2.2.3 dành hẳn một mục để tách bạch hai khái niệm. Nhãn UI phải phản ánh điều đó.
- **Lỗi kiểm tra hợp lệ hiện thành banner chung ở đầu trang thì PM không biết sửa dòng nào** — nhất là khi có 20 luật khớp. Phải neo lỗi vào đúng trường.
- **Kéo thả trên bảng dài dễ mất trạng thái cuộn.** Kiểm tra với danh sách 30 luật.
- **Đừng đổi tên trường trong phản hồi `/preview`.** T-09 đã trả đúng cấu trúc PRD Phụ lục B; FE map lại tên sẽ khiến hai bên lệch nhau.

## Đã làm gì

**41 test đơn vị + 7 test E2E xanh** (card yêu cầu 4 + 7). Cả 7 test E2E bám đúng US-07, US-08, US-09.

### Hai lỗi thật, đều do test bắt được

**1. Lưu xong thì thông báo "Đã lưu thành v5" biến mất ngay lập tức.**
Tôi cho `ConfigEditor` dựng lại (đổi `key`) sau mỗi lần lưu để nạp bản mới. Nhưng dựng lại xoá luôn trạng thái của mutation — tức xoá chính thông báo vừa hiện ra. Người dùng bấm Lưu rồi thấy… không có gì xảy ra.

Sửa bằng cách bỏ hẳn việc dựng lại: thêm một hành động `COMMIT` nói "bản nháp giờ chính là bản trên máy chủ". Giữ được cả vị trí cuộn lẫn ô ghi chú.

**2. Playwright chặn nhầm mã nguồn của chính app.**
Máy chủ giả trong spec dùng glob `**/api/**`. Nhưng ở chế độ dev, Vite phục vụ `/src/api/client.ts` — thư mục **cũng tên `api`**. Trình duyệt nhận JSON thay cho module JavaScript, app không khởi động nổi, và cả 7 test đỏ với "không tìm thấy phần tử" — chẳng liên quan gì tới thứ đang kiểm.

Dấu vết duy nhất nằm ở một dòng console: *"Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of application/json"*. Đã đổi sang so đường dẫn bằng hàm `(url) => url.pathname.startsWith('/api/')` ở **cả hai** spec.

### Chỗ dễ sai nhất của cả màn hình

**Phần vẫn kế thừa phải gửi lên MẢNG RỖNG, không phải bản sao của bộ Mặc định.**

Máy chủ coi mảng rỗng là "chưa ghi đè, cứ kế thừa tiếp". Gửi bản sao thì project **đóng băng** cấu hình tại thời điểm đó: sau này sửa bộ Mặc định, project không nhận thay đổi nữa, mà nhìn màn hình vẫn thấy y hệt như cũ. Không lỗi nào báo ra, và phải mất hàng tuần mới có người hỏi "sao project này không chịu cập nhật".

Nhưng **Xem thử thì ngược lại** — phải gửi cấu hình đầy đủ, kể cả phần kế thừa. Gửi rỗng thì bảng xem thử hiện mọi Task rơi vào "Chưa phân loại" và PM tưởng mình vừa làm hỏng cấu hình. Hai hàm riêng, `payloadToSave` và `payloadToPreview`, mỗi hàm một test.

### Một chỗ làm khác card

Card ghi *"kéo thả đổi thứ tự bằng dnd-kit"*. Tôi dùng **nút lên/xuống**, ba lý do:

1. Kéo–thả không dùng được bằng bàn phím nếu không viết thêm khá nhiều mã.
2. Chính card này cảnh báo *"kéo thả trên bảng dài dễ mất trạng thái cuộn"* — nút bấm không có vấn đề đó.
3. Thêm một thư viện cho đúng một thao tác là không đáng.

Ký hiệu `≡` trong bản vẽ PRD §2.2.4 vẫn giữ làm chỗ bám mắt. Cần kéo–thả thật thì thêm sau, phần trạng thái đã sẵn sàng (`MOVE_PHASE` / `MOVE_PATTERN`).

### Toàn bộ trạng thái nháp là hàm thuần

`draft-state.ts` không đụng React một dòng nào: một reducer, một hàm `isDirty`, hai hàm sinh payload. 21 test chạy không cần DOM, không cần máy chủ.

Nhờ vậy kiểm được thẳng điều PRD §2.2.3 nhấn mạnh: **`MOVE_PHASE` đổi `displayOrder` và tuyệt đối không đụng `matchRules`**. Test so nguyên mảng `matchRules` trước và sau — gộp hai khái niệm là đỏ ngay.

### Chi tiết đáng nói khác

- **Lỗi neo vào đúng dòng**, không phải banner ở đầu trang. `indexIssues` có một test riêng cho việc `matchRules[1]` không được lẫn với `matchRules[10]` — thiếu dấu chấm khi so tiền tố là lỗi hiện sai dòng và PM sửa nhầm chỗ.
- **Lưu thẳng không bị chặn nhưng phải qua một bước cảnh báo.** Chặn cứng thì sửa một dấu cách trong ghi chú cũng phải xem thử lại.
- **Bộ chọn phạm vi là ô gõ tay**, vì chưa có endpoint nào trả danh sách project. Có rồi thì đổi sang `<select>` là xong.
- **Đã thêm `effectiveConfigSchema` vào `packages/shared`.** T-09 mới chỉ có `configPayloadSchema`, thiếu phần `inherited` — mà thiếu nó thì màn hình mất sạch nhãn "kế thừa từ Mặc định" và không có lỗi nào báo.
- **Test "KHÔNG gọi API mỗi lần gõ phím"** đếm số lần gọi `fetch` trước và sau khi gõ 12 ký tự. Đây là ràng buộc trung tâm của cả màn hình nên phải có test giữ, không chỉ ghi trong ghi chú.
