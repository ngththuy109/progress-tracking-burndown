/**
 * Khoá phân tán trên Redis — PRD §4.2.1.
 *
 * ĐÂY KHÔNG PHẢI KHOÁ TRÊN JIRA. Người dùng vẫn sửa Epic, thêm Sub-task, log
 * giờ **bình thường 24/7**, kể cả đúng lúc job đang chạy. Hệ thống này chỉ ĐỌC
 * từ Jira.
 *
 * Khoá là **tối ưu, không phải cơ chế đảm bảo tính đúng đắn**. Lớp đảm bảo thật
 * sự là `UNIQUE (epic_key, snapshot_date)` + UPSERT idempotent. Khoá hỏng hoàn
 * toàn thì **số liệu vẫn không sai** — chỉ tốn thêm quota Jira và CPU.
 */

/** Tập lệnh Redis tối thiểu mà khoá cần. Khai hẹp để test cắm được bản giả. */
export interface LockRedis {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    condition: 'NX',
  ): Promise<string | null>;
  /** Chạy Lua script. Cần cho việc nhả khoá và gia hạn có kiểm tra chủ sở hữu. */
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

export const LOCK_TTL_MS = 15 * 60_000;
export const HEARTBEAT_INTERVAL_MS = 60_000;

export function lockKeyFor(epicKey: string): string {
  return `joblock:sync:${epicKey}`;
}

/**
 * Nhả khoá CHỈ KHI mình còn là chủ sở hữu.
 *
 * Không kiểm tra token thì có thể nhả nhầm khoá của job khác: khoá của mình hết
 * hạn giữa chừng, job khác chiếm được, rồi mình chạy xong và xoá khoá của họ.
 * Hai job cùng chạy mà không ai biết.
 */
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Gia hạn cũng phải kiểm tra chủ sở hữu, vì cùng lý do. */
const EXTEND_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

export interface AcquiredLock {
  readonly key: string;
  /** Token sở hữu — dùng để nhả và gia hạn đúng khoá của mình. */
  readonly token: string;
}

export async function acquireLock(
  redis: LockRedis,
  key: string,
  token: string,
  ttlMs: number = LOCK_TTL_MS,
): Promise<AcquiredLock | null> {
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  return ok === null ? null : { key, token };
}

export async function releaseLock(redis: LockRedis, lock: AcquiredLock): Promise<boolean> {
  const result = await redis.eval(RELEASE_LUA, 1, lock.key, lock.token);
  return Number(result) === 1;
}

export async function extendLock(
  redis: LockRedis,
  lock: AcquiredLock,
  ttlMs: number = LOCK_TTL_MS,
): Promise<boolean> {
  const result = await redis.eval(EXTEND_LUA, 1, lock.key, lock.token, String(ttlMs));
  return Number(result) === 1;
}

/**
 * Bộ gia hạn định kỳ.
 *
 * Job có thể chạy lâu hơn TTL 15 phút (Jira chậm, dính 429 nhiều lần). Không
 * gia hạn thì khoá tự hết hạn giữa chừng và một job khác chen vào.
 *
 * QUÊN `stop()` LÀ RÒ RỈ: worker chạy vài ngày sẽ tích tụ hàng trăm bộ đếm giờ
 * đang gia hạn những khoá không còn tồn tại. Luôn gọi trong khối `finally`.
 */
export class LockHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly redis: LockRedis,
    private readonly lock: AcquiredLock,
    private readonly intervalMs: number = HEARTBEAT_INTERVAL_MS,
    private readonly ttlMs: number = LOCK_TTL_MS,
    private readonly onLost?: () => void,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void extendLock(this.redis, this.lock, this.ttlMs).then((ok) => {
        // Mất khoá giữa chừng nghĩa là job khác đã chiếm. Báo ra để chỗ gọi
        // quyết định, thay vì lặng lẽ chạy tiếp và ghi đè dữ liệu của họ.
        if (!ok) this.onLost?.();
      });
    }, this.intervalMs);
    // Không giữ tiến trình sống chỉ vì bộ đếm giờ này.
    this.timer.unref?.();
  }

  /** An toàn khi gọi nhiều lần. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}
