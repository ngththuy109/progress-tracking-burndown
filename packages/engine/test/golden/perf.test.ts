import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadInput, runFixture } from '../helpers/load-fixture.js';

/**
 * Đo hiệu năng trên GD-09 — 500 Sub-task, 5000 bản ghi log giờ.
 *
 * Ngưỡng nằm ở `test/perf-baseline.json` và được ĐỌC vào chứ không GHI ra. Cho
 * test tự ghi lại số đo mỗi lần chạy nghe thì tiện, nhưng như vậy ngưỡng sẽ tự
 * nới theo mỗi lần code chậm đi — tức là không còn ngưỡng nào cả.
 */

interface Baseline {
  readonly maxDurationMs: number;
  readonly maxHeapGrowthMb: number;
}

const baseline = JSON.parse(
  readFileSync(fileURLToPath(new URL('../perf-baseline.json', import.meta.url)), 'utf8'),
) as Baseline;

const MB = 1024 * 1024;

describe('GD-09 — hiệu năng', () => {
  it(`chạy dưới ${baseline.maxDurationMs / 1000} giây với 500 Sub-task và 5000 worklog`, () => {
    const input = loadInput('GD-09');

    // Chạy một lượt "làm nóng" trước khi đo: lượt đầu tiên gánh cả chi phí biên
    // dịch JIT, đo nó sẽ ra một con số không phản ánh lúc chạy thật.
    runFixture(input);

    const startedAt = performance.now();
    const result = runFixture(input) as { snapshots: readonly unknown[] };
    const durationMs = performance.now() - startedAt;

    console.log(`[GD-09] thời gian: ${durationMs.toFixed(0)}ms (ngưỡng ${baseline.maxDurationMs}ms)`);

    expect(result.snapshots).toHaveLength(2);
    expect(durationMs).toBeLessThan(baseline.maxDurationMs);
  });

  it(`dùng dưới ${baseline.maxHeapGrowthMb}MB bộ nhớ`, () => {
    const input = loadInput('GD-09');
    runFixture(input);

    const before = process.memoryUsage().heapUsed;
    runFixture(input);
    const growthMb = (process.memoryUsage().heapUsed - before) / MB;

    console.log(
      `[GD-09] bộ nhớ tăng thêm: ${growthMb.toFixed(1)}MB (ngưỡng ${baseline.maxHeapGrowthMb}MB)`,
    );

    // Đây là phép đo THÔ: không gọi được bộ dọn rác nên con số có thể lẫn cả
    // rác chưa dọn của lượt trước. Đủ để bắt rò rỉ nghiêm trọng — ví dụ engine
    // vô tình giữ lại toàn bộ worklog của mọi ngày — chứ không đủ để soi vài MB.
    expect(growthMb).toBeLessThan(baseline.maxHeapGrowthMb);
  });

  it('fixture đúng là 500 Sub-task và 5000 worklog như card yêu cầu', () => {
    // Không có test này thì có người rút fixture xuống còn 5 Sub-task cho nhanh,
    // và bài đo hiệu năng biến thành một bài đo không đo gì cả.
    const input = loadInput('GD-09') as { subtasks: readonly { worklogs?: readonly unknown[] }[] };
    expect(input.subtasks).toHaveLength(500);
    const worklogs = input.subtasks.reduce((n, s) => n + (s.worklogs?.length ?? 0), 0);
    expect(worklogs).toBe(5000);
  });
});
