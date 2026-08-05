import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Ba test này kiểm tra CHÍNH HÀNG RÀO KIẾN TRÚC, không kiểm tra code nghiệp vụ.
 *
 * Không có chúng thì hai lint rule ở eslint.config.js chỉ là tài liệu — người sau
 * vô tình làm hỏng selector mà không ai biết, và engine lặng lẽ nhiễm phụ thuộc
 * vào db/jira hoặc bắt đầu đọc đồng hồ.
 */

/** Lint một đoạn mã như thể nó nằm trong packages/engine, rồi trả về danh sách ruleId. */
async function lintAsEngineFile(code: string): Promise<string[]> {
  const dir = join(REPO_ROOT, 'packages', 'engine', 'src', '__arch_tmp__');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'probe.ts');
  writeFileSync(file, code, 'utf8');

  try {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const results = await eslint.lintFiles([file]);
    return results.flatMap((r) => r.messages.map((m) => m.ruleId ?? '(fatal)'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Hàng rào 1 — engine không được phụ thuộc db hoặc jira', () => {
  it('lint chặn khi engine import từ @app/db', async () => {
    const rules = await lintAsEngineFile(
      `import { DB_PACKAGE_VERSION } from '@app/db';\nexport const x = DB_PACKAGE_VERSION;\n`,
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it('lint chặn khi engine import từ @app/jira', async () => {
    const rules = await lintAsEngineFile(
      `import { JIRA_PACKAGE_VERSION } from '@app/jira';\nexport const x = JIRA_PACKAGE_VERSION;\n`,
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it('lint CHO PHÉP engine import từ @app/shared', async () => {
    const rules = await lintAsEngineFile(
      `import { SHARED_PACKAGE_VERSION } from '@app/shared';\nexport const x = SHARED_PACKAGE_VERSION;\n`,
    );
    expect(rules).not.toContain('no-restricted-imports');
  });
});

describe('Hàng rào 2 — engine không được đọc đồng hồ', () => {
  it('lint chặn khi engine gọi new Date()', async () => {
    const rules = await lintAsEngineFile(`export const t = new Date();\n`);
    expect(rules).toContain('no-restricted-syntax');
  });

  it('lint chặn khi engine gọi Date.now()', async () => {
    const rules = await lintAsEngineFile(`export const t = Date.now();\n`);
    expect(rules).toContain('no-restricted-syntax');
  });

  it('lint chặn khi engine gọi DateTime.now() của luxon', async () => {
    const rules = await lintAsEngineFile(
      `import { DateTime } from 'luxon';\nexport const t = DateTime.now();\n`,
    );
    expect(rules).toContain('no-restricted-syntax');
  });

  it('lint CHO PHÉP engine nhận ngày qua tham số', async () => {
    const rules = await lintAsEngineFile(
      `export function f(asOfDate: string): string { return asOfDate; }\n`,
    );
    expect(rules).not.toContain('no-restricted-syntax');
  });
});

describe('Hàng rào 3 — mọi package biên dịch được', () => {
  it('tsc --build chạy sạch trên toàn workspace', () => {
    expect(() =>
      execFileSync('node', ['node_modules/typescript/lib/tsc.js', '--build', '--force'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
