import { describe, it, expect } from 'vitest';
import { failStaleSyncRuns, STALE_RUN_ERROR_MESSAGE } from './sync-run.repository.js';
import type { PrismaClient } from '../client.js';

/**
 * `failStaleSyncRuns` là lưới an toàn cho "job treo không kết thúc": nó dọn các
 * dòng `sync_run` mồ côi ở `RUNNING` (worker chết cứng, hoặc DB sập đúng lúc ghi
 * FAILED). Thứ đáng kiểm chứng là ĐIỀU KIỆN nhắm dòng — sai một chút là dọn NHẦM
 * job đang chạy thật — chứ không phải bản thân câu SQL, nên chỉ cần giả
 * `updateMany` và soi tham số nó nhận.
 */
function fakePrisma(count: number, capture: (args: any) => void): PrismaClient {
  return {
    syncRun: {
      updateMany: (args: any) => {
        capture(args);
        return Promise.resolve({ count });
      },
    },
  } as unknown as PrismaClient;
}

describe('failStaleSyncRuns — dọn dòng RUNNING mồ côi', () => {
  const now = new Date('2026-08-18T10:00:00.000Z');

  it('chỉ nhắm dòng RUNNING cũ hơn mốc; đánh FAILED, finishedAt=now, duration 0', async () => {
    let captured: any;
    const prisma = fakePrisma(3, (a) => {
      captured = a;
    });

    const reaped = await failStaleSyncRuns(prisma, { now, olderThanMs: 60 * 60 * 1000 });

    expect(reaped).toBe(3);
    // Chỉ dòng RUNNING, và chỉ dòng bắt đầu TRƯỚC (now - 1 giờ).
    expect(captured.where.status).toBe('RUNNING');
    expect(captured.where.startedAt).toEqual({ lt: new Date('2026-08-18T09:00:00.000Z') });
    // Chuyển sang FAILED với dấu vết đủ để Monitoring hiểu chuyện gì xảy ra.
    expect(captured.data.status).toBe('FAILED');
    expect(captured.data.finishedAt).toBe(now);
    expect(captured.data.durationMs).toBe(0);
    expect(captured.data.errorMessage).toBe(STALE_RUN_ERROR_MESSAGE);
  });

  it('KHÔNG lọc theo run_type — DAILY/RECONCILE mồ côi cũng gây hiểu nhầm y hệt', async () => {
    let captured: any;
    const prisma = fakePrisma(0, (a) => {
      captured = a;
    });

    await failStaleSyncRuns(prisma, { now, olderThanMs: 1000 });

    expect(captured.where).not.toHaveProperty('runType');
  });

  it('KHÔNG đụng dòng mới hơn mốc — biên an toàn co giãn theo olderThanMs', async () => {
    let captured: any;
    const prisma = fakePrisma(0, (a) => {
      captured = a;
    });

    // Mốc rộng hơn (2 giờ) đẩy cutoff lùi xa hơn, nên ít dòng lọt vào diện dọn.
    await failStaleSyncRuns(prisma, { now, olderThanMs: 2 * 60 * 60 * 1000 });

    expect(captured.where.startedAt.lt).toEqual(new Date('2026-08-18T08:00:00.000Z'));
  });

  it('nhận errorMessage tuỳ biến khi nơi gọi muốn ghi rõ nguồn dọn', async () => {
    let captured: any;
    const prisma = fakePrisma(1, (a) => {
      captured = a;
    });

    await failStaleSyncRuns(prisma, { now, olderThanMs: 1000, errorMessage: 'dọn lúc khởi động' });

    expect(captured.data.errorMessage).toBe('dọn lúc khởi động');
  });
});
