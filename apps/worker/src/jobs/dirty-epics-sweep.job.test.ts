import { describe, it, expect } from 'vitest';
import { sweepDirtyEpics, type DirtySweepPorts } from './dirty-epics-sweep.job.js';

/**
 * Kho giả mô phỏng set Redis + sổ theo dõi + hàng đợi. `failEnqueueFor` giả lập
 * hàng đợi từ chối đúng một số Epic, để kiểm chứng "một Epic hỏng không kéo cả
 * lượt xuống".
 */
class FakePorts implements DirtySweepPorts {
  readonly set: Set<string>;
  readonly tracked: Set<string>;
  readonly enqueued: string[] = [];
  readonly failEnqueueFor = new Set<string>();
  failTrackedOf = false;

  constructor(dirty: readonly string[], tracked: readonly string[]) {
    this.set = new Set(dirty);
    this.tracked = new Set(tracked);
  }

  takeAll(): Promise<readonly string[]> {
    const all = [...this.set].sort();
    this.set.clear();
    return Promise.resolve(all);
  }

  restore(epicKeys: readonly string[]): Promise<void> {
    for (const k of epicKeys) this.set.add(k);
    return Promise.resolve();
  }

  trackedOf(epicKeys: readonly string[]): Promise<ReadonlySet<string>> {
    if (this.failTrackedOf) return Promise.reject(new Error('DB không trả lời'));
    return Promise.resolve(new Set(epicKeys.filter((k) => this.tracked.has(k))));
  }

  enqueueFullBackfill(epicKey: string): Promise<void> {
    if (this.failEnqueueFor.has(epicKey)) {
      return Promise.reject(new Error(`Redis từ chối ${epicKey}`));
    }
    this.enqueued.push(epicKey);
    return Promise.resolve();
  }
}

describe('sweepDirtyEpics', () => {
  it('nhặt toàn bộ Epic trong set và đẩy job backfill toàn bộ cho từng Epic', async () => {
    const ports = new FakePorts(['PAY-100', 'PAY-200'], ['PAY-100', 'PAY-200']);

    const outcome = await sweepDirtyEpics({ ports });

    expect(ports.enqueued.sort()).toEqual(['PAY-100', 'PAY-200']);
    expect(outcome).toEqual({ taken: 2, queued: 2, dropped: [], restored: [] });
    expect(ports.set.size).toBe(0);
  });

  it('set rỗng thì không đẩy job nào và không chạm sổ theo dõi', async () => {
    const ports = new FakePorts([], []);
    ports.failTrackedOf = true; // nếu bị gọi sẽ ném lỗi → test đổ

    const outcome = await sweepDirtyEpics({ ports });

    expect(outcome.taken).toBe(0);
    expect(ports.enqueued).toEqual([]);
  });

  it('Epic không còn trong sổ theo dõi thì bỏ, KHÔNG trả về set', async () => {
    const ports = new FakePorts(['GONE-1', 'PAY-100'], ['PAY-100']);

    const outcome = await sweepDirtyEpics({ ports });

    expect(ports.enqueued).toEqual(['PAY-100']);
    expect(outcome.dropped).toEqual(['GONE-1']);
    // Trả GONE-1 về set là tự tạo vòng lặp vô hạn cho lượt sau.
    expect(ports.set.has('GONE-1')).toBe(false);
  });

  it('đẩy job thất bại cho MỘT Epic thì Epic đó về lại set, các Epic khác vẫn được đẩy', async () => {
    const ports = new FakePorts(['PAY-100', 'PAY-200', 'PAY-300'], ['PAY-100', 'PAY-200', 'PAY-300']);
    ports.failEnqueueFor.add('PAY-200');
    const events: Record<string, unknown>[] = [];

    const outcome = await sweepDirtyEpics({ ports, log: (e) => events.push(e) });

    expect(ports.enqueued.sort()).toEqual(['PAY-100', 'PAY-300']);
    expect(outcome.restored).toEqual(['PAY-200']);
    expect(ports.set.has('PAY-200')).toBe(true);
    expect(events.some((e) => e['event'] === 'dirty-sweep.enqueue-failed')).toBe(true);
  });

  it('lỗi ngoài dự kiến thì trả MỌI key chưa đẩy về set rồi mới ném tiếp', async () => {
    const ports = new FakePorts(['PAY-100', 'PAY-200'], ['PAY-100', 'PAY-200']);
    ports.failTrackedOf = true;

    await expect(sweepDirtyEpics({ ports })).rejects.toThrow('DB không trả lời');

    // Không trả lại thì yêu cầu tính lại mất vĩnh viễn — snapshot quá khứ sai
    // mà không ai biết.
    expect([...ports.set].sort()).toEqual(['PAY-100', 'PAY-200']);
  });

  it('ghi log tổng kết một dòng cho mỗi lượt quét có việc', async () => {
    const ports = new FakePorts(['PAY-100'], ['PAY-100']);
    const events: Record<string, unknown>[] = [];

    await sweepDirtyEpics({ ports, log: (e) => events.push(e) });

    const done = events.find((e) => e['event'] === 'dirty-sweep.done');
    expect(done).toMatchObject({ taken: 1, queued: 1, dropped: 0, restored: 0 });
  });
});
