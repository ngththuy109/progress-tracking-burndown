# Tự động build & chạy máy chủ web (mặc định cổng 8080)

**Ai đọc file này:** người cần đưa giao diện (`apps/web`) lên một máy chủ web đã
build — để thử bản production tại chỗ, chạy trong container, hoặc self-host đơn
giản.

**Mục tiêu:** từ mã nguồn tới một máy chủ web đang chạy ở **`http://localhost:8080`**
bằng **một lệnh**, và biết cách **đổi cổng** khi cần.

> **TL;DR**
>
> ```bash
> pnpm web:start          # build `apps/web` rồi phục vụ bản tĩnh ở cổng 8080
> ```
>
> Đổi cổng: `WEB_PORT=9090 pnpm web:start` — hoặc đặt `WEB_PORT` trong `.env` ở
> gốc repo. Bỏ trống thì **mặc định là 8080**.

---

## 1. Hai "máy chủ web" — đừng nhầm

`apps/web` có **hai** cách chạy, cho hai mục đích khác nhau:

| | Dev server | **Máy chủ web đã build** (file này) |
|---|---|---|
| Lệnh | `pnpm dev` (gồm cả API + worker) | `pnpm web:start` |
| Công cụ | `vite` (dev, có HMR) | `vite preview` (phục vụ `dist/` tĩnh) |
| Cổng | **5180** | **8080** (đổi qua `WEB_PORT`) |
| Build trước? | Không — biên dịch nóng trong bộ nhớ | **Có** — chạy `vite build` ra `apps/web/dist/` |
| Chèn danh tính giả cho DEV? | Có, nếu đặt `VITE_DEV_USER` | **KHÔNG bao giờ** (xem §5) |
| Dùng khi nào | Đang code, cần sửa-là-thấy | Thử bản production, container, self-host |

Phần còn lại của tài liệu nói về **cột bên phải**. Cần dev server thì xem
[ONBOARDING.md](./ONBOARDING.md) §4.

---

## 2. Một lệnh: tự động build rồi phục vụ

```bash
pnpm web:start
```

Lệnh này chạy `vite build && vite preview` (xem `apps/web/package.json`):

1. **`vite build`** biên dịch React + gói tài nguyên vào `apps/web/dist/`.
2. **`vite preview`** mở một máy chủ web tĩnh phục vụ đúng thư mục `dist/` đó, mặc
   định ở **cổng 8080**.

Xong sẽ thấy dòng như:

```
  ➜  Local:   http://localhost:8080/
  ➜  Network: http://192.168.x.x:8080/
```

Dừng bằng `Ctrl+C`.

> **Máy chủ web cần API để có dữ liệu.** `vite preview` chỉ phục vụ *giao diện*.
> Mọi lời gọi `/api/...` được proxy sang API (mặc định `http://localhost:3000` —
> xem §5). Muốn có dữ liệu thật thì API phải đang chạy: `pnpm dev` (chạy cả cụm),
> hoặc chạy riêng `pnpm --filter @app/api dev`. Thiếu API thì giao diện vẫn lên
> nhưng các màn hình báo lỗi tải.

---

## 3. Đổi cổng (mặc định 8080)

Cổng đọc từ biến môi trường **`WEB_PORT`**; bỏ trống thì dùng **8080**. Ba cách
đặt, theo thứ tự ưu tiên (cách trên **thắng** cách dưới):

```bash
# 1) Chỉ cho MỘT lần chạy — đặt ngay trước lệnh:
WEB_PORT=9090 pnpm web:start

# 2) Cho cả shell hiện tại:
export WEB_PORT=9090
pnpm web:start
```

```bash
# 3) Cố định trong .env ở GỐC repo (dùng lại mỗi lần, không phải gõ):
echo 'WEB_PORT=9090' >> .env
pnpm web:start
```

> **Vì sao KHÔNG dùng biến `PORT`?** API đã dùng `PORT` (mặc định 3000). Web và
> API chạy **song song**; nếu web cũng đọc `PORT` thì đặt `PORT=8080` sẽ kéo cả
> hai về tranh nhau. Nên máy chủ web có biến riêng: `WEB_PORT`.

> **Cổng bận thì BÁO LỖI NGAY, không âm thầm nhảy cổng.** Máy chủ đặt
> `strictPort: true`: nếu 8080 (hay cổng bạn chọn) đang có người nghe, nó dừng
> với lỗi `Port 8080 is already in use` thay vì lặng lẽ nhảy sang 8081. Chủ ý:
> hướng dẫn ghi 8080 mà thực tế chạy cổng khác là kiểu lỗi mất cả buổi mới lần
> ra. Gặp lỗi này thì đổi `WEB_PORT`, hoặc tắt tiến trình đang giữ cổng
> (`lsof -i :8080`).

`WEB_PORT` không phải số cổng hợp lệ (trống, chữ, ngoài khoảng 1–65535) thì máy
chủ **lùi về 8080** thay vì chết bằng lỗi khó hiểu — xem `resolveWebPort` trong
`apps/web/vite.config.ts`.

### Đổi host lắng nghe (tuỳ chọn)

Mặc định máy chủ nghe trên **`0.0.0.0`** (mọi giao diện mạng) để truy cập được từ
máy khác / trong Docker — giống API. Thu hẹp về chỉ máy này bằng `WEB_HOST`:

```bash
WEB_HOST=127.0.0.1 pnpm web:start   # chỉ localhost gọi được
```

### Mở bằng tên máy / tên miền — `WEB_ALLOWED_HOSTS` (tuỳ chọn)

`vite preview` có một lá chắn chống **DNS-rebinding**: nó **chặn** (`403 Blocked
request`) mọi request mà header `Host` là **tên máy / tên miền** không nằm trong
danh sách cho phép. **Địa chỉ IP** (v4/v6) và **`localhost`** thì luôn được cho
qua sẵn.

Hệ quả: dù đã bind `0.0.0.0`, mở bằng **tên** — `http://vm:8080`,
`http://app.cty.com:8080` — từ máy khác vẫn bị 403, **nhìn hệt như "chỉ localhost
mới vào được"**. Vì vậy máy chủ này **mặc định cho phép MỌI host** để hết lỗi
ngay: bind mọi giao diện mạng rồi lại chặn theo tên là tự mâu thuẫn.

Cần siết lại (vd phơi thẳng ra mạng không tin cậy) thì liệt kê host qua
`WEB_ALLOWED_HOSTS` — ngăn cách bởi dấu phẩy:

```bash
WEB_ALLOWED_HOSTS=app.cty.com,vm pnpm web:start   # chỉ 2 tên này (+ IP/localhost)
```

Tiền tố `.` khớp cả subdomain: `.cty.com` cho phép `a.cty.com`, `b.cty.com`… Bỏ
trống thì quay về **cho phép mọi host** (xem `resolveAllowedHosts` trong
`apps/web/vite.config.ts`).

---

## 4. Build một lần, phục vụ nhiều lần (CI / triển khai)

`pnpm web:start` build **lại mỗi lần** — tiện khi thử tại chỗ, nhưng phí khi
triển khai. Tách hai bước:

```bash
pnpm web:build     # chỉ build → apps/web/dist/  (bước chậm, chạy một lần / cache lại)
pnpm web:serve     # chỉ phục vụ dist/ có sẵn ở WEB_PORT (bật nhanh, không build lại)
```

| Lệnh | = | Làm gì |
|---|---|---|
| `pnpm web:build` | `vite build` | Build tĩnh ra `apps/web/dist/` |
| `pnpm web:serve` | `vite preview` | Phục vụ `dist/` **có sẵn** ở `WEB_PORT` |
| `pnpm web:start` | `vite build && vite preview` | Cả hai — tự động build rồi phục vụ |

> **`web:serve` cần `dist/` có sẵn.** Chạy `web:serve` mà chưa từng
> `web:build` thì `vite preview` báo không tìm thấy thư mục build. Cứ chạy
> `web:build` trước, hoặc dùng thẳng `web:start`.

---

## 5. `/api` đi đâu, và vì sao KHÔNG có danh tính giả

Giao diện gọi API bằng đường **cùng gốc** `/api/...`. Máy chủ web proxy những lời
gọi đó sang API thật:

- Đích mặc định: `http://localhost:3000`.
- Đổi qua env **`VITE_API_TARGET`** (ví dụ API nằm ở máy/cổng khác):

  ```bash
  VITE_API_TARGET=http://10.0.0.5:3000 pnpm web:serve
  ```

**Khác biệt quan trọng so với dev server:** proxy của bản build **KHÔNG chèn**
header danh tính (`x-user-id`).

- Dev server (`pnpm dev`) có thể chèn danh tính giả khi đặt `VITE_DEV_USER`, để
  code-và-thử ở local không vướng 401 (xem [AUTH.md §9](./AUTH.md)).
- Bản build **không** làm vậy — nó mô phỏng đúng production: đứng **sau một cổng
  SSO thật**, cổng đó mới là nơi đặt danh tính. Chèn ở đây sẽ mở toang một lối
  ghi và có nguy cơ lọt lên production.

Hệ quả khi thử bằng `vite preview`:

- Thao tác **ĐỌC** (xem biểu đồ, Signboard, danh sách Epic) — **chạy ngay**.
- Thao tác **GHI** (thêm Epic, sửa cấu hình, quản lý người dùng) — trả **401
  UNAUTHENTICATED**, đúng như production khi chưa qua cổng SSO. Muốn thử ghi thì
  đặt máy chủ web **sau cổng thật** (§6) hoặc dùng dev server với `VITE_DEV_USER`.

---

## 6. Triển khai production thật

`vite preview` gọn cho **thử tại chỗ, container, self-host**. Còn production thật
thì **không** phơi `vite preview` ra Internet: nó là máy chủ xem-thử, không phải
máy chủ web đã tôi luyện.

Cách khuyến nghị: một **auth proxy** (nginx) vừa phục vụ file tĩnh `dist/`, vừa
chuyển tiếp `/api`, vừa xác thực SSO rồi đặt header danh tính — xem
[`config/auth-proxy/`](../config/auth-proxy/) và [AUTH.md](./AUTH.md). Ở mô hình
đó, **nginx** làm chủ cổng (443), nên `WEB_PORT` / `vite preview` không tham gia;
việc của bạn chỉ là `pnpm web:build` rồi trỏ `root` của nginx vào `apps/web/dist`.

```
Trình duyệt ──HTTPS──▶ nginx (cổng 443, +SSO)
                        ├──▶ file tĩnh: apps/web/dist   (pnpm web:build)
                        └──▶ /api → API 127.0.0.1:3000
```

---

## 7. Bảng cổng toàn dự án

| Ứng dụng | Cổng | Đặt ở đâu |
|---|---|---|
| Web — dev server | 5180 | `WEB_DEV_PORT` trong `apps/web/vite.config.ts` |
| Web — **máy chủ đã build** | **8080** | **`WEB_PORT`** (mặc định `WEB_PREVIEW_PORT`) |
| API | 3000 | `PORT` (xem `apps/api/src/server.ts`) |
| E2E (Playwright) | 5199 | `playwright.config.ts` |

---

## 8. Trục trặc thường gặp

| Triệu chứng | Nguyên nhân & cách xử lý |
|---|---|
| `Port 8080 is already in use` | Cổng đang bận. Đổi `WEB_PORT`, hoặc tắt tiến trình giữ cổng: `lsof -i :8080`. `strictPort` cố ý không cho nhảy cổng ngầm. |
| Chạy `web:serve` báo không có build / thư mục `dist` trống | Chưa build. Chạy `pnpm web:build` trước, hoặc dùng `pnpm web:start`. |
| Trang lên nhưng mọi màn hình lỗi tải dữ liệu | API chưa chạy hoặc `VITE_API_TARGET` sai. Bật API (`pnpm dev` / `pnpm --filter @app/api dev`) và kiểm lại đích proxy. |
| Thao tác ghi trả **401** | Đúng thiết kế — bản build không chèn danh tính. Đặt sau cổng SSO (§6), hoặc thử ghi bằng dev server + `VITE_DEV_USER`. |
| Máy khác trong LAN không mở được **bằng IP** | `WEB_HOST` đang là `127.0.0.1`. Để trống (mặc định `0.0.0.0`) hoặc đặt IP cụ thể. |
| Mở **bằng IP thì được, bằng tên máy/tên miền lại `403 Blocked request`** | Lá chắn DNS-rebinding của Vite chặn Host lạ. Mặc định đã cho phép mọi host; nếu bạn có đặt `WEB_ALLOWED_HOSTS` thì thêm tên đó vào (hoặc bỏ trống để mở hết) — xem §3. |

---

## 9. Liên quan

- [ONBOARDING.md](./ONBOARDING.md) — dựng máy từ đầu, chạy dev server.
- [AUTH.md](./AUTH.md) — mô hình danh tính, vì sao API không tự đăng nhập.
- [`config/auth-proxy/`](../config/auth-proxy/) — mẫu nginx + oauth2-proxy cho production.
