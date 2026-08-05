import { REDIS_TOKEN_BUCKET_LUA, type TokenBucketStore } from '@app/jira';

/**
 * Token bucket giới hạn tốc độ gọi Jira, lưu TRÊN REDIS — quy ước C-7.
 *
 * VÌ SAO KHÔNG DÙNG BẢN IN-MEMORY: mỗi worker sẽ tự giữ 40 request/giây của
 * riêng nó. Bốn worker thành 160 request/giây và vẫn bị Jira chặn. Đây là lỗi
 * im lặng nguy hiểm nhất của cả tầng hạ tầng: **mọi test đơn tiến trình vẫn
 * xanh**, chỉ khi chạy nhiều worker trên production mới vỡ — và rủi ro R-04 xếp
 * ảnh hưởng ở mức "Rất cao" vì bị chặn là ảnh hưởng cả tổ chức.
 *
 * `packages/jira` cố ý KHÔNG phụ thuộc `ioredis`; nó chỉ cung cấp Lua script và
 * khai cổng `TokenBucketStore`. Chỗ nối vào Redis nằm ở đây.
 */

/** Phần `ioredis` mà bucket cần. Hẹp lại để test không phải dựng Redis thật. */
export interface EvalRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export class RedisTokenBucketStore implements TokenBucketStore {
  constructor(
    private readonly redis: EvalRedis,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async tryAcquire(key: string, ratePerSec: number, burst: number): Promise<number> {
    // Lua chạy nguyên tử trên Redis. Đọc-rồi-ghi bằng hai lệnh riêng sẽ tranh
    // chấp giữa các worker, và bucket lại rò rỉ đúng lúc tải cao nhất.
    const raw = await this.redis.eval(REDIS_TOKEN_BUCKET_LUA, 1, key, ratePerSec, burst, this.now());
    const waitMs = Number(raw);

    // Lua trả về số nguyên; giá trị lạ nghĩa là script hỏng. Trả 0 sẽ bỏ qua
    // giới hạn tốc độ trong im lặng — thà chờ một nhịp còn hơn.
    return Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : 1000;
  }
}
