# Xác thực & phân quyền

**Ai đọc file này:** dev hoặc người vận hành cần hiểu ai được làm gì, và cách cấp/gỡ quyền.

Đây là nguồn sự thật về mô hình phân quyền. Cấu hình cổng SSO cụ thể (nginx +
oauth2-proxy cho Microsoft Entra ID) nằm ở [`config/auth-proxy/`](../config/auth-proxy/).

---

## 1. Mô hình tổng quan — HAI CHẾ ĐỘ đăng nhập

Hệ thống có hai chế độ xác thực; **quyền luôn tra DB** ở cả hai (không bao giờ
tin role từ bên ngoài):

### Chế độ LDAP in-app (khuyến nghị — cấu hình qua UI)

App **tự đăng nhập bằng LDAP**: người dùng nhập username/password vào form của
app, API bind vào LDAP server của công ty để xác thực. ADMIN vào **Admin →
LDAP** cấu hình (server URL, cách xác định DN, bind password mã hóa AES-256-GCM
bằng `APP_ENCRYPTION_KEY` — write-only như token Jira), bấm **Test** rồi bật.
Không cần dựng oauth2-proxy nữa.

```
Trình duyệt ──POST /auth/login {username, password}──▶ API
                 │  Direct bind:      bind(DN từ template, password)
                 │  Search-then-bind: bind(tài khoản dịch vụ) → search user
                 │                    theo filter → bind(DN tìm được, password)
                 ▼
   LDAP server (ldap:// hoặc ldaps://)
                 │ bind OK → đọc attribute email (danh tính app_user)
                 ▼
   session Redis + cookie ptb_sess (HttpOnly) → API tra app_user + project_member
```

- **Hai cách xác định DN** (chọn một ở màn hình cấu hình): *direct bind* bằng
  template (`uid={username},ou=users,dc=congty,dc=vn` — hợp OpenLDAP) hoặc
  *search-then-bind* bằng tài khoản dịch vụ (cách chuẩn với **Active
  Directory**, filter kiểu `(sAMAccountName={username})`).
- Server **từ chối bật LDAP** khi bài test CONNECT/BIND chưa pass — không thể
  tự khóa mình bằng một cấu hình hỏng.
- Đã bật LDAP thì header `x-user-id` bị **bỏ qua hoàn toàn** (chống giả mạo khi
  app lộ ra ngoài không qua cổng). Thoát hiểm khi kẹt: env `AUTH_FORCE_HEADER=1`
  (xem RUNBOOK).
- Đăng nhập chỉ xác thực DANH TÍNH — người bind LDAP thành công nhưng chưa được
  cấp quyền (`app_user`/membership) vẫn "không thấy dự án nào", đúng mô hình
  quyền-ở-DB.

### Chế độ header qua cổng (legacy — vẫn hỗ trợ khi LDAP tắt)

Khi LDAP chưa bật (mặc định sau nâng cấp), giữ nguyên mô hình cũ: một **auth
proxy** đứng trước, đăng nhập rồi bơm header danh tính:

- Cổng chỉ khẳng định **DANH TÍNH** — header `x-user-id` = email đã xác thực.
- API **không tin `role` từ header** — quyền tra bảng `app_user` + `project_member` trong DB.
- Cổng **xoá mọi header `x-user-*` do client gửi** trước khi đặt của mình.

> Chế độ này cũng là đường chạy **local dev** (`VITE_DEV_USER` — Vite dev proxy
> đóng vai cổng) và Basic Auth tạm — xem [`config/auth-proxy/`](../config/auth-proxy/).

Vì sao quyền luôn ở DB: dù cổng/IdP có lỡ để lọt một claim/header `ADMIN` giả
thì cũng vô hại — quyền chỉ đến từ database của hệ thống.

## 2. Quyền HAI TẦNG (multi-tenant — tenant = Jira project key)

Từ Phase B, mỗi **project là một tenant**. Quyền có hai tầng:

| Tầng | Ở đâu | Giá trị | Ý nghĩa |
|---|---|---|---|
| Toàn cục | `app_user.role` | `ADMIN` | Thấy/quản MỌI dự án, quản trị hệ thống (`/api/admin/...`); trong bất kỳ dự án nào có role hiệu dụng PM |
| | | `MEMBER` | Chỉ thấy dự án mình là thành viên |
| Trong dự án | `project_member.role` | `PM` | Ghi trong dự án đó: thêm/sửa Epic, cấu hình, resync, lịch riêng, cửa sổ ops |
| | | `VIEWER` | Chỉ xem dự án đó |

- Một người có thể là **PM của dự án A đồng thời VIEWER của dự án B** — membership
  lưu từng dòng ở `project_member` (PK `(project_key, user_id)`).
- **KHÔNG còn "VIEWER toàn cục xem tất cả"** như trước multi-tenant. Người đã
  đăng nhập nhưng chưa có membership nào thì đăng nhập được nhưng **không thấy
  dự án nào**.

### Luật 404-thay-vì-403 (chống dò tenant)

Với mọi route `/api/projects/:projectKey/...`: dự án **không tồn tại** và dự án
**tồn tại nhưng người gọi không phải thành viên** trả về **cùng một
`404 PROJECT_NOT_FOUND`**. Trả 403 cho người ngoài là xác nhận "dự án này có
thật" — đúng thứ multi-tenant phải giấu. `403 FORBIDDEN` chỉ dành cho người
**đã ở trong dự án** nhưng thiếu bậc quyền (VIEWER gọi route PM), và cho người
không phải ADMIN gọi `/api/admin/...`. Epic cũng theo luật này: key Epic của
tenant khác ghép vào URL dự án mình → `404 EPIC_NOT_FOUND`.

Toàn bộ kiểm tra nằm Ở MỘT CHỖ: guard `requireProject(minRole)` / `requireAdmin` /
`requireAuthenticated` trong `apps/api/src/adapters/project-scope.ts` — route chỉ
khai bậc quyền tối thiểu, không tự kiểm lẻ tẻ nữa.

## 3. Danh tính → quyền được phân giải thế nào

`apps/api/src/adapters/principal.ts` (`createPrincipalResolver`), chạy một lần mỗi
request qua hook `onRequest`, cho ra `Principal = { userId, isAdmin, memberships }`:

1. Đọc header danh tính (`AUTH_IDENTITY_HEADER`, mặc định `x-user-id`), chuẩn hoá
   email về chữ thường. Không có → không có principal (401).
2. Email nằm trong `AUTH_BOOTSTRAP_ADMINS` → **isAdmin** (admin mồi, chống deadlock).
3. Ngược lại tra `app_user` (kèm join `project_member`) → `isAdmin` + `memberships`.
4. Không có trong `app_user` → theo `AUTH_DEFAULT_ROLE`: mặc định `MEMBER`
   (vào được, chưa thấy dự án nào); `NONE` = từ chối hẳn; `ADMIN` chỉ dành cho dev.

## 4. Bảng dữ liệu

- **`app_user`** — role TOÀN CỤC: `user_id` (email, PK), `role` (`ADMIN`/`MEMBER`),
  `display_name`. Cột `projects` cũ đã bỏ.
- **`project_member`** — role TRONG DỰ ÁN: `(project_key, user_id)` PK, `role`
  (`PM`/`VIEWER`), `added_by`, `added_at`. FK sang `app_user` → phải cấp user trước.
- **`project`** — GỐC TENANT: key Jira (chữ HOA, PK), trạng thái ACTIVE/ARCHIVED,
  kết nối Jira riêng (token mã hoá AES-256-GCM bằng `APP_ENCRYPTION_KEY` — API
  không bao giờ trả token, chỉ `hasJiraToken`), field mapping, timezone, lịch mặc định.

Migration: `20260812000000_multi_tenant` (đổi từ `20260809*` cũ).

## 5. API — mount theo tenant

Nghiệp vụ nằm dưới `/api/projects/:projectKey/...` (guard theo membership);
quản trị nằm dưới `/api/admin/...` (chỉ ADMIN).

| Nhóm | Đường dẫn | Quyền |
|---|---|---|
| Ai đang đăng nhập | `GET /api/me` (kèm danh sách dự án vào được) | đã đăng nhập |
| Lịch built-in | `GET /api/calendars`, `GET /api/calendars/:id/holidays\|makeup-workdays` | đã đăng nhập |
| Epic của dự án | `GET .../epics`; `POST .../epics[/validate]`, `GET .../epics/browse`, `PATCH\|DELETE .../epics/:epicKey` | GET: VIEWER; còn lại: PM |
| Số liệu Epic | `.../epics/:epicKey/` `burndown[...]`, `burndown/day/:date/explain`, `signboard/...`, `phase-subtasks`, `plan-conflicts`, `health`, `plan-shift-history`, `missing-dates` | VIEWER |
| Vận hành Epic | `POST .../epics/:epicKey/resync` | PM |
| Tổng hợp | `GET .../plan-conflicts/summary` | VIEWER |
| Cấu hình Phase của dự án | `GET .../config/phase[/versions\|/unmatched]`, `GET .../config/signboard-columns`; `PUT .../config/phase`, `POST .../config/phase/preview\|rollback/:v` | GET: VIEWER; ghi: PM |
| Lịch của dự án | `GET .../calendars[...]`; import/xoá holiday & makeup-workday trên **lịch riêng của dự án** | GET: VIEWER; ghi: PM (lịch built-in: chỉ ADMIN, PM nhận 403) |
| Ops của dự án | `GET .../ops/health`, `GET .../ops/runs/:id`, `GET .../ops/data-quality/issues`, `PUT .../ops/data-quality/issues/:key/exempt` — mọi số đo đã bó theo tenant | PM |
| Quản người dùng | `GET\|POST /api/admin/users`, `DELETE /api/admin/users/:userId` | ADMIN |
| Quản tenant | `GET /api/admin/projects`; `PUT\|DELETE /api/admin/projects/:key`; `PUT .../:key/jira`; `POST .../:key/jira/test` | ADMIN |
| Thành viên dự án | `GET\|PUT /api/admin/projects/:key/members`, `DELETE .../members/:userId` | ADMIN |
| Bộ Mặc định (GLOBAL) | `/api/admin/config/phase[...]` (cùng các đường con như bản dự án) | ADMIN |
| Lịch built-in (ghi) | `/api/admin/calendars/:id/holidays\|makeup-workdays/...` | ADMIN |
| Dashboard toàn cục | `GET /api/admin/ops/health\|runs/:id\|data-quality/...` | ADMIN |

`.../` = `/api/projects/:projectKey/`. Các đường `/api/epics`, `/api/burndown/...`,
`/api/signboard/...`, `/api/config/phase`, `/api/users`, `/api/ops/...` CŨ đã bỏ
hẳn — không có alias tương thích.

Chống tự khoá ở `/api/admin/users` (như cũ): không sửa/xoá **chính mình**; không
sửa email cấp qua `AUTH_BOOTSTRAP_ADMINS` (do env quyết).

## 6. Biến môi trường

| Biến | Mặc định | Việc |
|---|---|---|
| `AUTH_IDENTITY_HEADER` | `x-user-id` | Tên header danh tính do cổng đặt (đổi theo proxy) |
| `AUTH_BOOTSTRAP_ADMINS` | (rỗng) | Danh sách email luôn là ADMIN — mồi admin đầu tiên |
| `AUTH_DEFAULT_ROLE` | `MEMBER` | Quyền cho người đã đăng nhập nhưng chưa cấp (`NONE` = từ chối; `ADMIN` chỉ cho dev). **Giá trị cũ `VIEWER`/`PM` vẫn nhận nhưng giờ chỉ nghĩa là MEMBER-chưa-có-dự-án — hành vi "VIEWER xem tất cả" đã bỏ.** |
| `APP_ENCRYPTION_KEY` | (rỗng) | Khoá AES-256 (base64, 32 byte) mã hoá Jira token của tenant. Bắt buộc khi có tenant nhập token riêng — boot từ chối chạy nếu thiếu/sai khoá. |

Xem `.env.example`. Frontend: `VITE_SIGN_IN_PATH` để 401 đá về trang đăng nhập của cổng.

## 7. Cấp / gỡ quyền

**Thứ tự:** cấp user → đăng ký project → thêm user vào project.

1. **Admin đầu tiên** — đặt `AUTH_BOOTSTRAP_ADMINS=you@cty.com` (không cần DB),
   hoặc seed khi deploy: `pnpm seed:admin` (idempotent, SAU `pnpm db:migrate`).
2. **Cấp user** — màn hình **Users** (`POST /api/admin/users`): email + role toàn
   cục (`ADMIN`/`MEMBER`).
3. **Đăng ký tenant** — màn hình **Projects** (`PUT /api/admin/projects/:key`),
   kèm kết nối Jira riêng nếu có (`PUT .../:key/jira`, kiểm bằng `POST .../:key/jira/test`).
4. **Thêm thành viên** — `PUT /api/admin/projects/:key/members` với
   `{userId, role: PM|VIEWER}`. User chưa cấp ở bước 2 sẽ bị chặn
   `400 USER_NOT_PROVISIONED`.

**Gỡ quyền:** `DELETE /api/admin/projects/:key/members/:userId` (rời một dự án)
hoặc `DELETE /api/admin/users/:userId` (gỡ hẳn — membership rơi theo CASCADE).

## 8. Bảo mật

- API **không** expose ra Internet — chỉ nghe từ cổng (`HOST=127.0.0.1` hoặc
  network policy nội bộ).
- Cổng **xoá** mọi `x-user-*` của client trước khi đặt của mình.
- Quyền luôn từ DB, không từ header; mọi kiểm tra đi qua guard tập trung
  (`project-scope.ts`) với luật 404-thay-vì-403.
- Jira API token của tenant là **write-only**: nhận vào thì mã hoá rồi lưu,
  không log, không bao giờ trả ra (chỉ cờ `hasJiraToken`).
- Secret (`client_secret`, `cookie_secret`, `APP_ENCRYPTION_KEY`) từ secret
  manager, **không commit**.

## 9. Chạy local (không có cổng)

Ở máy dev không có cổng SSO: **mọi** endpoint đều cần principal, nên thiếu header
danh tính là `401 UNAUTHENTICATED` — kể cả khi đã đặt `AUTH_BOOTSTRAP_ADMINS`,
vì biến đó chỉ ánh xạ *danh tính → ADMIN* chứ **không tự tạo ra danh tính**.

### Cách nhanh nhất — dùng app qua trình duyệt (`pnpm dev`)

Đặt **hai** biến rồi chạy dev; Vite dev proxy sẽ đóng vai cổng, tự chèn
`x-user-id` vào mọi request `/api`:

```bash
# admin@test.test là admin mồi (phía API) VÀ danh tính Vite chèn vào (phía web).
AUTH_BOOTSTRAP_ADMINS=admin@test.test VITE_DEV_USER=admin@test.test pnpm dev
```

- `AUTH_BOOTSTRAP_ADMINS` — API đọc; email này luôn là ADMIN.
- `VITE_DEV_USER` — **web/Vite** đọc; Vite chèn `x-user-id: <email>` vào request
  `/api` khi dev (xem `apps/web/vite.config.ts`). Đổi header qua
  `VITE_DEV_IDENTITY_HEADER` nếu cần. **Chỉ tác dụng dưới `vite dev`** — bản build
  production phục vụ sau cổng thật, không bao giờ dùng shim này.

Hai email phải **giống nhau** thì tài khoản Vite chèn mới khớp admin mồi. Đặt cả
hai ở `.env` ở gốc repo cũng được (xem `.env.example`); shell luôn thắng `.env`.

### Kiểm bằng `curl` (không qua trình duyệt)

Bỏ qua cổng và Vite, gọi thẳng API kèm header tay:

```bash
curl -X POST http://localhost:3000/api/projects/PAY/epics \
  -H 'content-type: application/json' \
  -H 'x-user-id: admin@test.test' \
  -d '{"keys":["PAY-1"],"timezone":"Asia/Ho_Chi_Minh","calendarId":"VN_STANDARD"}'
```

Xem thêm [ONBOARDING.md](./ONBOARDING.md).
