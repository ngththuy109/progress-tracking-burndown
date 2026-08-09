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
 * CỐ Ý không dùng 5173 — đó là cổng mặc định của Vite nên mọi dự án khác trên
 * máy đều nhắm vào nó. Trùng cổng là mở trình duyệt ra thấy app của dự án khác,
 * và mất khá lâu mới nhận ra.
 */
export const WEB_DEV_PORT = 5180;

/** Header danh tính mặc định — KHỚP `AUTH_IDENTITY_HEADER` mặc định của API. */
const DEFAULT_IDENTITY_HEADER = 'x-user-id';

/**
 * Danh tính giả cho DEV — Vite đóng vai cổng SSO khi chạy `pnpm dev`.
 *
 * Ở môi trường thật, một auth proxy (nginx/oauth2-proxy — xem `config/auth-proxy/`
 * và `docs/AUTH.md`) đứng trước API và đặt header `x-user-id` = email đã xác
 * thực cho MỌI request. Ở local KHÔNG có cổng đó: trình duyệt → Vite → API không
 * mang danh tính nào, nên API không phân giải được principal và mọi thao tác GHI
 * (thêm Epic, sửa cấu hình, quản lý người dùng) trả **401 UNAUTHENTICATED**.
 *
 * Đặt `VITE_DEV_USER=you@cty.com` để Vite tự chèn header danh tính vào request
 * `/api` khi dev — đúng như cổng làm ở production. Kết hợp với
 * `AUTH_BOOTSTRAP_ADMINS=you@cty.com` (phía API) thì `you@cty.com` thành ADMIN và
 * thêm được Epic. KHÔNG đặt biến này thì Vite không chèn gì — giữ nguyên hành vi cũ.
 *
 * Đổi tên header cho khớp cổng khác qua `VITE_DEV_IDENTITY_HEADER` (hiếm khi cần).
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

export default defineConfig(({ command, mode }) => {
  // Gộp `.env` ở GỐC repo với biến shell; shell THẮNG. '' = nạp MỌI biến (không
  // chỉ tiền tố `VITE_`) để `VITE_API_TARGET`/`VITE_DEV_USER` đọc được dù đặt ở
  // `.env` hay export ngoài shell (`VITE_DEV_USER=… pnpm dev`).
  const env: Record<string, string | undefined> = {
    ...loadEnv(mode, REPO_ROOT, ''),
    ...process.env,
  };

  const apiTarget = env['VITE_API_TARGET'] ?? 'http://localhost:3000';

  // Shim danh tính CHỈ khi chạy dev server (`vite`/`vite dev`), KHÔNG khi build.
  // `vite build` bỏ qua `server.proxy` sẵn, nhưng chặn ở đây cho tường minh.
  const identity = command === 'serve' ? devIdentity(env) : null;

  if (identity !== null) {
    // In MỘT dòng để lập trình viên THẤY shim đang bật — không hiểu nhầm là auth
    // thật/production.
    console.log(
      `[vite] DEV auth: chèn "${identity.header}: ${identity.user}" vào request /api ` +
        `(CHỈ dev — xem docs/AUTH.md §9). ` +
        `Cần AUTH_BOOTSTRAP_ADMINS=${identity.user} phía API để danh tính này thành ADMIN.`,
    );
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

      // CẠM BẪY: mặc định Vite thấy cổng 5173 bận thì tự nhảy sang 5174 và chỉ in
      // một dòng chữ nhỏ. Playwright vẫn mở 5173, gặp trang trắng, rồi báo lỗi ở
      // một chỗ chẳng liên quan gì. `strictPort` biến nó thành lỗi ngay lập tức.
      strictPort: true,

      proxy: {
        // Nhờ proxy này mà frontend gọi `/api/...` cùng gốc — không dính CORS,
        // và mã nguồn không cần biết API nằm ở cổng nào. Khi có `VITE_DEV_USER`,
        // proxy còn đặt luôn header danh tính (đóng vai cổng SSO ở local).
        '/api': apiProxy(apiTarget, identity),
      },
    },

    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
