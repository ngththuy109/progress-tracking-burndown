import { Queue, type JobsOptions, type QueueOptions } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * Ba hàng đợi của hệ thống — PRD §4.1, §4.7.
 *
 * File này CHỈ khai cấu hình và tạo đối tượng `Queue`. Không có một dòng logic
 * nghiệp vụ nào ở đây; job làm gì là việc của `jobs/`.
 */

/** Tiền tố key Redis, theo bố trí ở PRD §4.7. */
export const QUEUE_PREFIX = 'bull:burndown';

export const QUEUE_NAME = {
  /** Đồng bộ hằng đêm và tính lại theo yêu cầu. */
  sync: 'sync',
  /** Chạy bù toàn bộ lịch sử khi Epic vừa được thêm. */
  backfill: 'backfill',
  /** Đối soát hằng tuần (T-26). */
  reconcile: 'reconcile',
} as const;

export type QueueName = (typeof QUEUE_NAME)[keyof typeof QUEUE_NAME];

/**
 * Số Epic xử lý SONG SONG — PRD §9.2.
 *
 * Đây là 4 **Epic**, không phải 4 request. `JiraClient` vẫn chặn ở 8 request
 * song song cho cả tiến trình, nên 4 job không thể đẩy quá 8 request cùng lúc.
 * Hai con số này CỐ Ý không khớp nhau; đừng "sửa" cho bằng.
 */
export const SYNC_CONCURRENCY = 4;

export const MAX_ATTEMPTS = 5;
export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_JITTER_MS = 500;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: MAX_ATTEMPTS,
  // 1s → 2s → 4s → 8s → 16s. Nhiễu được cộng thêm ở `backoffWithJitter`.
  backoff: { type: 'exponential', delay: BASE_BACKOFF_MS },
  removeOnComplete: { age: 24 * 3600, count: 1000 },

  // GIỮ LẠI job hỏng. Mặc định của BullMQ trông gọn gàng nhưng sai với ca này:
  // job đêm hỏng lúc 00:01 mà bị xoá thì sáng ra không còn gì để điều tra.
  removeOnFail: false,
};

/**
 * Khoảng chờ trước lần thử thứ `attemptsMade + 1`, ĐÃ CỘNG NHIỄU.
 *
 * BullMQ `exponential` KHÔNG tự cộng nhiễu. Không có nhiễu thì 20 job cùng bị
 * Jira trả 429 sẽ cùng chờ đúng 4 giây rồi đồng loạt gọi lại — và lại 429. Nhiễu
 * 0–500ms đủ để rải chúng ra (PRD §9.2).
 */
export function backoffWithJitter(attemptsMade: number, random: () => number = Math.random): number {
  const base = BASE_BACKOFF_MS * 2 ** Math.max(0, attemptsMade);
  return base + Math.floor(random() * MAX_BACKOFF_JITTER_MS);
}

/**
 * Khoá chống trùng job.
 *
 * BullMQ bỏ qua job có `jobId` trùng nếu job cũ còn trong hàng đợi. Nhờ vậy PM
 * bấm "Thêm Epic" hai lần không tạo hai lần chạy bù trên cùng một Epic (C-6).
 */
export function jobIdFor(jobName: string, epicKey: string): string {
  // Dấu `__` chứ KHÔNG phải `:`. BullMQ cấm dấu hai chấm trong jobId tuỳ biến
  // ("Custom Id cannot contain :") vì `:` là dấu phân tách key của Redis — dùng
  // `:` thì mọi lần đẩy job đều ném lỗi ngay khi tạo.
  return `${jobName}__${epicKey}`;
}

export interface QueueSet {
  readonly sync: Queue;
  readonly backfill: Queue;
  readonly reconcile: Queue;
  /** Đóng cả ba. Gọi trước khi đóng kết nối Redis. */
  closeAll(): Promise<void>;
}

/**
 * @param connection Kết nối RIÊNG cho hàng đợi.
 *
 * Dùng chung một kết nối `ioredis` cho cả `Queue` lẫn `Worker` là sai: BullMQ
 * cần kết nối riêng cho chế độ chờ (blocking), và dùng chung sẽ làm treo mọi
 * lệnh Redis khác — kể cả token bucket giới hạn tốc độ Jira.
 */
export function createQueues(connection: Redis): QueueSet {
  const options: QueueOptions = {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  };

  const sync = new Queue(QUEUE_NAME.sync, options);
  const backfill = new Queue(QUEUE_NAME.backfill, options);
  const reconcile = new Queue(QUEUE_NAME.reconcile, options);

  return {
    sync,
    backfill,
    reconcile,
    async closeAll() {
      await Promise.all([sync.close(), backfill.close(), reconcile.close()]);
    },
  };
}
