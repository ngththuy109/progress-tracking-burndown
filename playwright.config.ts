import { defineConfig } from '@playwright/test';

/**
 * E2E chạy trên app web.
 *
 * Cờ `--pass-with-no-tests` của T-01 ĐÃ ĐƯỢC GỠ ở `package.json` khi T-20 thêm
 * `smoke.spec.ts`. Giữ lại nó nghĩa là sau này mọi spec biến mất mà CI vẫn
 * xanh — không ai biết.
 */
/**
 * Cổng riêng của E2E, KHÁC cổng 5173 mà `pnpm dev` dùng.
 *
 * Tách ra vì hai lý do: chạy E2E không phải tắt dev server đang mở, và không
 * đụng vào cổng mặc định của Vite mà mọi dự án khác trên máy đều dùng.
 */
const E2E_URL = 'http://localhost:5199';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: E2E_URL,
    trace: 'on-first-retry',
  },

  /**
   * Playwright tự bật app web.
   *
   * Không có khối này thì `pnpm e2e` chỉ chạy khi có người nhớ mở `pnpm dev`
   * trước ở một cửa sổ khác — quên là toàn bộ spec đỏ với lỗi "không kết nối
   * được", chẳng liên quan gì tới thứ đang kiểm.
   *
   * Spec KHÔNG cần máy chủ API: mỗi spec tự chặn `/api/**` bằng `page.route`.
   */
  webServer: {
    // Cổng RIÊNG cho E2E, không phải 5173 của `pnpm dev`. Lý do ở ghi chú trên.
    command: 'pnpm --filter @app/web dev:e2e',
    url: E2E_URL,

    // CẠM BẪY ĐÃ DÍNH MỘT LẦN: để `reuseExistingServer: true` thì Playwright
    // thấy cổng đang có người nghe là dùng luôn, KHÔNG kiểm tra đó có phải app
    // của mình không. Lần đầu chạy card T-20, cổng 5173 đang là một dự án khác
    // của lập trình viên; cả 7 spec đỏ với thông báo "không tìm thấy phần tử",
    // trong khi lỗi thật là đang test nhầm app người khác. Luôn tự bật máy chủ.
    reuseExistingServer: false,

    timeout: 120_000,
    stdout: 'pipe',
  },
});
