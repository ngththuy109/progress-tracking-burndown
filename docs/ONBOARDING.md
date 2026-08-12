# Bắt đầu với dự án

**Ai đọc file này:** lập trình viên vừa vào dự án, ngày đầu tiên.

**Mục tiêu:** từ máy trắng tới `pnpm dev` chạy được, trong khoảng một giờ.

---

## 1. Cài đặt

| Cần gì | Phiên bản | Kiểm bằng |
|---|---|---|
| Node.js | ≥ 20.11 | `node -v` |
| pnpm | 9.x | `pnpm -v` |
| PostgreSQL | ≥ 15 | `psql --version` |
| Redis | ≥ 7 | `redis-server --version` |

```bash
git clone <repo>
cd ProgressTracking
pnpm install
npx playwright install chromium     # trình duyệt cho test E2E, ~300MB
```

> **Gọn hơn — một lệnh:** `pnpm install:all` = `pnpm install && pnpm db:generate` (link deps + build
> re2 native + sinh Prisma Client). Trên **Claude Code on the web**, hook `.claude/hooks/session-start.sh`
> tự chạy nó lúc mở phiên nên container clone mới đã sẵn sàng — không phải cài tay.
>
> **Đừng gộp `prisma generate` vào `postinstall`:** prisma generate tự chạy `pnpm add @prisma/client`
> → lại kích hoạt `postinstall` → **đệ quy vô hạn**. Vì vậy setup là hai bước tuần tự.

> **Tài liệu không bị lệch:** hook `PostToolUse` (`.claude/hooks/docs-reminder.mjs`) chạy sau khi
> Claude Code sửa một file mã nguồn và chèn lời nhắc (một lần / file / phiên) để rà soát xem
> `README.md`, `docs/` hay `docs/tasks/` có cần cập nhật cho khớp không. Nó chỉ **nhắc** — không chặn
> thao tác, không tự sửa file — và bỏ qua tài liệu, test, file cấu hình. Tắt bằng menu `/hooks` hoặc
> xoá mục `PostToolUse` trong `.claude/settings.json`.

## 2. Biến môi trường

```bash
cp .env.example .env
```

Hai biến bắt buộc; thiếu cái nào thì worker báo **một lần** đủ cả, không bắt chạy đi chạy lại:

| Biến | Lấy ở đâu |
|---|---|
| `DATABASE_URL` | PostgreSQL cục bộ, ví dụ `postgres://postgres:postgres@localhost:5432/burndown` |
| `REDIS_URL` | `redis://localhost:6379` |

**Kết nối Jira (multi-tenant).** Từ bản multi-tenant, **mỗi dự án tự khai kết
nối Jira riêng** ở màn hình *Admin → Projects* (hỗ trợ nhiều Jira site khác
nhau; token lưu trong DB, mã hóa bằng `APP_ENCRYPTION_KEY`). Ba biến
`JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` giờ là **fallback tùy chọn**
cho những dự án *chưa* khai kết nối riêng — khai thì phải đủ cả ba
(all-or-nothing), hệ thống 1 site kiểu cũ chạy tiếp không cần làm gì. Boot
**không còn** kiểm tra Jira; kiểm tra kết nối bằng nút **Test connection**
trong màn hình Admin.

| Biến (tùy chọn) | Lấy ở đâu |
|---|---|
| `JIRA_BASE_URL` | `https://<công-ty>.atlassian.net` |
| `JIRA_EMAIL` | Email tài khoản Jira |
| `JIRA_API_TOKEN` | https://id.atlassian.com/manage-profile/security/api-tokens |
| `APP_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` — chỉ bắt buộc trước khi nhập token riêng cho một dự án |

> **Chỉ cần Jira thật khi muốn đồng bộ dữ liệu thật.** Toàn bộ test chạy được mà không cần Jira, PostgreSQL hay Redis — xem mục 5.

> **Ô Signboard bấm thẳng sang Jira.** Rê chuột vào một ô task sẽ hiện thẻ có **link** mở ticket trên Jira (tab mới) và nút **copy** link. Link này mặc định dùng luôn `JIRA_BASE_URL` ở trên — **không cần khai lại**. Muốn trình duyệt trỏ sang site *khác* server thì đặt `VITE_JIRA_BASE_URL` (hiếm khi cần); đặt `VITE_JIRA_BASE_URL=""` để tắt link (ô lùi về chỉ copy được *mã* ticket).

> **Xác thực khi chạy local.** Ở môi trường triển khai, app dùng **SSO qua một cổng** đặt header danh tính `x-user-id` (xem [AUTH.md](./AUTH.md)). Ở local **không có cổng**: các API *đọc* vẫn chạy, nhưng thao tác *ghi* (thêm Epic, sửa cấu hình, quản lý người dùng) cần header danh tính — thiếu là **401** (đặt mỗi `AUTH_BOOTSTRAP_ADMINS` chưa đủ: nó chỉ ánh xạ *danh tính → ADMIN*, không tự tạo danh tính). Dùng app qua **trình duyệt**: chạy `AUTH_BOOTSTRAP_ADMINS=you@cty.com VITE_DEV_USER=you@cty.com pnpm dev` — Vite dev proxy tự chèn `x-user-id` (đóng vai cổng ở local). Gọi bằng **`curl`**: thêm `-H 'x-user-id: you@cty.com'`. Chi tiết ở [AUTH.md §9](./AUTH.md). Các biến `AUTH_*` đều tùy chọn — mặc định người đã xác thực nhưng chưa cấp quyền là `VIEWER`.

## 3. Dựng database

```bash
pnpm db:migrate          # áp migration (chạy SQL trực tiếp qua driver pg)
pnpm db:generate         # sinh Prisma Client (query compiler WASM)
pnpm db:seed             # (khuyến nghị) nạp bộ Mặc định: nhận diện Phase + 5 cột Signboard + lịch làm việc
```

**Ba cách để có bộ Mặc định — theo THỨ TỰ ƯU TIÊN.** Migration chỉ TẠO BẢNG,
không nạp dữ liệu. Cả ba đều **idempotent** (chạy lại vô hại); cách (1) và (2)
cho ra CÙNG một bộ (6 Phase + 29 luật khớp Việt/Nhật/Anh + 5 cột Signboard):

| # | Cách | Khi nào dùng |
|---|---|---|
| **1 — khuyến nghị** | `pnpm db:seed` | Có Node toolchain (trường hợp mặc định) |
| **2** | `psql "$DATABASE_URL" -f tools/db/seed-default-config.sql` | Chỉ có `psql`, không Node (DBA, Docker init) |
| **3** | Bỏ qua — tự định nghĩa trong giao diện | Muốn bắt đầu từ bộ trống |

- **(1) mạnh nhất:** dùng lại đúng đường ghi `saveNewVersion` đã test + type-safe
  của app, nên đổi schema là lỗi lộ ngay lúc biên dịch và ít mảnh lệch nhất. Chỉ
  tạo bộ Mặc định khi chưa có; lịch làm việc dùng upsert.
- **(2):** file `.sql` **được sinh** từ `DEFAULT_PHASE_CONFIG` (một nguồn sự thật,
  có test giữ khớp từng byte). Sửa hằng số thì chạy `pnpm db:seed:sql:gen` để sinh
  lại. Chỉ đứng sau (1) khi schema tiến hoá — bù lại chạy được **không cần Node**.
- **(3):** không thật sự là seed — màn hình **Phase settings** / **Signboard
  columns** mở với bộ RỖNG (`GET /api/config/phase` trả 200, `globalVersion: 0`);
  bạn thêm Phase/cột rồi Lưu → tạo bản Mặc định v1.

> **Sau khi seed, còn một bước dữ liệu nữa: import ngày nghỉ (T-36).** Seed cố
> ý KHÔNG kèm ngày lễ (danh sách đổi theo năm, cần người thật xác nhận lễ bù).
> Đăng nhập ADMIN → màn hình **Days off** → import ngày lễ năm hiện tại cho CẢ
> hai lịch: `VN_STANDARD` (phía làm) và `JP_STANDARD` (phía khách hàng review).
> Bỏ qua bước này thì đường Kế hoạch cháy đều qua tuần nghỉ Tết (E-14) và biểu
> đồ sẽ hiện cảnh báo 📅. Quy trình chi tiết: RUNBOOK mục "quy trình 7".

> **Không tải engine của Prisma — chạy được cả khi máy chặn mạng.** Bình thường Prisma tải hai
> binary Rust (query engine + schema engine) từ CDN `binaries.prisma.sh` lúc `pnpm install` và
> `prisma generate`; máy chặn mạng ra ngoài sẽ chết ở cả hai bước. Dự án đã cấu hình để **không cần
> binary native nào**:
>
> - `packages/db/prisma/schema.prisma` đặt `engineType = "client"` → client dùng query compiler WASM
>   đóng gói sẵn trong `@prisma/client`, nối PostgreSQL qua driver adapter `pg` (`packages/db/src/client.ts`).
> - `prisma.config.ts` khai adapter `pg` cho CLI → `prisma generate` bỏ qua bước tải schema engine.
> - `package.json` → `pnpm.neverBuiltDependencies` chặn postinstall của `@prisma/engines` gọi CDN,
>   nên `pnpm install` không kẹt.
> - `pnpm db:migrate` chạy thẳng các file `migration.sql` qua `pg` (`tools/db/apply-migrations.mjs`)
>   thay cho `prisma migrate deploy` (vốn cần schema engine), và vẫn ghi vào bảng `_prisma_migrations`
>   của Prisma nên tương thích ngược.
>
> Đánh đổi duy nhất: KHÔNG dùng `prisma migrate dev` để **tạo** migration mới được nữa (lệnh đó cần
> schema engine). Muốn thêm migration thì tự viết tay: tạo
> `packages/db/prisma/migrations/<timestamp>_<tên>/migration.sql` rồi chạy `pnpm db:migrate`.

## 4. Chạy

```bash
pnpm dev                 # chạy song song api + worker + web
```

| Ứng dụng | Cổng | Ghi chú |
|---|---|---|
| Web | 5180 | **Cố ý không dùng 5173** — đó là cổng mặc định của Vite mà mọi dự án khác đều nhắm vào |
| API | 3000 | |
| E2E | 5199 | Cổng riêng, để chạy test không phải tắt dev server |

> **Muốn chạy bản ĐÃ BUILD (không phải dev server)?** `pnpm web:start` build
> `apps/web` rồi phục vụ bản tĩnh ở **cổng 8080** (đổi qua `WEB_PORT`). Dùng khi
> thử bản production tại chỗ, chạy trong container, hoặc self-host. Chi tiết:
> [WEB-SERVER.md](./WEB-SERVER.md).

## 5. Chạy test

```bash
pnpm test                # toàn bộ (không cần hạ tầng)
pnpm test:engine         # chỉ engine, PHẢI dưới 10 giây
pnpm test:coverage       # độ phủ engine, ngưỡng 90%
pnpm e2e                 # Playwright, tự bật web server
pnpm typecheck && pnpm lint
```

**Vì sao test chạy được mà không cần hạ tầng.** Mọi thứ bên ngoài đi qua **cổng** (interface); tầng service chỉ nhìn thấy cổng, còn bộ chuyển đổi biết Prisma/Redis/Jira thì nằm riêng trong `adapters/`. Test dùng bản giả trong bộ nhớ.

Một test cần PostgreSQL thật thì tự bỏ qua kèm lý do rõ ràng, không giả vờ xanh.

---

## 6. Bốn package và ranh giới giữa chúng

```
packages/shared   ← kiểu dữ liệu + schema zod. KHÔNG phụ thuộc ai.
packages/engine   ← toàn bộ logic nghiệp vụ, THUẦN TÍNH TOÁN.
packages/db       ← Prisma, repository.
packages/jira     ← client gọi Jira, CHỈ ĐỌC.

apps/api          ← REST API. Chỉ điều phối.
apps/worker       ← job nền. Nơi DUY NHẤT gọi Jira.
apps/web          ← giao diện. Chỉ import `shared`.
```

### Hai hàng rào có lint chặn

Đây là phần quan trọng nhất của mục này. Hai luật dưới đây **không phải trang trí**; chúng có test riêng ở [tools/arch-tests](../tools/arch-tests/guardrails.test.ts) kiểm chính hàng rào.

**1. `packages/engine` KHÔNG được import `@app/db` hoặc `@app/jira`.**

Engine chứa logic được khoá bằng 20 golden dataset. Nếu nó phụ thuộc db hay jira thì muốn chạy test phải dựng PostgreSQL và Jira sandbox — bộ test từ vài giây thành vài phút, và **sẽ không ai chạy nó nữa**.

**2. `packages/engine` KHÔNG được đọc đồng hồ.**

Không `new Date()`, không `Date.now()`, không `DateTime.now()`. Hàm cần "hôm nay" phải nhận qua tham số `asOfDate`.

Trạng thái Signboard phụ thuộc hôm nay là ngày nào. Test không đóng băng đồng hồ sẽ **xanh hôm nay và đỏ tuần sau** — loại lỗi tốn thời gian nhất.

### `apps/web` chỉ có một cửa ra ngoài

`apps/web/src/api/` là nơi **duy nhất** được gọi `fetch`. Component nhận dữ liệu qua hook.

Lý do: mọi màn hình đều phải xử lý ba trạng thái giống nhau (đang tải / lỗi / rỗng). Để component tự gọi thì tới màn hình thứ ba mỗi chỗ sẽ xử lý lỗi một kiểu.

---

## 7. Đọc gì trước

| Thứ tự | Tài liệu | Vì sao |
|---|---|---|
| 1 | [PRD](./PRD_Burndown_Engine.md) mục 1 và 2 | Hiểu bài toán trước khi đọc code |
| 2 | [tasks/README.md](./tasks/README.md) | 34 card, sơ đồ phụ thuộc, và **hai mục "Điều rút ra"** |
| 3 | [tasks/CONVENTIONS.md](./tasks/CONVENTIONS.md) | 14 quy ước bắt buộc |
| 4 | [ARCHITECTURE.md](./ARCHITECTURE.md) | Cấu trúc thư mục và quy tắc phụ thuộc |
| 5 | `packages/engine/test/fixtures/GD-01/` | Bộ dữ liệu dễ đọc nhất; hiểu nó là hiểu engine làm gì |

**Đọc kỹ hai mục "Điều rút ra".** Chúng ghi lại những lỗi đã thật sự xảy ra trong dự án này, phần lớn là **lỗi im lặng** — mọi lệnh báo xanh trong khi có thứ đang hỏng.

---

## 8. Quy trình một card

1. Đọc card trong `docs/tasks/`, đọc **cả** `prd_refs` trong phần đầu file.
2. Đổi `status` thành `in_progress`, điền `owner` và `started_at`.
3. **Không đụng file ngoài `touches`.** Cần thêm thì dừng lại, báo, cập nhật card trước.
4. Viết test **trước hoặc song song**, không viết sau.
5. Xong: `status: review`, điền `finished_at`, ghi mục *Đã làm gì* — nêu rõ **chỗ nào làm khác card và vì sao**.
6. Qua checklist **C-14** trong CONVENTIONS.md.

---

## 9. Ba điều dễ vấp trong tuần đầu

1. **`pnpm typecheck` không tự động phủ hết.** Project `noEmit` không nằm trong `tsc --build`, nên `apps/web` và `packages/engine/test/` được gọi riêng trong script `typecheck` của root. Thêm project mới thì phải nối vào đó — nếu không, cả một app không được kiểm dòng nào mà mọi lệnh vẫn xanh.
2. **Cổng E2E là 5199, không phải 5173.** Playwright **luôn tự bật** máy chủ riêng và không bao giờ mượn cổng đang mở — đã từng chạy nhầm trên app của một dự án khác trên cùng máy.
3. **Trong `packages/engine`, mọi giá trị thời lượng là GIÂY.** Chỉ đổi sang giờ ở đúng biên trả về của API. Đổi ở nhiều chỗ thì sẽ có ngày hai chỗ làm tròn khác nhau và tổng không khớp.
