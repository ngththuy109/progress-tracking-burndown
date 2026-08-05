// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Hai khối `engine` bên dưới là LÝ DO CHÍNH của card T-01, không phải thứ trang trí.
 * Xem ARCHITECTURE.md §2.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.tsbuildinfo', 'docs/**'],
  },

  // Script vận hành chạy thẳng bằng Node, không qua TypeScript. Chúng dùng
  // `process`, `console`, `fetch` — toàn biến toàn cục của Node, mà cấu hình
  // mặc định của eslint không biết.
  {
    files: ['tools/smoke/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------------------
  // HÀNG RÀO 1 — packages/engine không được import db hoặc jira
  //
  // Engine chứa logic được kiểm chứng bằng 20 golden dataset. Nếu nó import db
  // hay jira thì muốn chạy test phải dựng PostgreSQL và Jira sandbox — bộ test
  // từ vài giây thành vài phút, và sẽ không ai chạy nó nữa.
  // ---------------------------------------------------------------------------
  {
    files: ['packages/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@app/db', '@app/db/*', '@app/jira', '@app/jira/*', '**/db/**', '**/jira/**'],
              message:
                'packages/engine phải thuần tính toán. Không được import @app/db hoặc @app/jira — ' +
                'nếu không thì test engine sẽ cần PostgreSQL và Jira sandbox. Xem ARCHITECTURE.md §2.',
            },
          ],
        },
      ],

      // -----------------------------------------------------------------------
      // HÀNG RÀO 2 — packages/engine không được đọc đồng hồ
      //
      // Trạng thái Signboard phụ thuộc "hôm nay là ngày nào" (PRD §6.3). Test
      // không đóng băng đồng hồ sẽ xanh hôm nay và đỏ tuần sau. Hàm cần hôm nay
      // phải nhận qua tham số `asOfDate`.
      // -----------------------------------------------------------------------
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'packages/engine không được đọc đồng hồ. Nhận ngày qua tham số asOfDate. ' +
            'Xem ARCHITECTURE.md §2 và CONVENTIONS.md C-1.',
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message:
            'packages/engine không được đọc đồng hồ. Nhận ngày qua tham số asOfDate. ' +
            'Xem ARCHITECTURE.md §2 và CONVENTIONS.md C-1.',
        },
        {
          selector: "CallExpression[callee.object.name='DateTime'][callee.property.name='now']",
          message:
            'packages/engine không được đọc đồng hồ, kể cả qua luxon. ' +
            'Nhận ngày qua tham số asOfDate.',
        },
        {
          selector: "CallExpression[callee.object.name='DateTime'][callee.property.name='local']",
          message:
            'packages/engine không được đọc đồng hồ, kể cả qua luxon. ' +
            'Nhận ngày qua tham số asOfDate.',
        },
      ],
    },
  },

  // Cấm `any` trong engine (PRD §8.5 — điều kiện merge code)
  {
    files: ['packages/engine/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // Test được phép dùng fixture linh hoạt hơn
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
