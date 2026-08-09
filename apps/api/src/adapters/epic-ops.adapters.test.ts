import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@app/db';
import type { TrackedEpicStatus } from '@app/shared';
import { createEpicOpsWritePort, SYNC_JOB_NAME } from './epic-ops.adapters.js';
import type { QueueLike } from './epic-registry.adapters.js';

/**
 * Bug "Resync → 500 INTERNAL_ERROR" (màn hình Đồng bộ lại).
 *
 * Bản cũ của `setStatus` chạy raw SQL `UPDATE tracked_epic SET status = $2,
 * updated_at = NOW() ...`, nhưng `tracked_epic` KHÔNG có cột `updated_at` (xem
 * schema.prisma / migration 20260803000000_init). Postgres ném `column
 * "updated_at" does not exist`. Vì `setStatus` là thao tác GHI duy nhất trên
 * đường đồng bộ lại một Epic đang ERROR/PENDING (ERROR → BACKFILLING là chuyển
 * hợp lệ), lỗi đó nổi lên thành 500 và cả nút Resync chết.
 *
 * Test route (epic-ops.routes.test.ts) KHÔNG bắt được vì `FakeWrites.setStatus`
 * chỉ đẩy vào mảng, chẳng bao giờ chạm SQL — đúng kiểu "lớp giả nói dối". Test
 * này đi qua CHÍNH adapter production `createEpicOpsWritePort`, với Prisma/queue
 * giả ghi lại lời gọi, nên chạy được không cần PostgreSQL lẫn Redis.
 */

interface UpdateCall {
  readonly where: { readonly epicKey: string };
  readonly data: Record<string, unknown>;
}

function fakePrisma() {
  const updates: UpdateCall[] = [];
  const prisma = {
    trackedEpic: {
      update: (args: UpdateCall) => {
        updates.push(args);
        return Promise.resolve({});
      },
    },
    // Bẫy: bản cũ đi qua $executeRawUnsafe. Nếu code lại rơi về raw SQL, test
    // dưới sẽ đỏ vì `updates` rỗng — không cần mô phỏng Postgres xác thực cột.
    $executeRawUnsafe: () => {
      throw new Error('setStatus phải dùng Prisma có kiểu, không raw SQL (cột updated_at không tồn tại)');
    },
  } as unknown as PrismaClient;
  return { prisma, updates };
}

interface AddCall {
  readonly name: string;
  readonly data: unknown;
  readonly opts: { readonly jobId?: string } | undefined;
}

function fakeQueue() {
  const added: AddCall[] = [];
  const queue: QueueLike = {
    add: (name, data, opts) => {
      added.push({ name, data, opts: opts as AddCall['opts'] });
      return Promise.resolve({});
    },
  };
  return { queue, added };
}

describe('createEpicOpsWritePort.setStatus — không chạm cột không tồn tại', () => {
  it('ERROR → BACKFILLING chỉ đổi cột status có thật, KHÔNG có updated_at', async () => {
    const { prisma, updates } = fakePrisma();
    const { queue } = fakeQueue();
    const port = createEpicOpsWritePort(prisma, queue);

    await port.setStatus('AIRREGI-158183', 'BACKFILLING');

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      where: { epicKey: 'AIRREGI-158183' },
      data: { status: 'BACKFILLING' },
    });
    // `updated_at` là cột KHÔNG tồn tại từng làm Resync trả 500.
    expect(Object.keys(updates[0]!.data)).not.toContain('updated_at');
  });

  it('ghi được mọi trạng thái vòng đời mà không văng lỗi', async () => {
    const { prisma, updates } = fakePrisma();
    const { queue } = fakeQueue();
    const port = createEpicOpsWritePort(prisma, queue);

    const statuses: TrackedEpicStatus[] = ['PENDING', 'BACKFILLING', 'ACTIVE', 'PAUSED', 'ERROR'];
    for (const s of statuses) await port.setStatus('PAY-1', s);

    expect(updates.map((u) => u.data.status)).toEqual(statuses);
  });
});

describe('createEpicOpsWritePort.enqueueSync — hợp đồng hàng đợi', () => {
  it('đẩy job sync-epic kèm ĐỦ from/to/full, jobId dùng `__` (BullMQ cấm `:`)', async () => {
    const { prisma } = fakePrisma();
    const { queue, added } = fakeQueue();
    const port = createEpicOpsWritePort(prisma, queue);

    const jobId = await port.enqueueSync('AIRREGI-158183', {
      from: '2026-03-01',
      to: '2026-03-11',
      full: false,
    });

    expect(added).toHaveLength(1);
    expect(added[0]!.name).toBe(SYNC_JOB_NAME);
    expect(added[0]!.data).toEqual({
      epicKey: 'AIRREGI-158183',
      from: '2026-03-01',
      to: '2026-03-11',
      full: false,
    });
    expect(jobId).toBe(added[0]!.opts?.jobId);
    // Chống trùng job theo Epic, và KHÔNG được chứa `:` (BullMQ ném lỗi ngay).
    expect(jobId).toBe(`${SYNC_JOB_NAME}__AIRREGI-158183`);
    expect(jobId).not.toContain(':');
  });
});
