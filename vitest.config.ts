import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Project `engine` được tách riêng có chủ đích.
 *
 * `pnpm test:engine` phải chạy DƯỚI 10 GIÂY và không cần PostgreSQL, Redis hay
 * mạng (CONVENTIONS.md C-12). Ngưỡng đó tồn tại để dev thật sự chạy test thường
 * xuyên — nếu bộ test mất vài phút thì sẽ không ai chạy nó nữa.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@app/shared': r('./packages/shared/src/index.ts'),
      '@app/engine': r('./packages/engine/src/index.ts'),
      '@app/db': r('./packages/db/src/index.ts'),
      '@app/jira': r('./packages/jira/src/index.ts'),
    },
  },
  test: {
    /**
     * Chỉ đo độ phủ trên `packages/engine`.
     *
     * PRD §8.5 đặt ngưỡng ≥ 90% cho engine, không đặt cho phần còn lại — vì đó
     * là nơi chứa toàn bộ logic nghiệp vụ và cũng là nơi test chạy được mà không
     * cần hạ tầng. Đo cả repo sẽ pha loãng con số bằng mã điều phối.
     */
    coverage: {
      provider: 'v8',
      include: ['packages/engine/src/**'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      reporter: ['text-summary'],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'engine',
          include: ['packages/engine/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'packages/{shared,db,jira}/**/*.test.ts',
            'apps/{api,worker}/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          // Component cần `document`. `node` không có DOM nên mọi test giao
          // diện sẽ đỏ với thông báo `document is not defined`.
          environment: 'jsdom',
          setupFiles: ['./apps/web/src/test-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'arch',
          include: ['tools/arch-tests/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
    ],
  },
});
