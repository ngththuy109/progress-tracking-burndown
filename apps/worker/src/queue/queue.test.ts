import { describe, expect, it, vi } from 'vitest';
import { InMemoryTokenBucketStore } from '@app/jira';
import {
  addReplacingFinished,
  BASE_BACKOFF_MS,
  backoffWithJitter,
  DEFAULT_JOB_OPTIONS,
  jobIdFor,
  MAX_ATTEMPTS,
  MAX_BACKOFF_JITTER_MS,
  QUEUE_NAME,
  QUEUE_PREFIX,
  SYNC_CONCURRENCY,
  type DedupQueue,
} from './queues.js';
import { createShutdown, registerSignalHandlers, type Closable } from './shutdown.js';
import { dispatchJob, JOB_NAME, UnknownJobError } from './worker.js';
import { RedisTokenBucketStore } from './redis-token-bucket.js';
import {
  BULLMQ_REDIS_OPTIONS,
  buildJiraRateLimiter,
  createRedisConnections,
  loggableEnv,
  MissingEnvError,
  readEnv,
  type RedisRole,
} from '../main.js';

// ---------------------------------------------------------------------------
// Cấu hình hàng đợi
// ---------------------------------------------------------------------------

describe('cấu hình hàng đợi', () => {
  it('thử lại tối đa 5 lần với giãn cách luỹ thừa từ 1 giây', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(5);
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 1000 });
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it('job thất bại hết số lần vẫn được GIỮ LẠI để điều tra', () => {
    // Job đêm hỏng lúc 00:01 mà bị xoá thì sáng ra không còn gì để xem.
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toBe(false);
  });

  it('job thành công được dọn sau 24 giờ, không giữ mãi', () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual({ age: 24 * 3600, count: 1000 });
  });

  it('chạy tối đa 4 Epic song song', () => {
    // 4 EPIC, không phải 4 request. `JiraClient` vẫn chặn ở 8 request song song
    // cho cả tiến trình — hai con số này cố ý không khớp nhau.
    expect(SYNC_CONCURRENCY).toBe(4);
  });

  it('ba hàng đợi dùng chung một tiền tố key Redis', () => {
    expect(QUEUE_PREFIX).toBe('bull:burndown');
    expect(Object.values(QUEUE_NAME)).toEqual(['sync', 'backfill', 'reconcile']);
  });
});

describe('khoảng chờ giữa các lần thử lại', () => {
  it('tăng theo luỹ thừa: 1s, 2s, 4s, 8s, 16s', () => {
    const noJitter = () => 0;
    expect(backoffWithJitter(0, noJitter)).toBe(1000);
    expect(backoffWithJitter(1, noJitter)).toBe(2000);
    expect(backoffWithJitter(2, noJitter)).toBe(4000);
    expect(backoffWithJitter(3, noJitter)).toBe(8000);
    expect(backoffWithJitter(4, noJitter)).toBe(16000);
  });

  it('hai job cùng lần thử KHÔNG chờ giống hệt nhau', () => {
    // Đây là lý do nhiễu tồn tại: 20 job cùng bị Jira trả 429 mà cùng chờ đúng
    // 4 giây thì chúng sẽ đồng loạt gọi lại và lại 429 (PRD §9.2).
    const delays = new Set(
      Array.from({ length: 200 }, () => backoffWithJitter(2, Math.random)),
    );
    expect(delays.size).toBeGreaterThan(50);
  });

  it('nhiễu không bao giờ vượt 500ms', () => {
    for (let i = 0; i < 500; i++) {
      const d = backoffWithJitter(2, Math.random);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThan(4000 + MAX_BACKOFF_JITTER_MS);
    }
    expect(BASE_BACKOFF_MS).toBe(1000);
  });

  it('lần thử âm không cho ra khoảng chờ nhỏ hơn mức cơ bản', () => {
    expect(backoffWithJitter(-3, () => 0)).toBe(1000);
  });
});

describe('chống trùng job', () => {
  it('cùng một Epic cho ra cùng một jobId', () => {
    // BullMQ bỏ qua job có jobId trùng khi job cũ còn trong hàng đợi. Nhờ vậy
    // PM bấm "Thêm" hai lần không tạo hai lần chạy bù (C-6).
    expect(jobIdFor(JOB_NAME.backfillEpic, 'PAY-1')).toBe('backfill-epic__PAY-1');
    expect(jobIdFor(JOB_NAME.backfillEpic, 'PAY-1')).toBe(jobIdFor(JOB_NAME.backfillEpic, 'PAY-1'));
  });

  it('Epic khác nhau cho ra jobId khác nhau', () => {
    expect(jobIdFor(JOB_NAME.backfillEpic, 'PAY-1')).not.toBe(
      jobIdFor(JOB_NAME.backfillEpic, 'PAY-2'),
    );
  });

  it('cùng Epic nhưng khác loại job thì KHÔNG bị coi là trùng', () => {
    // Đồng bộ và chạy bù trên cùng một Epic là hai việc khác nhau.
    expect(jobIdFor(JOB_NAME.syncEpic, 'PAY-1')).not.toBe(jobIdFor(JOB_NAME.backfillEpic, 'PAY-1'));
  });
});

describe('addReplacingFinished — dọn xác job đã kết thúc trước khi đẩy', () => {
  function fakeDedupQueue(existingState?: string) {
    const added: { name: string; jobId?: string | undefined }[] = [];
    const removed: string[] = [];
    const queue: DedupQueue = {
      getJob: (jobId) =>
        Promise.resolve(
          existingState === undefined
            ? undefined
            : {
                getState: () => Promise.resolve(existingState),
                remove: () => {
                  removed.push(jobId);
                  return Promise.resolve();
                },
              },
        ),
      add: (name, _data, opts) => {
        added.push({ name, jobId: opts?.jobId });
        return Promise.resolve({});
      },
    };
    return { queue, added, removed };
  }

  it('xác job completed của đêm trước bị dọn rồi mới đẩy lượt mới', async () => {
    // BullMQ bỏ qua `add` khi còn job trùng id ở BẤT KỲ trạng thái nào. Không
    // dọn thì quét đêm nay bị nuốt trong im lặng — không log, không sync_run.
    const { queue, added, removed } = fakeDedupQueue('completed');

    await addReplacingFinished(queue, JOB_NAME.syncEpic, { epicKey: 'PAY-1' }, 'sync-epic__PAY-1');

    expect(removed).toEqual(['sync-epic__PAY-1']);
    expect(added).toEqual([{ name: JOB_NAME.syncEpic, jobId: 'sync-epic__PAY-1' }]);
  });

  it('job failed (giữ vĩnh viễn để điều tra) không được chặn Epic đó mãi mãi', async () => {
    const { queue, added, removed } = fakeDedupQueue('failed');

    await addReplacingFinished(queue, JOB_NAME.syncEpic, { epicKey: 'PAY-1' }, 'sync-epic__PAY-1');

    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
  });

  it('job đang chờ hoặc đang chạy thì GIỮ NGUYÊN — chống trùng C-6 vẫn hoạt động', async () => {
    for (const state of ['waiting', 'active', 'delayed']) {
      const { queue, added, removed } = fakeDedupQueue(state);

      await addReplacingFinished(queue, JOB_NAME.syncEpic, { epicKey: 'PAY-1' }, 'sync-epic__PAY-1');

      expect(removed).toEqual([]);
      expect(added).toHaveLength(1); // BullMQ tự khử trùng lặp ở bước add
    }
  });

  it('không có job cũ thì đẩy thẳng', async () => {
    const { queue, added, removed } = fakeDedupQueue();

    await addReplacingFinished(queue, JOB_NAME.backfillEpic, { epicKey: 'PAY-2' }, 'backfill-epic__PAY-2');

    expect(removed).toEqual([]);
    expect(added).toEqual([{ name: JOB_NAME.backfillEpic, jobId: 'backfill-epic__PAY-2' }]);
  });
});

// ---------------------------------------------------------------------------
// Điều phối job
// ---------------------------------------------------------------------------

describe('dispatchJob', () => {
  it('gọi đúng bộ xử lý theo tên job', async () => {
    const sync = vi.fn(async () => undefined);
    const backfill = vi.fn(async () => undefined);

    await dispatchJob(JOB_NAME.syncEpic, { epicKey: 'PAY-1' }, {
      [JOB_NAME.syncEpic]: sync,
      [JOB_NAME.backfillEpic]: backfill,
    });

    expect(sync).toHaveBeenCalledWith({ epicKey: 'PAY-1' });
    expect(backfill).not.toHaveBeenCalled();
  });

  it('job không có bộ xử lý thì NÉM LỖI, không lặng lẽ bỏ qua', async () => {
    // Bỏ qua thì job báo thành công và Epic đó vĩnh viễn không được đồng bộ mà
    // không ai biết — đúng loại lỗi im lặng tốn nhiều thời gian nhất.
    await expect(dispatchJob('job-la', { epicKey: 'PAY-1' }, {})).rejects.toBeInstanceOf(
      UnknownJobError,
    );
  });

  it('thông báo lỗi nói rõ phải làm gì tiếp', async () => {
    const err = await dispatchJob('job-cu', { epicKey: 'X' }, {}).then(
      () => new Error('lẽ ra phải ném lỗi'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('job-cu');
    expect(err.message).toContain('Kiểm tra hàng đợi');
  });
});

// ---------------------------------------------------------------------------
// Tắt sạch
// ---------------------------------------------------------------------------

function fakeClosable(order: string[], name: string, delayMs = 0): Closable {
  return {
    close: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      order.push(name);
    },
  };
}

describe('tắt worker sạch sẽ', () => {
  it('đóng worker TRƯỚC rồi mới đóng kết nối', async () => {
    // Đóng Redis trước là cắt chân chính cái job đang cố hoàn tất.
    const order: string[] = [];
    const handle = createShutdown({
      workers: [fakeClosable(order, 'worker')],
      connections: [fakeClosable(order, 'redis'), fakeClosable(order, 'prisma')],
    });

    await handle.run('SIGTERM');

    expect(order).toEqual(['worker', 'redis', 'prisma']);
  });

  it('gọi hai lần không ném lỗi và không đóng hai lần', async () => {
    // Bấm Ctrl+C hai lần là chuyện bình thường.
    const order: string[] = [];
    const handle = createShutdown({
      workers: [fakeClosable(order, 'worker')],
      connections: [fakeClosable(order, 'redis')],
    });

    await Promise.all([handle.run('SIGINT'), handle.run('SIGINT')]);
    await handle.run('SIGINT');

    expect(order).toEqual(['worker', 'redis']);
  });

  it('job đang chạy quá hạn thì cảnh báo và thoát mã khác 0', async () => {
    const logs: Record<string, unknown>[] = [];
    let exitCode: number | null = null;

    const handle = createShutdown({
      // Worker không bao giờ đóng xong.
      workers: [{ close: () => new Promise<void>(() => undefined) }],
      connections: [{ close: async () => undefined }],
      timeoutMs: 30_000,
      delay: async () => undefined, // hạn chờ tới ngay lập tức
      log: (e) => logs.push(e),
      onExit: (c) => {
        exitCode = c;
      },
    });

    await handle.run('SIGTERM');

    expect(exitCode).toBe(1);
    const timeout = logs.find((l) => l['event'] === 'shutdown.timeout');
    expect(timeout).toBeDefined();
    expect(String(timeout?.['message'])).toContain('sync_run');
  });

  it('vẫn đóng kết nối kể cả khi worker quá hạn', async () => {
    // Bỏ luôn việc đóng kết nối sẽ để lại kết nối treo phía Redis.
    const order: string[] = [];
    const handle = createShutdown({
      workers: [{ close: () => new Promise<void>(() => undefined) }],
      connections: [fakeClosable(order, 'redis')],
      delay: async () => undefined,
      onExit: () => undefined,
    });

    await handle.run('SIGTERM');

    expect(order).toEqual(['redis']);
  });

  it('một kết nối đóng lỗi không chặn những cái còn lại', async () => {
    const order: string[] = [];
    const handle = createShutdown({
      workers: [fakeClosable(order, 'worker')],
      connections: [
        { close: async () => Promise.reject(new Error('redis đã đứt')) },
        fakeClosable(order, 'prisma'),
      ],
      log: () => undefined,
    });

    await handle.run('SIGTERM');

    expect(order).toEqual(['worker', 'prisma']);
  });

  it('đăng ký cả SIGTERM và SIGINT', () => {
    const registered: string[] = [];
    const handle = createShutdown({ workers: [], connections: [] });

    registerSignalHandlers(handle, {
      on(signal) {
        registered.push(signal);
        return undefined;
      },
    });

    expect(registered).toEqual(['SIGTERM', 'SIGINT']);
  });
});

// ---------------------------------------------------------------------------
// Lắp ráp
// ---------------------------------------------------------------------------

const FULL_ENV = {
  REDIS_URL: 'redis://user:secret@redis-host:6379',
  DATABASE_URL: 'postgres://user:secret@db-host:5432/burndown',
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'bot@example.com',
  JIRA_API_TOKEN: 'sieu-bi-mat-123',
};

describe('biến môi trường', () => {
  it('đọc đủ năm biến', () => {
    const env = readEnv(FULL_ENV);
    expect(env.jiraEmail).toBe('bot@example.com');
    expect(env.jiraApiToken).toBe('sieu-bi-mat-123');
  });

  it('gom TẤT CẢ biến thiếu vào một thông báo', () => {
    // Báo từng cái một khiến người dựng môi trường phải chạy lại nhiều lần.
    const err = (() => {
      try {
        readEnv({ REDIS_URL: 'redis://x' });
        return null;
      } catch (e) {
        return e as MissingEnvError;
      }
    })();

    expect(err).toBeInstanceOf(MissingEnvError);
    // JIRA_* vắng CẢ BA là hợp lệ từ multi-tenant (fallback = null) — chỉ còn
    // DATABASE_URL là thật sự thiếu.
    expect(err?.names).toEqual(['DATABASE_URL']);
    expect(err?.message).toContain('.env.example');
  });

  it('vắng cả ba biến JIRA_* là HỢP LỆ — fallback env = null (multi-tenant)', () => {
    const env = readEnv({
      REDIS_URL: 'redis://user:secret@redis-host:6379',
      DATABASE_URL: 'postgres://user:secret@db-host:5432/burndown',
    });
    expect(env.jiraBaseUrl).toBeNull();
    expect(env.jiraEmail).toBeNull();
    expect(env.jiraApiToken).toBeNull();
  });

  it('đặt JIRA_* NỬA VỜI (1–2 trên 3) là cấu hình hỏng — báo thiếu ngay', () => {
    const err = (() => {
      try {
        readEnv({
          REDIS_URL: 'redis://x',
          DATABASE_URL: 'postgres://y',
          JIRA_BASE_URL: 'https://example.atlassian.net',
        });
        return null;
      } catch (e) {
        return e as MissingEnvError;
      }
    })();

    expect(err).toBeInstanceOf(MissingEnvError);
    expect(err?.names).toEqual(['JIRA_EMAIL', 'JIRA_API_TOKEN']);
  });

  it('biến rỗng hoặc toàn khoảng trắng bị coi là thiếu', () => {
    // Token trống trong khi hai biến JIRA_* còn lại có giá trị = nửa vời.
    expect(() => readEnv({ ...FULL_ENV, JIRA_API_TOKEN: '   ' })).toThrow(MissingEnvError);
  });
});

describe('cấu hình đưa vào log', () => {
  it('KHÔNG chứa token Jira', () => {
    const printed = JSON.stringify(loggableEnv(readEnv(FULL_ENV)));
    expect(printed).not.toContain('sieu-bi-mat-123');
  });

  it('KHÔNG chứa mật khẩu nằm trong URL Redis và PostgreSQL', () => {
    // URL kết nối là chỗ rò rỉ mật khẩu dễ bị bỏ sót nhất.
    const printed = JSON.stringify(loggableEnv(readEnv(FULL_ENV)));
    expect(printed).not.toContain('secret');
    expect(printed).toContain('redis-host:6379');
    expect(printed).toContain('db-host:5432');
  });

  it('URL hỏng không làm sập việc ghi log', () => {
    const printed = loggableEnv({ ...readEnv(FULL_ENV), redisUrl: 'khong-phai-url' });
    expect(printed['redisHost']).toBe('(không đọc được)');
  });
});

describe('kết nối Redis', () => {
  it('tạo BA kết nối riêng cho queue, worker và phần còn lại', () => {
    // Dùng chung một kết nối cho Queue và Worker sẽ làm treo mọi lệnh Redis
    // khác, kể cả token bucket giới hạn tốc độ Jira.
    const roles: RedisRole[] = [];
    const conns = createRedisConnections((_url, role) => {
      roles.push(role);
      return { role };
    }, 'redis://x');

    expect(roles).toEqual(['queue', 'worker', 'general']);
    expect(conns.queue).not.toBe(conns.worker);
    expect(conns.all).toHaveLength(3);
  });

  it('mọi kết nối đều đặt maxRetriesPerRequest = null', () => {
    // Mặc định của ioredis là 20 và BullMQ sẽ ném lỗi khởi động với thông báo
    // không nói rõ nguyên nhân.
    const seen: unknown[] = [];
    createRedisConnections((_url, _role, options) => {
      seen.push(options.maxRetriesPerRequest);
      return {};
    }, 'redis://x');

    expect(seen).toEqual([null, null, null]);
    expect(BULLMQ_REDIS_OPTIONS.maxRetriesPerRequest).toBeNull();
  });
});

describe('giới hạn tốc độ Jira', () => {
  it('dùng kho trên REDIS, không phải kho trong bộ nhớ', () => {
    // Đây là lỗi im lặng nguy hiểm nhất của cả card: kho trong bộ nhớ làm mỗi
    // worker tự giữ 40 req/s riêng, 4 worker thành 160 req/s và Jira chặn cả tổ
    // chức (R-04). Test đơn tiến trình không bao giờ phát hiện được.
    const { store } = buildJiraRateLimiter({ eval: async () => 0 });

    expect(store).toBeInstanceOf(RedisTokenBucketStore);
    expect(store).not.toBeInstanceOf(InMemoryTokenBucketStore);
  });

  it('gọi Lua script với đúng khoá, tốc độ, mức bùng và mốc thời gian', async () => {
    const calls: unknown[][] = [];
    const store = new RedisTokenBucketStore(
      {
        eval: async (...args) => {
          calls.push(args);
          return 0;
        },
      },
      () => 1_700_000_000_000,
    );

    await store.tryAcquire('ratelimit:jira:tokens', 40, 40);

    const [script, numKeys, key, rate, burst, now] = calls[0] as [string, number, ...unknown[]];
    expect(script).toContain('HMGET');
    expect(numKeys).toBe(1);
    expect(key).toBe('ratelimit:jira:tokens');
    expect(rate).toBe(40);
    expect(burst).toBe(40);
    expect(now).toBe(1_700_000_000_000);
  });

  it('script trả về số mili-giây thì chờ đúng bấy nhiêu', async () => {
    const store = new RedisTokenBucketStore({ eval: async () => 25 });
    expect(await store.tryAcquire('k', 40, 40)).toBe(25);
  });

  it('script trả về giá trị lạ thì CHỜ MỘT NHỊP, không bỏ qua giới hạn', async () => {
    // Trả 0 sẽ tắt giới hạn tốc độ trong im lặng — thà chờ còn hơn bị Jira chặn.
    const store = new RedisTokenBucketStore({ eval: async () => 'hỏng' });
    expect(await store.tryAcquire('k', 40, 40)).toBe(1000);
  });
});
