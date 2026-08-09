# Xác thực & phân quyền

**Ai đọc file này:** dev hoặc người vận hành cần hiểu ai được làm gì, và cách cấp/gỡ quyền.

Đây là nguồn sự thật về mô hình phân quyền. Cấu hình cổng SSO cụ thể (nginx +
oauth2-proxy cho Microsoft Entra ID) nằm ở [`config/auth-proxy/`](../config/auth-proxy/).

---

## 1. Mô hình tổng quan (SSO "B1")

`apps/api` **không tự đăng nhập người dùng**. Một **auth proxy** đứng trước, đăng
nhập bằng SSO (OpenID Connect) rồi bơm header danh tính cho API. Điểm mấu chốt:

- Cổng chỉ khẳng định **DANH TÍNH** — header `x-user-id` = email đã xác thực.
- API **không tin `role` từ header** — vai trò tra bảng `app_user` trong DB.
- Cổng **xoá mọi header `x-user-*` do client gửi** trước khi đặt của mình.

```
Trình duyệt ──HTTPS──▶ Cổng (nginx + oauth2-proxy)   [IdP: Microsoft Entra ID]
                         │  1. Chưa đăng nhập → chuyển tới IdP (OIDC)
                         │  2. Đã đăng nhập  → đặt x-user-id = email; xoá x-user-* của client
                         ├──▶ SPA tĩnh (apps/web build)
                         └──▶ API → tra app_user → role + projects
```

Vì sao thiết kế thế này: dù cổng có lỡ để lọt một header `x-user-role: ADMIN`
giả thì cũng vô hại — vai trò luôn đến từ database của hệ thống, không từ header.

## 2. Ba vai trò

| Vai trò | Xem | Ghi (thêm/sửa Epic, cấu hình) | Quản lý người dùng & project |
|---|---|---|---|
| `ADMIN` | tất cả | ✅ | ✅ |
| `PM` | project mình phụ trách | ✅ (trong project của mình) | ❌ |
| `VIEWER` | tất cả | ❌ | ❌ |

- **PM ↔ Project là nhiều–nhiều:** một PM gán được nhiều project; một project gắn
  được nhiều PM. Danh sách project của PM lưu ở `app_user.projects` (mảng).
- Người đã đăng nhập SSO nhưng **chưa được cấp quyền** mặc định là `VIEWER`
  (đổi bằng `AUTH_DEFAULT_ROLE`).

## 3. Danh tính → vai trò được phân giải thế nào

`apps/api/src/adapters/principal.ts` (`createPrincipalResolver`), chạy một lần mỗi
request qua hook `onRequest`:

1. Đọc header danh tính (`AUTH_IDENTITY_HEADER`, mặc định `x-user-id`), chuẩn hoá
   email về chữ thường. Không có → không có principal.
2. Email nằm trong `AUTH_BOOTSTRAP_ADMINS` → **ADMIN** (admin mồi, chống deadlock).
3. Ngược lại tra bảng `app_user` → dùng `role`/`projects` trong đó.
4. Không có trong `app_user` → `AUTH_DEFAULT_ROLE` (mặc định `VIEWER`; đặt `NONE`
   để từ chối hẳn).

## 4. Bảng dữ liệu

- **`app_user`** — nguồn sự thật của phân quyền: `user_id` (email, PK), `role`
  (`ADMIN`/`PM`/`VIEWER`), `projects` (mảng key), `display_name`.
- **`project`** — danh mục Project do Admin quản lý, dùng làm danh sách chọn khi
  gán PM: `project_key` (chữ HOA, PK), `display_name`. **Không** ràng buộc
  `tracked_epic` (Epic đến từ Jira với mọi project).

Migration: `20260809000000_app_user`, `20260809010000_project`.

## 5. API (đều CHỈ ADMIN, trừ `/api/me`)

| Method | Đường dẫn | Việc |
|---|---|---|
| GET | `/api/me` | Ai đang đăng nhập (mọi vai trò); 401 nếu chưa |
| GET | `/api/users` | Liệt kê người dùng (gộp admin mồi từ env, chỉ-đọc) |
| POST | `/api/users` | Cấp/sửa; PM chỉ nhận project đã đăng ký |
| DELETE | `/api/users/:userId` | Gỡ quyền |
| GET | `/api/projects` | Danh mục project kèm số PM (`pmCount`) |
| POST | `/api/projects` | Đăng ký/sửa project (key chuẩn hoá chữ HOA) |
| DELETE | `/api/projects/:projectKey` | Xoá — **chặn (409)** nếu còn PM đang gắn |

Hai lớp chống tự khoá ở `/api/users`: không cho sửa/xoá **chính mình**; không cho
sửa email cấp qua `AUTH_BOOTSTRAP_ADMINS` (do env quyết).

## 6. Biến môi trường

| Biến | Mặc định | Việc |
|---|---|---|
| `AUTH_IDENTITY_HEADER` | `x-user-id` | Tên header danh tính do cổng đặt (đổi theo proxy) |
| `AUTH_BOOTSTRAP_ADMINS` | (rỗng) | Danh sách email luôn là ADMIN — mồi admin đầu tiên |
| `AUTH_DEFAULT_ROLE` | `VIEWER` | Vai trò cho người đã đăng nhập nhưng chưa cấp quyền (`NONE` = từ chối) |

Xem `.env.example`. Frontend: `VITE_SIGN_IN_PATH` để 401 đá về trang đăng nhập của cổng.

## 7. Cấp / gỡ quyền

**Thứ tự:** đăng ký project trước, rồi mới gán PM vào project đó.

1. **Admin đầu tiên** — đặt `AUTH_BOOTSTRAP_ADMINS=you@cty.com` (không cần DB).
2. **Đăng ký project** — màn hình **Projects** (chỉ ADMIN), hoặc
   `INSERT INTO "project"(project_key) VALUES ('PAY') ON CONFLICT DO NOTHING;`
3. **Cấp quyền** — màn hình **Users** (tick project cho PM từ danh sách), hoặc CLI:

   ```bash
   pnpm auth:grant --user pm@cty.com --role PM --projects PAY,CRM
   pnpm auth:grant --user ai@cty.com --role VIEWER
   ```

   CLI cũng kiểm PM chỉ nhận project đã đăng ký (nhất quán với API).

**Gỡ quyền:** hạ về VIEWER (`pnpm auth:grant … --role VIEWER`) hoặc xoá dòng trong `app_user`.

## 8. Bảo mật

- API **không** expose ra Internet — chỉ nghe từ cổng (`HOST=127.0.0.1` hoặc
  network policy nội bộ).
- Cổng **xoá** mọi `x-user-*` của client trước khi đặt của mình.
- Vai trò luôn từ DB, không từ header; `/api/users` & `/api/projects` chỉ ADMIN.
- Secret (`client_secret`, `cookie_secret`) từ secret manager, **không commit**.

## 9. Chạy local (không có cổng)

Ở máy dev không có cổng SSO: API *đọc* vẫn chạy, nhưng thao tác *ghi* cần header
danh tính. Cách nhanh: đặt `AUTH_BOOTSTRAP_ADMINS=you@cty.com` rồi gửi kèm
`x-user-id` — qua một oauth2-proxy local, hoặc thêm `-H 'x-user-id: you@cty.com'`
khi gọi bằng `curl`. Xem thêm [ONBOARDING.md](./ONBOARDING.md).
