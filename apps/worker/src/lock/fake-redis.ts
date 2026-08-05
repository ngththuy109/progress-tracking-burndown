import type { LockRedis } from './redis-lock.js';

/**
 * Redis giả trong bộ nhớ, chỉ đủ cho khoá phân tán.
 *
 * Cài đặt LẠI ngữ nghĩa của `SET NX PX` và hai Lua script, thay vì trả về giá
 * trị cố định — nếu không thì test "hai job không cùng lấy được khoá" sẽ xanh
 * ngay cả khi khoá hỏng hoàn toàn.
 */
export class FakeLockRedis implements LockRedis {
  private readonly store = new Map<string, { value: string; expiresAtMs: number }>();

  /** Đồng hồ ảo — test tua tới trước để kiểm chứng khoá hết hạn. */
  nowMs = 0;

  /** Đếm số lần gia hạn, để khẳng định heartbeat có thật sự chạy. */
  extendCount = 0;

  private live(key: string): { value: string; expiresAtMs: number } | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= this.nowMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  // `mode` và `condition` cố định là 'PX'/'NX' nên không cần đọc — nhưng vẫn
  // phải khai đủ tham số để khớp chữ ký `LockRedis`.
  set(key: string, value: string, ..._rest: ['PX', number, 'NX']): Promise<string | null> {
    const ttlMs = _rest[1];
    if (this.live(key) !== undefined) return Promise.resolve(null);
    this.store.set(key, { value, expiresAtMs: this.nowMs + ttlMs });
    return Promise.resolve('OK');
  }

  eval(script: string, _numKeys: number, ...args: string[]): Promise<unknown> {
    const [key, token, ttl] = args;
    const entry = this.live(key!);

    // Cả hai script đều bắt đầu bằng kiểm tra chủ sở hữu.
    if (entry === undefined || entry.value !== token) return Promise.resolve(0);

    if (script.includes('pexpire')) {
      this.extendCount += 1;
      entry.expiresAtMs = this.nowMs + Number(ttl);
      return Promise.resolve(1);
    }

    this.store.delete(key!);
    return Promise.resolve(1);
  }

  /** Chỉ dùng trong test. */
  has(key: string): boolean {
    return this.live(key) !== undefined;
  }

  ownerOf(key: string): string | undefined {
    return this.live(key)?.value;
  }
}
