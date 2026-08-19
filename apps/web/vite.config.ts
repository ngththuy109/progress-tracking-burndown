import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

/**
 * Gốc repo. `.env` nằm ở GỐC (xem ONBOARDING.md §2: `cp .env.example .env`), chứ
 * không phải cạnh file này trong `apps/web`. `loadEnv` mặc định đọc cạnh
 * vite.config, nên phải trỏ nó về gốc để lấy được `VITE_DEV_USER` / `VITE_API_TARGET`.
 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Cổng khi lập trình viên chạy `pnpm dev`.
 *
 * DÙNG CHUNG 8080 với máy chủ web đã build (`WEB_PREVIEW_PORT`): web app luôn ở
 * `:8080` dù đang chạy dev server (HMR) hay bản build tĩnh — hai chế độ chạy LẦN
 * LƯỢT chứ không song song, nên chung cổng cho dễ nhớ. Lỡ chạy cả hai cùng lúc
 * thì `strictPort` báo lỗi ngay. CỐ Ý không dùng 5173 (cổng mặc định của Vite mà
 * mọi dự án khác đều nhắm vào) — trùng nó là mở trình duyệt ra thấy app dự án
 * khác, mất khá lâu mới nhận ra.
 */
export const WEB_DEV_PORT = 8080;

/**
 * Cổng của MÁY CHỦ WEB đã build — `vite preview` phục vụ bản tĩnh trong `dist/`
 * sau khi `vite build` (xem `docs/WEB-SERVER.md`). GIỐNG `WEB_DEV_PORT` (8080):
 * dev server nóng (HMR) và bản build tĩnh là hai cách phục vụ CÙNG một app, chạy
 * lần lượt chứ không song song, nên dùng chung cổng cho dễ nhớ ("app luôn ở :8080").
 *
 * Mặc định 8080; đổi qua env `WEB_PORT`. CỐ Ý KHÔNG dùng chung biến `PORT` với
 * API (mặc định 3000 — xem `apps/api/src/server.ts`): API và web CÓ thể chạy song
 * song, xài chung một biến sẽ tranh cổng.
 */
export const WEB_PREVIEW_PORT = 8080;

/**
 * Cổng cho máy chủ web đã build, đọc từ env `WEB_PORT`.
 *
 * Lùi về 8080 khi biến trống HOẶC không phải số cổng hợp lệ (1–65535) — thà
 * chạy trên cổng mặc định còn hơn để `NaN` lọt xuống `vite preview` rồi chết
 * bằng một lỗi khó hiểu ở tận trong Vite.
 */
export function resolveWebPort(env: Record<string, string | undefined>): number {
  const raw = Number(env['WEB_PORT']);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : WEB_PREVIEW_PORT;
}

/**
 * Danh sách host được phép cho MÁY CHỦ WEB đã build (`vite preview`).
 *
 * Từ Vite 6, máy chủ preview CHẶN mọi request có header `Host` là TÊN MÁY / TÊN
 * MIỀN không nằm trong danh sách cho phép — trả **403 "Blocked request. This
 * host is not allowed"** (lá chắn chống DNS-rebinding). Địa chỉ IP (v4/v6) và
 * `localhost` thì Vite LUÔN cho qua sẵn; nhưng mở bằng TÊN MÁY (vd
 * `http://vm:8080`) hay TÊN MIỀN (`http://app.cty.com:8080`) từ máy khác sẽ bị
 * 403 — nhìn HỆT như "chỉ localhost mới vào được", dù đã bind `0.0.0.0`.
 *
 * Máy chủ này CỐ Ý phơi ra mạng (bind `0.0.0.0`, xem `host` ở khối `preview`) để
 * máy khác / Docker truy cập, nên **mặc định cho phép MỌI host** (`true`): bind
 * mọi giao diện mạng rồi lại chặn theo tên host là tự mâu thuẫn. Siết lại khi
 * cần (vd phơi thẳng ra mạng không tin cậy) bằng `WEB_ALLOWED_HOSTS` — danh sách
 * tên host ngăn cách bởi dấu phẩy:
 *
 *   WEB_ALLOWED_HOSTS=app.cty.com,vm
 *
 * Tiền tố `.` khớp cả subdomain: `.cty.com` cho phép `a.cty.com`, `b.cty.com`…
 * (quy ước của Vite). Bỏ trống — hoặc chỉ toàn dấu phẩy rỗng — thì quay về
 * `true` (mở mọi host) thay vì `[]` (chặn sạch, hồi sinh đúng con bug này).
 */
export function resolveAllowedHosts(
  env: Record<string, string | undefined>,
): true | string[] {
  const raw = env['WEB_ALLOWED_HOSTS']?.trim();
  if (!raw) return true;
  const hosts = raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : true;
}

/**
 * Host mà DEV SERVER (`pnpm dev`, cổng 8080) lắng nghe.
 *
 * TRƯỚC ĐÂY khối `server` KHÔNG đặt `host`, nên Vite lùi về mặc định CHỈ
 * `localhost`: máy khác (điện thoại cùng LAN, VM, container, một máy khác trong
 * mạng) mở `http://<IP-máy-này>:8080` là KHÔNG vào được — nhìn hệt như "chỉ
 * localhost mới truy cập được" dù `pnpm dev` vẫn chạy. Đúng con bug "không vào
 * được qua IP".
 *
 * GIỜ mặc định `0.0.0.0` (mọi giao diện mạng) cho ĐỒNG BỘ với API và với máy chủ
 * web đã build (khối `preview`) — cả hai vốn đã bind `0.0.0.0`. Thu hẹp về chỉ
 * máy này bằng `WEB_DEV_HOST=127.0.0.1`.
 *
 * ⚠️ BẢO MẬT: KHÁC `preview`, dev server có thể CHÈN header danh tính khi đặt
 * `VITE_DEV_USER` (đóng vai cổng SSO ở local — xem `devIdentity`). Mở dev server
 * ra `0.0.0.0` mà ĐANG bật `VITE_DEV_USER` nghĩa là MÁY KHÁC trong mạng gọi `/api`
 * cũng được chèn danh tính đó → GHI được như người dùng đó. Trên mạng không tin
 * cậy hãy đặt `WEB_DEV_HOST=127.0.0.1`; cảnh báo được in khi cả hai cùng bật.
 */
export function resolveDevHost(env: Record<string, string | undefined>): string {
  return env['WEB_DEV_HOST']?.trim() || '0.0.0.0';
}

/**
 * Host chỉ MÁY NÀY gọi được (loopback). Dùng để quyết định có cần in cảnh báo
 * "phơi dev server + đang chèn danh tính" hay không: chỉ loopback thì an toàn,
 * mọi host khác (`0.0.0.0`, IP LAN cụ thể…) đều với tới được từ máy khác.
 */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** Header danh tính mặc định — KHỚP `AUTH_IDENTITY_HEADER` mặc định của API. */
const DEFAULT_IDENTITY_HEADER = 'x-user-id';

/**
 * Danh tính giả cho DEV — Vite tự chèn header danh tính khi chạy `pnpm dev`.
 *
 * Ở production, xác thực là ĐĂNG NHẬP LDAP trong app (xem `docs/AUTH.md`). Ở local
 * (chưa dựng LDAP) thì trình duyệt → Vite → API không mang danh tính nào, nên API
 * không phân giải được principal và mọi thao tác GHI (thêm Epic, sửa cấu hình,
 * quản lý người dùng) trả **401 UNAUTHENTICATED**.
 *
 * Đặt `VITE_DEV_USER=you@cty.com` để Vite tự chèn header danh tính vào request
 * `/api` khi dev. Kết hợp với `AUTH_BOOTSTRAP_ADMINS=you@cty.com` (phía API) thì
 * `you@cty.com` thành ADMIN và thêm được Epic. KHÔNG đặt biến này thì Vite không
 * chèn gì — giữ nguyên hành vi cũ.
 *
 * Đổi tên header qua `VITE_DEV_IDENTITY_HEADER` (hiếm khi cần).
 *
 * VÌ SAO ĐẶT Ở VITE CHỨ KHÔNG PHẢI API: model bảo mật của API là "chỉ tin DANH
 * TÍNH do cổng đặt, không bao giờ tự đăng nhập". Nhét một lối tắt auth vào API sẽ
 * phá đúng nguyên tắc đó và có nguy cơ lọt lên production. Vite dev proxy CHÍNH
 * LÀ cổng khi chạy `pnpm dev`, nên đây mới là chỗ đúng — và nó chỉ tồn tại ở dev
 * server, không bao giờ đi vào bản build tĩnh phục vụ sau cổng thật.
 */
export function devIdentity(
  env: Record<string, string | undefined>,
): { header: string; user: string } | null {
  const user = env['VITE_DEV_USER']?.trim();
  if (!user) return null;
  const header = (env['VITE_DEV_IDENTITY_HEADER']?.trim() || DEFAULT_IDENTITY_HEADER).toLowerCase();
  return { header, user };
}

/**
 * Base URL Jira cho link "mở ticket" ở ô Signboard — trình duyệt đọc qua
 * `import.meta.env.VITE_JIRA_BASE_URL` (xem `apps/web/src/api/jira.ts`).
 *
 * Ưu tiên `VITE_JIRA_BASE_URL` để, khi hiếm hoi cần, trỏ trình duyệt sang site
 * KHÁC với server. Bỏ trống thì LÙI VỀ `JIRA_BASE_URL` — biến server BẮT BUỘC
 * vốn đã có. Nhờ vậy không phải khai HAI lần cùng một URL: chỉ đặt `JIRA_BASE_URL`
 * như `.env.example` là ô task đã bấm-thẳng-sang-Jira được, không còn kẹt ở nút
 * "Copy key". Đặt `VITE_JIRA_BASE_URL=""` (rỗng tường minh) để TẮT link — chuỗi
 * rỗng KHÔNG nullish nên không rơi xuống `JIRA_BASE_URL`. Chỉ lộ đúng base URL
 * công khai (KHÔNG phải token) — URL này vốn nằm trong mọi link `/browse/…` rồi.
 */
export function resolveJiraBaseUrl(env: Record<string, string | undefined>): string {
  return (env['VITE_JIRA_BASE_URL'] ?? env['JIRA_BASE_URL'] ?? '').trim();
}

/** Cấu hình proxy `/api`, kèm chèn danh tính dev nếu có. */
function apiProxy(
  target: string,
  identity: { header: string; user: string } | null,
): ProxyOptions {
  const base: ProxyOptions = { target, changeOrigin: true };
  if (identity === null) return base;

  return {
    ...base,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        // GHI ĐÈ (setHeader thay chứ không thêm) — mirror việc cổng thật xoá mọi
        // header `x-user-*` client gửi rồi đặt của mình. Nhờ vậy client trong dev
        // không tự xưng được danh tính khác.
        proxyReq.setHeader(identity.header, identity.user);
        proxyReq.removeHeader('x-user-role');
        proxyReq.removeHeader('x-user-projects');
      });
    },
  };
}

/**
 * Bảng proxy dùng CHUNG cho dev server (`pnpm dev`) và preview (bản build).
 *
 * PHẢI có `/auth` BÊN CẠNH `/api`: đăng nhập LDAP in-app đi qua
 * `POST /auth/login` và `POST /auth/logout`, mà server phục vụ chúng ở GỐC —
 * NGOÀI tiền tố `/api` (chúng là điểm vào của trình duyệt, không phải endpoint
 * dữ liệu; xem `packages/shared/src/api-config.ts` và `src/api/use-auth-mode.ts`,
 * nơi `authRootClient` gọi cùng gốc trang). Chỉ proxy `/api` thì Vite tự NUỐT
 * `/auth/login` rồi trả **404** — form đăng nhập báo "Sign-in failed" DÙ mật khẩu
 * đúng, vì login POST chưa bao giờ tới API (log API không hề có `POST /auth/login`).
 *
 * Danh tính dev CHỈ chèn vào `/api`; `/auth` luôn truyền `null` — đó chính là
 * endpoint đăng nhập, danh tính do LDAP quyết định (username/password trong body),
 * không phải header `x-user-id`.
 */
export function buildProxy(
  apiTarget: string,
  identity: { header: string; user: string } | null,
): Record<string, ProxyOptions> {
  return {
    '/api': apiProxy(apiTarget, identity),
    '/auth': apiProxy(apiTarget, null),
  };
}

export default defineConfig(({ command, mode }) => {
  // Gộp `.env` ở GỐC repo với biến shell; shell THẮNG. '' = nạp MỌI biến (không
  // chỉ tiền tố `VITE_`) để `VITE_API_TARGET`/`VITE_DEV_USER` đọc được dù đặt ở
  // `.env` hay export ngoài shell (`VITE_DEV_USER=… pnpm dev`).
  const env: Record<string, string | undefined> = {
    ...loadEnv(mode, REPO_ROOT, ''),
    ...process.env,
  };

  const apiTarget = env['VITE_API_TARGET'] ?? 'http://localhost:3000';

  // Đẩy base URL Jira vào env CLIENT để trình duyệt dựng được link "mở ticket"
  // trên ô Signboard. Ghi vào `process.env` TRƯỚC khi Vite phân giải env client:
  // Vite gom các biến tiền tố `VITE_` từ `process.env`, nên đây là đường chắc
  // chắn để giá trị lọt vào `import.meta.env` — KỂ CẢ khi `.env` nằm ở GỐC repo
  // (không cùng thư mục với config, nên `envDir` mặc định không đọc tới). Mặc
  // định mượn `JIRA_BASE_URL`; không có URL nào thì KHÔNG đặt gì — ô lùi về chỉ
  // copy được mã ticket như cũ.
  const jiraBaseUrl = resolveJiraBaseUrl(env);
  if (jiraBaseUrl !== '') process.env['VITE_JIRA_BASE_URL'] = jiraBaseUrl;

  // Shim danh tính CHỈ cho DEV SERVER (`vite` / `pnpm dev`) — KHÔNG cho
  // `vite preview` (máy chủ web đã build) và KHÔNG cho `vite build`.
  //
  // Cả dev lẫn preview đều là `command === 'serve'`; chúng khác nhau ở `mode`
  // (dev = 'development', preview = 'production'). Dựa vào `mode` để bản build
  // tĩnh phục vụ trên cổng 8080 KHÔNG BAO GIỜ tự chèn danh tính giả — bản đó
  // đứng sau cổng SSO thật, chèn danh tính ở đây là mở toang một lối ghi.
  const isDevServer = command === 'serve' && mode !== 'production';
  const identity = isDevServer ? devIdentity(env) : null;

  // Host của dev server (mặc định 0.0.0.0 để vào được qua IP). Tính sẵn ở đây để
  // vừa dùng cho khối `server` bên dưới, vừa quyết định có cần cảnh báo bảo mật.
  const devHost = resolveDevHost(env);

  if (identity !== null) {
    // In MỘT dòng để lập trình viên THẤY shim đang bật — không hiểu nhầm là auth
    // thật/production.
    console.log(
      `[vite] DEV auth: chèn "${identity.header}: ${identity.user}" vào request /api ` +
        `(CHỈ dev — xem docs/AUTH.md §9). ` +
        `Cần AUTH_BOOTSTRAP_ADMINS=${identity.user} phía API để danh tính này thành ADMIN.`,
    );

    // ⚠️ Dev server nghe ngoài loopback (0.0.0.0 / IP LAN) VÀ đang chèn danh tính
    // = lối GHI mở cho cả mạng: máy khác gọi /api cũng mang danh tính này. In cảnh
    // báo TO để không vô tình để hở trên mạng lạ (xem `resolveDevHost`).
    if (!isLoopbackHost(devHost)) {
      console.warn(
        `[vite] ⚠️  Dev server đang nghe "${devHost}" (không chỉ localhost) VÀ đang chèn ` +
          `danh tính "${identity.user}" vào /api. MÁY KHÁC trong mạng gọi tới cũng được chèn ` +
          `danh tính này → GHI được như "${identity.user}". Mạng không tin cậy thì đặt ` +
          `WEB_DEV_HOST=127.0.0.1 để CHỈ máy này truy cập.`,
      );
    }
  }

  return {
    plugins: [react()],

    resolve: {
      alias: {
        // Trỏ thẳng vào mã nguồn `packages/shared`, không qua bản build. Nhờ vậy
        // sửa schema ở shared là app web thấy ngay, không phải build lại.
        '@app/shared': fileURLToPath(
          new URL('../../packages/shared/src/index.ts', import.meta.url),
        ),
      },
    },

    server: {
      port: WEB_DEV_PORT,

      // Nghe trên mọi giao diện mạng (mặc định `0.0.0.0`) để máy khác / điện thoại
      // cùng LAN / VM / container mở được qua IP — ĐỒNG BỘ với API và máy chủ
      // preview (đều bind `0.0.0.0`). Trước đây bỏ trống → Vite chỉ nghe localhost,
      // đúng triệu chứng "không vào được qua IP". Thu hẹp về máy này bằng
      // `WEB_DEV_HOST=127.0.0.1`. ⚠️ Khi bật `VITE_DEV_USER`, mở host = mở luôn lối
      // ghi theo danh tính đó cho cả mạng — xem `resolveDevHost` + cảnh báo ở trên.
      host: devHost,

      // CẠM BẪY: mặc định Vite thấy cổng 5173 bận thì tự nhảy sang 5174 và chỉ in
      // một dòng chữ nhỏ. Playwright vẫn mở 5173, gặp trang trắng, rồi báo lỗi ở
      // một chỗ chẳng liên quan gì. `strictPort` biến nó thành lỗi ngay lập tức.
      strictPort: true,

      // Proxy `/api` (VÀ `/auth` cho đăng nhập LDAP) sang API cùng gốc trang —
      // không dính CORS, mã nguồn không cần biết API ở cổng nào. Khi có
      // `VITE_DEV_USER`, riêng `/api` được chèn header danh tính (đóng vai cổng
      // SSO ở local); `/auth` thì KHÔNG — xem `buildProxy`.
      proxy: buildProxy(apiTarget, identity),
    },

    // Máy chủ web cho bản ĐÃ BUILD (`vite preview`, tức `pnpm web:start` /
    // `pnpm web:serve`). Xem `docs/WEB-SERVER.md`.
    preview: {
      // Mặc định 8080, đổi qua env `WEB_PORT`.
      port: resolveWebPort(env),

      // Nghe trên mọi giao diện mạng để container/Docker/máy khác truy cập được
      // (giống API bind `0.0.0.0`). Thu hẹp về máy này bằng `WEB_HOST=127.0.0.1`.
      host: env['WEB_HOST']?.trim() || '0.0.0.0',

      // Cho phép mở bằng TÊN MÁY / TÊN MIỀN, không chỉ IP. Vite preview mặc định
      // trả 403 "Blocked request" cho Host lạ (chống DNS-rebinding); bind
      // `0.0.0.0` mà không mở host thì máy khác gọi bằng tên vẫn bị chặn — đúng
      // triệu chứng "chỉ localhost vào được". Mặc định mở mọi host; siết bằng
      // `WEB_ALLOWED_HOSTS`. Xem `resolveAllowedHosts` + docs/WEB-SERVER.md §3.
      allowedHosts: resolveAllowedHosts(env),

      // Như dev: cổng bận thì BÁO LỖI NGAY thay vì âm thầm nhảy sang cổng khác —
      // nếu không, hướng dẫn ghi 8080 mà thực tế lại chạy 8081, rất khó lần ra.
      strictPort: true,

      // Như dev nhưng truyền `null` → KHÔNG chèn danh tính: bản build phục vụ sau
      // cổng SSO thật, thao tác GHI vẫn phải qua cổng đó (đọc thì chạy ngay).
      // `/auth` vẫn được proxy để đăng nhập LDAP chạy khi chạy thử bản build.
      // (Chi tiết mô hình bảo mật: docs/AUTH.md.)
      proxy: buildProxy(apiTarget, null),
    },

    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
