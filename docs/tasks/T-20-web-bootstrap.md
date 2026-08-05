---
id: T-20
title: Dựng app web — router, layout và lớp gọi API
status: review
model: sonnet
effort: medium
depends_on: ["T-01"]
touches:
  - apps/web/index.html
  - apps/web/vite.config.ts
  - apps/web/package.json
  - apps/web/tsconfig.json
  - apps/web/src/main.tsx
  - apps/web/src/App.tsx
  - apps/web/src/styles.css
  - apps/web/src/test-setup.ts
  - apps/web/src/routes/
  - apps/web/src/layout/
  - apps/web/src/api/client.ts
  - apps/web/src/api/query-client.ts
  - apps/web/src/api/phase-config.queries.ts
  - apps/web/src/components/ui/
  - apps/web/e2e/smoke.spec.ts
  - playwright.config.ts
  - vitest.config.ts
  - package.json
prd_refs: ["§1.4", "Phụ lục B"]
owner: claude
started_at: 2026-08-03
finished_at: 2026-08-03
---

# T-20 · Dựng app web — router, layout và lớp gọi API

## Mục tiêu
Có một SPA chạy được với điều hướng, layout chung và lớp gọi API dùng chung. T-21 và các card giao diện GĐ 4 chỉ việc thêm màn hình vào khung này.

## Ngữ cảnh cần biết

Stack đã chốt tại [ARCHITECTURE.md §4](../ARCHITECTURE.md): **React + Vite + TanStack Query**, biểu đồ dùng Recharts, E2E bằng Playwright.

**Quy tắc phụ thuộc** — `apps/web` chỉ được import `packages/shared`, **không** được import `engine`, `db`, `jira`.

**`apps/web/src/api/` là nơi DUY NHẤT gọi `fetch`.** Component không tự gọi API. Lý do: mọi màn hình đều cần xử lý giống nhau ba trạng thái (đang tải / lỗi / rỗng), và tập trung ở một chỗ thì không phải làm lại 5 lần.

PRD Phụ lục B đã đặc tả đầy đủ các endpoint; `packages/shared` đã có zod schema từ T-09 và T-10 — **dùng lại, không khai lại type ở FE**.

**Các màn hình sẽ được thêm sau** (không làm ở card này):

| Màn hình | Card |
|---|---|
| Cấu hình nhận diện Phase | T-21 |
| Danh sách Epic theo dõi | GĐ 4 |
| Biểu đồ Burndown 3 chế độ | GĐ 4 |
| Bảng Signboard | GĐ 4 |

## Phạm vi

**Trong:**
- Vite + React + TypeScript chạy được, có proxy sang API khi dev
- React Router với 4 route rỗng (placeholder) cho 4 màn hình trên
- Layout chung: thanh bên điều hướng, thanh trên, vùng nội dung
- TanStack Query đã cấu hình: retry, `staleTime`, error boundary
- `api/client.ts` — wrapper `fetch` có xử lý lỗi thống nhất, parse zod
- Component dùng chung: `LoadingState`, `ErrorState`, `EmptyState`, `Badge`, `DataTable`
- 1 test E2E smoke
- Hiển thị lỗi bằng tiếng Việt

**Ngoài:**
- Không làm bất kỳ màn hình nghiệp vụ nào (T-21 và GĐ 4 làm)
- Không vẽ biểu đồ
- Không làm xác thực người dùng (chưa có trong phạm vi v1.0)
- Không làm dark mode, i18n

## Đầu vào đã có
- Khung `apps/web` từ **T-01**
- `packages/shared` — zod schema của API từ **T-09**, **T-10**

## Việc phải làm

1. Vite config: proxy `/api` sang `http://localhost:3000` khi dev; path alias `@app/shared`.
2. `api/client.ts`:
   - Wrapper quanh `fetch`, base URL từ env
   - Parse phản hồi bằng zod schema của `packages/shared`
   - Lỗi HTTP → ném `ApiError` có `code` và `message` **tiếng Việt**
   - Không tự thử lại (để TanStack Query lo)
3. `api/query-client.ts`: `retry: 1`, `staleTime: 30s`, `refetchOnWindowFocus: false` (dữ liệu chốt theo ngày, không cần fetch lại liên tục).
4. Layout: thanh bên có 4 mục điều hướng, đánh dấu mục đang chọn.
5. 4 route placeholder — mỗi cái render một `EmptyState` ghi *"Màn hình này sẽ được xây ở card T-NN"*.
6. Component dùng chung, **không gọi API bên trong**:
   - `LoadingState` — skeleton
   - `ErrorState` — thông báo tiếng Việt + nút Thử lại
   - `EmptyState` — biểu tượng + mô tả + hành động tuỳ chọn
   - `Badge` — nhãn trạng thái có màu
   - `DataTable` — bảng có sắp xếp, dùng cho danh sách Epic và Signboard sau này
7. E2E smoke: mở app, điều hướng qua 4 route, không có lỗi console.

## Quy ước bắt buộc
Từ [CONVENTIONS.md](./CONVENTIONS.md):

- **C-3** — JSON API `camelCase`; component `PascalCase`; file `kebab-case.tsx`.
- **C-9** — thông báo lỗi phải nói **cả điều sai lẫn cách khắc phục**, bằng tiếng Việt.
- **C-14** — checklist trước khi mở PR, gồm `pnpm e2e`.

Thêm, từ [ARCHITECTURE.md](../ARCHITECTURE.md):

- `apps/web` **không** import `engine`, `db`, `jira` — chỉ `shared`.
- `apps/web/src/api/` là nơi **duy nhất** gọi `fetch`.

## Checklist đầu ra
- [ ] `pnpm typecheck` xanh
- [ ] `pnpm lint` xanh
- [ ] `pnpm test -- apps/web` xanh
- [ ] `pnpm e2e` xanh
- [ ] `pnpm dev` mở được app trên trình duyệt
- [ ] Không đụng file ngoài `touches`
- [ ] Cập nhật `status: review` + `finished_at`
- [ ] Ghi 3–5 dòng "Đã làm gì"

## Test phải viết

**Đơn vị:**
1. `client ném ApiError có mã lỗi khi API trả HTTP 400`
2. `client ném lỗi khi phản hồi không khớp zod schema` — bắt lỗi sớm thay vì để undefined lan ra UI
3. `thông báo lỗi hiển thị bằng tiếng Việt, không phải chuỗi tiếng Anh của trình duyệt`
4. `ErrorState hiện nút Thử lại và gọi lại hàm khi bấm`
5. `EmptyState hiện đúng mô tả được truyền vào`

**E2E:**
6. `mở app hiện được layout với 4 mục điều hướng`
7. `bấm qua cả 4 route không sinh lỗi console`
8. `API trả lỗi thì màn hình hiện ErrorState, không hiện trang trắng`

## Định nghĩa "xong"
`pnpm dev` mở được app, điều hướng qua 4 màn hình placeholder không lỗi, và một endpoint trả lỗi thì người dùng thấy thông báo tiếng Việt kèm nút Thử lại chứ không phải trang trắng.

## Cạm bẫy đã biết
- **Component tự gọi `fetch` là thứ khó gỡ nhất về sau.** Ban đầu tiện, nhưng tới màn hình thứ ba thì mỗi chỗ xử lý lỗi một kiểu. Tập trung ở `api/` ngay từ đầu.
- **Không parse zod ở client thì lỗi API sẽ lộ ra dưới dạng `undefined` giữa màn hình**, cách chỗ gây lỗi rất xa. Parse ở biên để lỗi nổ đúng chỗ.
- **`refetchOnWindowFocus` mặc định bật của TanStack Query gây gọi API thừa.** Dữ liệu ở đây chốt theo ngày, không đổi khi người dùng chuyển tab. Tắt đi.
- **Đừng khai lại type API ở FE.** `packages/shared` đã có zod schema từ T-09/T-10. Khai lại thì hai bên lệch nhau lúc nào không biết.
- **`DataTable` sẽ được dùng cho cả danh sách Epic lẫn Signboard.** Signboard có ô gộp nhiều dòng và tooltip — đừng thiết kế `DataTable` quá cứng, để chỗ cho render tuỳ biến từng ô.

## Đã làm gì

**47 test đơn vị + 7 test E2E xanh** (card yêu cầu 5 + 3). Cả `pnpm dev`, `pnpm build` (89 kB nén gzip) lẫn `pnpm e2e` đều chạy được.

### Cạm bẫy đã dính thật, mất khá lâu mới ra

Lần chạy E2E đầu tiên: **cả 7 spec đỏ** với "không tìm thấy phần tử". Mở file `error-context.md` của Playwright ra thì thấy nó chụp lại được một trang tên **"Sen Spa — Đặt lịch trong 30 giây"**.

Nguyên nhân: `reuseExistingServer: true` làm Playwright thấy cổng 5173 đang có người nghe là dùng luôn, **không kiểm tra đó có phải app của mình không**. Cổng 5173 là cổng mặc định của Vite nên một dự án khác trên cùng máy đang chiếm.

Đã sửa ba chỗ, mỗi chỗ chặn một tầng:

| Sửa | Chặn được gì |
|---|---|
| `pnpm dev` đổi sang cổng **5180** | Không đụng cổng mặc định mà mọi dự án đều nhắm vào |
| E2E dùng cổng **5199** riêng | Chạy E2E không phải tắt dev server đang mở |
| `reuseExistingServer: false` | Playwright luôn tự bật máy chủ, không bao giờ mượn của người lạ |

Thêm `strictPort: true`: mặc định Vite thấy cổng bận thì lẳng lặng nhảy sang cổng kế tiếp, và lỗi lại nổ ở một chỗ chẳng liên quan.

### Cờ `--pass-with-no-tests` đã gỡ

Đúng như ghi chú T-01 để lại. Đã kiểm chứng bằng cách xoá tạm file spec — `pnpm e2e` đỏ ngay.

### Ba thứ làm khác card

1. **Trang `/config/phase` gọi API THẬT** thay vì để trống như ba trang kia. Bốn trang tạm trống không chứng minh được gì cả — chuỗi `client → TanStack Query → LoadingState/ErrorState/EmptyState` có chạy hay không thì vẫn không ai biết. Trang này dùng luôn `configPayloadSchema` của `@app/shared`, nên nó cũng là ví dụ mẫu cho T-21 và GĐ 4.

2. **`pnpm typecheck` trước đây KHÔNG hề kiểm `apps/web`.** Root `tsconfig.json` không tham chiếu tới nó (không tham chiếu được — app web là `noEmit`, không phải project `composite`), nên `tsc --build` bỏ qua hoàn toàn. Đã nối thêm `&& tsc --noEmit -p apps/web`. Đây là lỗi im lặng đúng nghĩa: mọi lệnh đều xanh trong khi cả một app không được kiểm dòng nào.

3. **`vite.config.ts` và `e2e/` được đưa vào `include` của tsconfig.** Không đưa vào thì một selector sai kiểu chỉ lộ ra lúc chạy Playwright.

### Hai quyết định về thiết kế

**`client.ts` không phụ thuộc zod.** Nó nhận `{ parse(input: unknown): T }` — mọi schema của `@app/shared` khớp sẵn, mà `apps/web` không phải khai thêm phụ thuộc.

**`fetch` được truyền vào, không lấy từ biến toàn cục.** Giống cách `FakeJira` đã làm ở T-11: test dựng được mọi tình huống lỗi mà không cần đụng tới `globalThis`.

### Vài test đáng nói

- **"mọi câu thông báo đều nói người dùng phải làm gì tiếp"** — quét toàn bộ 9 mã HTTP, tìm động từ hành động. Người thêm mã mới mà viết mỗi "Đã xảy ra lỗi" là đỏ ngay. Đây là cách duy nhất tôi nghĩ ra để kiểm C-9 bằng máy.
- **"ô thiếu dữ liệu luôn xuống cuối bảng"** — `null` chạy theo hướng sắp xếp sẽ đẩy toàn bộ Sub-task thiếu ngày lên đầu và che mất dữ liệu thật.
- **"DataTable không sửa mảng của người gọi"** — `rows` nằm trong cache TanStack Query; `.sort()` tại chỗ là sửa luôn cache, và màn hình khác dùng chung query sẽ đổi thứ tự theo mà không hiểu vì sao.
- **"mất mạng thì `Failed to fetch` không hiện ra"** — E2E khẳng định câu tiếng Anh **có** trong trang nhưng nằm trong khối "Chi tiết kỹ thuật" đóng sẵn, rồi mở ra kiểm chứng là đọc được. Test đầu tiên tôi viết sai ở đúng chỗ này.

### Đã cài thêm

`jsdom`, `@testing-library/react`, `@testing-library/user-event` vào `apps/web` (devDependencies), và một project `web` trong `vitest.config.ts` chạy môi trường `jsdom`. Trình duyệt Chromium của Playwright cũng phải tải lại vì `pnpm add` nâng `@playwright/test` lên 1.62.
