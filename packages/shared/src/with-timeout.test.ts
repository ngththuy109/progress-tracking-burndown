import { describe, it, expect, vi } from 'vitest';
import { withTimeout, TimeoutError } from './with-timeout.js';

/** Promise cố ý KHÔNG BAO GIỜ settle — mô phỏng phụ thuộc treo. */
const hung = <T>(): Promise<T> => new Promise<T>(() => {});

describe('withTimeout', () => {
  it('trả kết quả khi task xong trước hạn', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'x')).resolves.toBe('ok');
  });

  it('ném TimeoutError khi task treo quá hạn', async () => {
    await expect(withTimeout(hung<never>(), 10, 'Redis')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('thông báo lỗi nêu rõ nhãn và số ms để biết chỗ nào treo', async () => {
    await expect(withTimeout(hung<never>(), 10, 'Redis (ping)')).rejects.toThrow(
      /Redis \(ping\).*10ms/,
    );
  });

  it('giữ NGUYÊN lỗi thật của task, không nuốt thành TimeoutError', async () => {
    const boom = new Error('nổ');
    await expect(withTimeout(Promise.reject(boom), 1000, 'x')).rejects.toBe(boom);
  });

  it('xoá timer sau khi task settle — không rò hạn chót giữ event loop', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await withTimeout(Promise.resolve(1), 1000, 'x');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
