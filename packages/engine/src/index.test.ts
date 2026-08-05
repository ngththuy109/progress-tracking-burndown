import { describe, it, expect } from 'vitest';
import { ENGINE_PACKAGE_VERSION } from './index.js';

/**
 * Test khung, sẽ được thay bằng test nghiệp vụ thật từ T-04 trở đi.
 *
 * Nó tồn tại để `pnpm test:engine` có nghĩa ngay từ T-01: chứng minh project
 * `engine` trong vitest.config.ts được nối đúng và chạy được mà KHÔNG cần
 * PostgreSQL, Redis hay mạng (CONVENTIONS.md C-12).
 *
 * Không dùng `--passWithNoTests` cho script này — làm vậy thì khi toàn bộ test
 * engine biến mất, script vẫn xanh và không ai biết.
 */
describe('khung package engine', () => {
  it('engine chạy được độc lập, không cần hạ tầng ngoài', () => {
    expect(ENGINE_PACKAGE_VERSION).toBe('0.1.0');
  });
});
