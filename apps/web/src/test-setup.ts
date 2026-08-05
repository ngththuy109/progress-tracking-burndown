import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Gỡ DOM sau mỗi test.
 *
 * Thiếu dòng này thì các test dồn vào cùng một `document`, và `getByRole` bắt
 * được phần tử của TEST TRƯỚC. Triệu chứng rất khó chịu: chạy riêng thì xanh,
 * chạy cả bộ thì đỏ ở một test chẳng liên quan.
 */
afterEach(() => {
  cleanup();
});
