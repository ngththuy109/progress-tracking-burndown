import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  acquireLock,
  extendLock,
  releaseLock,
  lockKeyFor,
  LockHeartbeat,
  LOCK_TTL_MS,
} from './redis-lock.js';
import { FakeLockRedis } from './fake-redis.js';

afterEach(() => {
  vi.useRealTimers();
});

const KEY = lockKeyFor('PAY-100');

describe('lấy và nhả khoá', () => {
  it('job thứ hai KHÔNG lấy được khoá khi job thứ nhất còn giữ', async () => {
    const redis = new FakeLockRedis();
    expect(await acquireLock(redis, KEY, 'job-1')).not.toBeNull();
    expect(await acquireLock(redis, KEY, 'job-2')).toBeNull();
  });

  it('nhả khoá xong thì job khác lấy được', async () => {
    const redis = new FakeLockRedis();
    const lock = (await acquireLock(redis, KEY, 'job-1'))!;
    expect(await releaseLock(redis, lock)).toBe(true);
    expect(await acquireLock(redis, KEY, 'job-2')).not.toBeNull();
  });

  it('KHÔNG nhả được khoá của job khác', async () => {
    // Khoá của mình hết hạn, job khác chiếm được, rồi mình chạy xong và xoá
    // khoá của họ — hai job cùng chạy mà không ai biết
    const redis = new FakeLockRedis();
    await acquireLock(redis, KEY, 'job-1');
    const stolen = { key: KEY, token: 'job-2' };

    expect(await releaseLock(redis, stolen)).toBe(false);
    expect(redis.ownerOf(KEY)).toBe('job-1');
  });

  it('khoá tự hết hạn sau TTL', async () => {
    const redis = new FakeLockRedis();
    await acquireLock(redis, KEY, 'job-1');
    redis.nowMs += LOCK_TTL_MS + 1;
    expect(redis.has(KEY)).toBe(false);
    expect(await acquireLock(redis, KEY, 'job-2')).not.toBeNull();
  });

  it('gia hạn kéo dài TTL của khoá', async () => {
    const redis = new FakeLockRedis();
    const lock = (await acquireLock(redis, KEY, 'job-1'))!;

    redis.nowMs += LOCK_TTL_MS - 1000;
    expect(await extendLock(redis, lock)).toBe(true);

    redis.nowMs += LOCK_TTL_MS - 1000;
    expect(redis.has(KEY)).toBe(true);
  });

  it('KHÔNG gia hạn được khoá của job khác', async () => {
    const redis = new FakeLockRedis();
    await acquireLock(redis, KEY, 'job-1');
    expect(await extendLock(redis, { key: KEY, token: 'job-2' })).toBe(false);
  });

  it('gia hạn khoá đã hết hạn trả false, KHÔNG tạo lại khoá', async () => {
    const redis = new FakeLockRedis();
    const lock = (await acquireLock(redis, KEY, 'job-1'))!;
    redis.nowMs += LOCK_TTL_MS + 1;

    expect(await extendLock(redis, lock)).toBe(false);
    expect(redis.has(KEY)).toBe(false);
  });
});

describe('heartbeat', () => {
  it('gia hạn TTL khoá đều đặn trong lúc job chạy', async () => {
    vi.useFakeTimers();
    const redis = new FakeLockRedis();
    const lock = (await acquireLock(redis, KEY, 'job-1'))!;

    const hb = new LockHeartbeat(redis, lock, 1000);
    hb.start();

    await vi.advanceTimersByTimeAsync(3500);
    hb.stop();

    expect(redis.extendCount).toBe(3);
  });

  it('stop() dừng hẳn việc gia hạn', async () => {
    vi.useFakeTimers();
    const redis = new FakeLockRedis();
    const lock = (await acquireLock(redis, KEY, 'job-1'))!;

    const hb = new LockHeartbeat(redis, lock, 1000);
    hb.start();
    await vi.advanceTimersByTimeAsync(2500);
    hb.stop();

    const before = redis.extendCount;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(redis.extendCount).toBe(before);
  });

  it('gọi stop() nhiều lần không ném lỗi', () => {
    const redis = new FakeLockRedis();
    const hb = new LockHeartbeat(redis, { key: KEY, token: 't' });
    expect(() => {
      hb.stop();
      hb.stop();
    }).not.toThrow();
  });

  it('gọi start() hai lần chỉ tạo một bộ đếm giờ', async () => {
    vi.useFakeTimers();
    const redis = new FakeLockRedis();
    const lock = (await acquireLock(redis, KEY, 'job-1'))!;

    const hb = new LockHeartbeat(redis, lock, 1000);
    hb.start();
    hb.start();
    await vi.advanceTimersByTimeAsync(2500);
    hb.stop();

    expect(redis.extendCount).toBe(2);
  });

  it('mất khoá giữa chừng thì gọi onLost, KHÔNG im lặng chạy tiếp', async () => {
    vi.useFakeTimers();
    const redis = new FakeLockRedis();
    const lock = (await acquireLock(redis, KEY, 'job-1'))!;

    let lost = false;
    const hb = new LockHeartbeat(redis, lock, 1000, LOCK_TTL_MS, () => {
      lost = true;
    });
    hb.start();

    // Job khác chiếm khoá
    await releaseLock(redis, lock);
    await acquireLock(redis, KEY, 'job-2');

    await vi.advanceTimersByTimeAsync(1500);
    hb.stop();

    expect(lost).toBe(true);
  });

  it('running phản ánh đúng trạng thái', () => {
    const redis = new FakeLockRedis();
    const hb = new LockHeartbeat(redis, { key: KEY, token: 't' }, 1000);
    expect(hb.running).toBe(false);
    hb.start();
    expect(hb.running).toBe(true);
    hb.stop();
    expect(hb.running).toBe(false);
  });
});
