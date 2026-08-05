import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Cổng API khi chạy dev. Đổi được bằng biến môi trường, không phải sửa file. */
const API_TARGET = process.env['VITE_API_TARGET'] ?? 'http://localhost:3000';

/**
 * Cổng khi lập trình viên chạy `pnpm dev`.
 *
 * CỐ Ý không dùng 5173 — đó là cổng mặc định của Vite nên mọi dự án khác trên
 * máy đều nhắm vào nó. Trùng cổng là mở trình duyệt ra thấy app của dự án khác,
 * và mất khá lâu mới nhận ra.
 */
export const WEB_DEV_PORT = 5180;

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      // Trỏ thẳng vào mã nguồn `packages/shared`, không qua bản build. Nhờ vậy
      // sửa schema ở shared là app web thấy ngay, không phải build lại.
      '@app/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
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
      // và mã nguồn không cần biết API nằm ở cổng nào.
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
