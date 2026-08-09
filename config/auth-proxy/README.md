# Cổng SSO (mô hình B1)

Cách lắp Single Sign-On cho Burndown Engine **mà không sửa logic của API**. API
vẫn chỉ đọc danh tính từ header; một auth proxy đứng trước lo phần đăng nhập.

## Vì sao thiết kế thế này

`POST /api/epics` và mọi thao tác ghi cần một _principal_ (ai đang đăng nhập +
vai trò). API lấy principal từ **danh tính do cổng đặt vào header** rồi **tra vai
trò ở bảng `app_user`**. Điểm mấu chốt về bảo mật:

- Cổng chỉ khẳng định **DANH TÍNH** (`x-user-id` = email đã xác thực qua SSO).
- API **không bao giờ tin `role` từ header** — vai trò/`projects` đến từ database
  của chính hệ thống. Dù cổng có lỡ để lọt header `x-user-role: ADMIN` giả thì
  cũng vô hại.
- Cổng **xoá sạch mọi header `x-user-*` do client gửi** trước khi đặt của mình.

```
Trình duyệt ──HTTPS──▶ Cổng (nginx + oauth2-proxy)
                        │   1. Chưa đăng nhập → chuyển tới IdP (OIDC/SSO)
                        │   2. Đã đăng nhập  → đặt  x-user-id = email
                        │                      xoá  x-user-* của client
                        ├───▶ SPA tĩnh (dist của @app/web)
                        └───▶ API  (127.0.0.1:3000)  ──▶ tra app_user → role
```

## Phương án TẠM: Basic Auth (test nhanh khi chưa có app Entra)

Chưa tạo được App registration Entra? Bảo vệ app cho **vài người test** bằng
**Basic Auth** — cùng mô hình header, **không sửa code**. Đây là bản **tạm**, thay
bằng SSO khi có app Entra. Cấu hình: `nginx-basic-auth.conf.example`.

1. **Dựng nginx** theo `nginx-basic-auth.conf.example` (trỏ `root` tới bản build web),
   **chạy API riêng tư**, áp migration:

   ```bash
   pnpm db:migrate
   HOST=127.0.0.1 pnpm --filter @app/api dev
   ```

2. **Thêm người bằng MỘT lệnh** — `auth:testuser` gộp cả tạo login (htpasswd) lẫn
   cấp vai trò (`app_user`); username = email chữ thường. Cần lệnh `htpasswd`
   (gói `apache2-utils` / `httpd-tools`) và `DATABASE_URL`.

   ```bash
   pnpm auth:testuser --user you@cty.com --role ADMIN         # bạn — admin đầu tiên

   # Gán PM thì đăng ký project TRƯỚC (màn hình Projects, hoặc:
   #   INSERT INTO "project"(project_key) VALUES ('PAY') ON CONFLICT DO NOTHING;)
   pnpm auth:testuser --user pm@cty.com --role PM --projects PAY,CRM
   pnpm auth:testuser --user tester@cty.com                   # mặc định VIEWER
   ```

   Mỗi lệnh in ra **mật khẩu ngẫu nhiên** để đưa người dùng (hoặc tự đặt bằng
   `--password`). File htpasswd mặc định `/etc/nginx/burndown.htpasswd` (đổi bằng
   `--htpasswd`); tạo file lần đầu thì `nginx -s reload`.

3. **Đăng nhập** bằng email + mật khẩu → dùng thử. Admin tinh chỉnh tiếp vai
   trò/project trên màn hình **Users** / **Projects**.

**Giới hạn cần biết:** BẮT BUỘC HTTPS (mật khẩu đi kèm mỗi request); không đăng
xuất/hết phiên; chỉ hợp cho **vài người, tạm thời**. Gỡ người: xoá login
`htpasswd -D /etc/nginx/burndown.htpasswd tester@cty.com`, và hạ/xoá quyền
(`pnpm auth:grant --user … --role VIEWER` hoặc xoá dòng `app_user`).

---

## Seed admin tự động khi deploy

`pnpm seed:admin` tạo sẵn một admin, **idempotent** (chạy lại mỗi lần deploy vô
hại). Cấu hình đọc từ env (xem `.env.example`); chưa đặt `SEED_ADMIN_EMAIL` thì
bỏ qua. Đặt vào bước release, **SAU** migration:

```bash
pnpm db:migrate && pnpm db:seed && pnpm seed:admin
```

`pnpm db:seed` nạp bộ Mặc định (nhận diện Phase + cột Signboard + lịch làm việc),
cũng **idempotent**. Thiếu bước này thì màn hình Phase settings / Signboard columns
trả 500 `NO_GLOBAL_CONFIG` — xem [RUNBOOK.md](../../docs/RUNBOOK.md).

- `SEED_ADMIN_EMAIL` → ghi một dòng ADMIN vào `app_user` (đủ cho cả SSO lẫn Basic Auth).
- Thêm `SEED_ADMIN_PASSWORD` (+ `SEED_ADMIN_HTPASSWD`) khi dùng **Basic Auth** → tạo
  luôn login htpasswd; **bỏ qua nếu user đã có** (không reset mật khẩu mỗi deploy).

Đổi mật khẩu sau này: xoá dòng trong htpasswd (hoặc dùng `pnpm auth:testuser`) rồi deploy lại.

---

## Các bước triển khai (SSO — mục tiêu)

1. **Đăng ký ứng dụng ở Microsoft Entra ID** (Azure Portal → Microsoft Entra ID
   → App registrations → New registration):
   - Chọn **Single tenant** (chỉ tài khoản trong tổ chức).
   - Redirect URI (Web): `https://<host>/oauth2/callback`.
   - Ghi lại **Application (client) ID** và **Directory (tenant) ID**.
   - **Certificates & secrets → New client secret** → copy giá trị.
   - **Token configuration → Add optional claim → ID → `email`** (để có claim
     `email`; nếu tổ chức không gán `mail` thì dùng `preferred_username` — xem
     ghi chú trong file cfg).
   - **API permissions**: Microsoft Graph (delegated) `openid`, `email`,
     `profile` → **Grant admin consent**.

2. **Cấu hình oauth2-proxy** — chép `oauth2-proxy.cfg.example` → `oauth2-proxy.cfg`,
   điền `<TENANT_ID>` / `<APPLICATION_CLIENT_ID>` / client secret. Đã đặt sẵn
   `provider = "oidc"` với endpoint v2.0 và `set_xauthrequest = true`.

3. **Cấu hình nginx** — chép `nginx.conf.example`, trỏ `root` tới thư mục build
   của web (`pnpm --filter @app/web build` → `apps/web/dist`). File mẫu đã đặt
   `x-user-id` = email và xoá header `x-user-*` của client.

4. **Chạy API ở chế độ riêng tư** — API chỉ được nhận request từ cổng:

   ```bash
   HOST=127.0.0.1 \
   AUTH_BOOTSTRAP_ADMINS=you@your-company.com \
   AUTH_DEFAULT_ROLE=VIEWER \
   pnpm --filter @app/api dev     # hoặc lệnh chạy production của bạn
   ```

   - `AUTH_IDENTITY_HEADER` — mặc định `x-user-id`. Đổi cho khớp cổng (bảng dưới).
   - `AUTH_BOOTSTRAP_ADMINS` — email luôn là ADMIN, để **mồi admin đầu tiên**.
   - `AUTH_DEFAULT_ROLE` — vai trò cho người đã đăng nhập nhưng chưa được cấp
     quyền. `VIEWER` (khuyến nghị) cho xem-mở/ghi-chặn; `NONE` để từ chối hẳn.

5. **Build web trỏ tới trang đăng nhập của cổng** — để khi phiên hết hạn frontend
   tự đá về đăng nhập:

   ```bash
   VITE_SIGN_IN_PATH=/oauth2/sign_in pnpm --filter @app/web build
   ```

6. **Áp migration & cấp quyền** — bảng `app_user` và `project` do migration tạo:

   ```bash
   pnpm db:migrate
   ```

   Admin đầu tiên đã có nhờ `AUTH_BOOTSTRAP_ADMINS`. Sau khi đăng nhập:

   1. **Đăng ký project** đã (PM chỉ gán được vào project có thật):
      - **Màn hình Projects** (thanh bên, chỉ ADMIN) — khuyến nghị; hoặc
      - SQL: `INSERT INTO "project"(project_key) VALUES ('PAY') ON CONFLICT DO NOTHING;`
   2. **Cấp quyền** cho người khác:
      - **Màn hình Users** — cấp Admin/PM/Viewer, tick project cho PM từ danh sách
        đã đăng ký. Khuyến nghị cho vận hành hằng ngày.
      - **CLI** (script / CI): `auth:grant` cũng kiểm PM chỉ nhận project đã đăng ký.
        ```bash
        pnpm auth:grant --user pm@cty.com --role PM --projects PAY,CRM
        pnpm auth:grant --user ai@cty.com --role VIEWER
        ```

## Đổi IdP hoặc loại cổng

API chỉ cần **một header danh tính**; đặt `AUTH_IDENTITY_HEADER` cho khớp:

| Cổng                     | Header danh tính                         |
| ------------------------ | ---------------------------------------- |
| nginx + oauth2-proxy     | `x-user-id` (file mẫu tự đặt từ email)   |
| GCP IAP                  | `x-goog-authenticated-user-email`        |
| AWS ALB (OIDC/Cognito)   | `x-amzn-oidc-identity`                    |
| Cloudflare Access        | `cf-access-authenticated-user-email`     |

Với IAP/ALB/Cloudflare thì **bỏ nginx auth_request + oauth2-proxy**; phần còn lại
(API tra `app_user`, frontend, provisioning) giữ nguyên.

## Danh sách kiểm bảo mật

- [ ] API **không** expose ra Internet (chỉ nghe từ cổng — `HOST=127.0.0.1` hoặc
      network policy nội bộ).
- [ ] Cổng **xoá** mọi header `x-user-*` do client gửi trước khi đặt của mình.
- [ ] `cookie_secret` / `client_secret` lấy từ secret manager, **không commit**.
- [ ] `/healthz` mở (để LB thăm dò); mọi route khác bắt đăng nhập.

## Kiểm nhanh sau khi dựng

```bash
# Chưa đăng nhập → bị đá sang IdP (302), KHÔNG phải 200.
curl -sI https://<host>/api/epics | head -1

# Giả một header x-user-role qua client → phải bị bỏ qua (cổng xoá header giả),
# và vẫn 401 vì chưa đăng nhập.
curl -sI -H 'x-user-role: ADMIN' https://<host>/api/epics | head -1
```

Sau khi đăng nhập bằng tài khoản trong `AUTH_BOOTSTRAP_ADMINS`, mở màn hình Epics
và thử **Add** — không còn `UNAUTHENTICATED`. Tài khoản VIEWER sẽ thấy ô Add bị ẩn
và mọi thao tác ghi trả 403.
