import { Worker, type Job, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUE_NAME, QUEUE_PREFIX, SYNC_CONCURRENCY, type QueueName } from './queues.js';

/**
 * Vòng đời worker.
 *
 * Bộ xử lý ở đây CHỈ điều phối: đọc dữ liệu job, gọi đúng hàm nghiệp vụ. Nhét
 * logic vào đây là biến nó thành chỗ không test được nếu không có Redis.
 */

/** Tên job chạy trên hàng đợi `sync`. */
export const JOB_NAME = {
  syncEpic: 'sync-epic',
  reconstructEpic: 'reconstruct-epic',
  backfillEpic: 'backfill-epic',
  reconcileEpic: 'reconcile-epic',
} as const;

/**
 * Nội dung job đọc từ BullMQ, ở dạng CHƯA KIỂM.
 *
 * Cố ý là `unknown`. Trước đây chỗ này khai `{ epicKey: string }` — một lời nói
 * dối mà trình biên dịch tin ngay: API đẩy job kèm `from` / `to` / `full`, còn
 * bộ xử lý đọc kiểu này thì không nhìn thấy ba trường đó và cũng không có cách
 * nào biết mình đang bỏ sót. Không một dòng lỗi nào ở bất kỳ đâu.
 *
 * Dữ liệu job là JSON do một tiến trình KHÁC ghi vào Redis, có thể từ một phiên
 * bản code cũ. `unknown` bắt bộ xử lý phải kiểm bằng `parseSyncJobPayload` của
 * `@app/shared` trước khi đọc bất cứ trường nào — không kiểm thì không biên dịch
 * được.
 */
export type JobPayload = unknown;

export type JobHandler = (payload: JobPayload) => Promise<void>;

/** Tên job → hàm xử lý. Khai kiểu này để `dispatchJob` test được không cần BullMQ. */
export type HandlerMap = Readonly<Record<string, JobHandler | undefined>>;

export class UnknownJobError extends Error {
  constructor(readonly jobName: string) {
    super(
      `No handler for job "${jobName}". Most likely an old job is still stuck in the queue ` +
        'after a rename. Check the queue and delete that job, or add the matching handler.',
    );
    this.name = 'UnknownJobError';
  }
}

/**
 * Điều phối một job tới đúng bộ xử lý.
 *
 * Job không có bộ xử lý phải NÉM LỖI, không được lặng lẽ bỏ qua: bỏ qua thì job
 * báo thành công và Epic đó vĩnh viễn không được đồng bộ mà không ai biết.
 */
export async function dispatchJob(
  jobName: string,
  payload: JobPayload,
  handlers: HandlerMap,
): Promise<void> {
  const handler = handlers[jobName];
  if (handler === undefined) throw new UnknownJobError(jobName);
  await handler(payload);
}

export interface WorkerDeps {
  /** Kết nối RIÊNG cho worker, không dùng chung với `Queue`. */
  readonly connection: Redis;
  readonly handlers: HandlerMap;
  readonly concurrency?: number;
  readonly log?: (event: Record<string, unknown>) => void;
  /**
   * Hàng đợi để tiêu thụ. Mặc định `sync`.
   *
   * Ba hàng đợi (sync / backfill / reconcile) cố ý tách nhau (PRD §4.1) để một
   * lượt chạy bù 500 Sub-task không chặn job đêm. Mỗi hàng đợi có một Worker
   * riêng nhưng dùng CHUNG bảng điều phối `handlers` — job tự tìm bộ xử lý theo
   * tên, không theo hàng đợi.
   */
  readonly queueName?: QueueName;
}

export function createSyncWorker(deps: WorkerDeps): Worker {
  const log = deps.log ?? (() => undefined);

  const options: WorkerOptions = {
    connection: deps.connection,
    prefix: QUEUE_PREFIX,
    concurrency: deps.concurrency ?? SYNC_CONCURRENCY,
  };

  const worker = new Worker(
    deps.queueName ?? QUEUE_NAME.sync,
    async (job: Job) => {
      // `job.data` KHÔNG được ép kiểu ở đây. Nó là JSON do tiến trình khác ghi
      // vào Redis; bộ xử lý phải tự kiểm bằng `parseSyncJobPayload`.
      await dispatchJob(job.name, job.data, deps.handlers);
    },
    options,
  );

  worker.on('failed', (job, err) => {
    // `correlationId` là id job — đủ để lần một Epic qua toàn bộ log (C-9).
    log({
      event: 'job.failed',
      correlationId: job?.id ?? null,
      jobName: job?.name ?? null,
      attemptsMade: job?.attemptsMade ?? 0,
      message: err.message,
    });
  });

  worker.on('completed', (job) => {
    log({ event: 'job.completed', correlationId: job.id, jobName: job.name });
  });

  return worker;
}
