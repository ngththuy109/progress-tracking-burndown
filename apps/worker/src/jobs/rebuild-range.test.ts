import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKDAYS_MASK,
  InvalidJobPayloadError,
  parseSyncJobPayload,
  type WorkCalendar,
} from '@app/shared';
import {
  INCREMENTAL_REBUILD_DAYS,
  RebuildRangeError,
  resolveRebuildRange,
  type RebuildRangeInput,
} from './rebuild-range.js';
import { handleSyncJob, type SyncJobPorts } from './handle-sync-job.js';
import type { ReconstructOutcome } from './reconstruct-epic.job.js';

const EPIC = 'PAY-100';
const TZ = 'Asia/Ho_Chi_Minh';

const CAL: WorkCalendar = {
  calendarId: 'VN_STANDARD',
  timezone: TZ,
  workdaysMask: DEFAULT_WORKDAYS_MASK,
  hoursPerDay: 8,
  holidays: new Set<string>(),
  warnings: [],
};

// ---------------------------------------------------------------------------
// Kiểm nội dung job
// ---------------------------------------------------------------------------

describe('nội dung job sync-epic', () => {
  it('chỉ có epicKey thì là đồng bộ TĂNG DẦN — quyết định có chủ ý', () => {
    // Job đêm chỉ đẩy mỗi `epicKey`, và tăng dần đúng là thứ nó cần. Ghi ra đây
    // để lần sau ai đó đổi mặc định thì phải xoá test này chứ không đổi lặng lẽ.
    const p = parseSyncJobPayload({ epicKey: EPIC });
    expect(p).toEqual({ epicKey: EPIC, from: null, to: null, full: false });
  });

  it('chuỗi "true" bị TỪ CHỐI, không bị hiểu thành true hay false', () => {
    // Đây là lỗi gõ tay phổ biến nhất khi dán lệnh curl từ runbook. Ép kiểu ngầm
    // sẽ biến cả chuỗi "false" thành true — im lặng và ngược hẳn ý người gõ.
    expect(() => parseSyncJobPayload({ epicKey: EPIC, full: 'true' })).toThrow(
      InvalidJobPayloadError,
    );
    expect(() => parseSyncJobPayload({ epicKey: EPIC, full: 'false' })).toThrow(
      InvalidJobPayloadError,
    );
    expect(() => parseSyncJobPayload({ epicKey: EPIC, full: 1 })).toThrow(InvalidJobPayloadError);
  });

  it('thông báo lỗi nói rõ trường nào sai và phải làm gì', () => {
    const err = (() => {
      try {
        parseSyncJobPayload({ epicKey: EPIC, full: 'true' });
        return null;
      } catch (e) {
        return e as InvalidJobPayloadError;
      }
    })();

    expect(err?.message).toContain('full');
    expect(err?.message).toContain('Remove that job from the queue');
  });

  it('ngày sai định dạng bị từ chối kèm ví dụ đúng', () => {
    const err = (() => {
      try {
        parseSyncJobPayload({ epicKey: EPIC, from: '11/03/2026' });
        return null;
      } catch (e) {
        return e as InvalidJobPayloadError;
      }
    })();

    expect(err).toBeInstanceOf(InvalidJobPayloadError);
    expect(err?.message).toContain('YYYY-MM-DD');
  });

  it('thiếu epicKey thì ném lỗi, không lấy chuỗi rỗng', () => {
    expect(() => parseSyncJobPayload({})).toThrow(InvalidJobPayloadError);
    expect(() => parseSyncJobPayload({ epicKey: '  ' })).toThrow(InvalidJobPayloadError);
  });

  it('job rỗng hoặc không phải object cũng bị từ chối', () => {
    expect(() => parseSyncJobPayload(null)).toThrow(InvalidJobPayloadError);
    expect(() => parseSyncJobPayload('PAY-100')).toThrow(InvalidJobPayloadError);
  });
});

// ---------------------------------------------------------------------------
// Chốt dải ngày
// ---------------------------------------------------------------------------

const input = (over: Partial<RebuildRangeInput> = {}): RebuildRangeInput => ({
  full: false,
  from: null,
  to: null,
  earliestDataDate: '2026-01-05',
  earliestMissingSnapshotDate: null,
  today: '2026-03-11',
  timezone: TZ,
  ...over,
});

describe('dải ngày dựng lại', () => {
  it('full = true dựng lại TỪ NGÀY SỚM NHẤT CÓ DỮ LIỆU tới hôm nay', () => {
    // Đây chính là điều runbook mục "Dựng lại lịch sử một Epic" hứa hẹn.
    const r = resolveRebuildRange(input({ full: true }));

    expect(r.from).toBe('2026-01-05');
    expect(r.to).toBe('2026-03-11');
    expect(r.scope).toBe('FULL');
    expect(r.notes).toEqual([]);
  });

  it('full = false chỉ dựng lại cửa sổ 7 ngày gần nhất', () => {
    const r = resolveRebuildRange(input());

    expect(r.from).toBe('2026-03-04');
    expect(r.to).toBe('2026-03-11');
    expect(r.scope).toBe('INCREMENTAL');
    expect(INCREMENTAL_REBUILD_DAYS).toBe(7);
  });

  it('cửa sổ lùi qua được đầu tháng', () => {
    const r = resolveRebuildRange(input({ today: '2026-03-05' }));
    expect(r.from).toBe('2026-02-26');
  });

  it('cửa sổ lùi qua được đầu năm', () => {
    const r = resolveRebuildRange(input({ today: '2026-01-03' }));
    expect(r.from).toBe('2025-12-27');
  });

  it('full = true nhưng Epic chưa có dữ liệu thì NÉM LỖI, không đoán bừa ngày', () => {
    const err = (() => {
      try {
        resolveRebuildRange(input({ full: true, earliestDataDate: null }));
        return null;
      } catch (e) {
        return e as RebuildRangeError;
      }
    })();

    expect(err).toBeInstanceOf(RebuildRangeError);
    // Nói cả điều sai lẫn hai cách khắc phục (C-9).
    expect(err?.message).toContain('chưa có dữ liệu');
    expect(err?.message).toContain('"from"');
  });

  it('ngày gõ tay được tôn trọng và thắng cả cờ full', () => {
    const r = resolveRebuildRange(input({ full: true, from: '2026-02-01', to: '2026-02-10' }));

    expect(r.from).toBe('2026-02-01');
    expect(r.to).toBe('2026-02-10');
    expect(r.scope).toBe('EXPLICIT');
  });

  it('chỉ gõ ngày đầu thì ngày cuối vẫn là hôm nay', () => {
    const r = resolveRebuildRange(input({ from: '2026-02-01' }));
    expect(r).toMatchObject({ from: '2026-02-01', to: '2026-03-11', scope: 'EXPLICIT' });
  });

  it('ngày cuối nằm ở tương lai bị kẹp về hôm nay VÀ được ghi chú', () => {
    // Snapshot ghi số liệu thực tế của một ngày. Dựng cho ngày chưa tới chỉ tạo
    // ra bản sao của hôm nay đội lốt tương lai.
    const r = resolveRebuildRange(input({ to: '2026-06-30' }));

    expect(r.to).toBe('2026-03-11');
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain('2026-06-30');
    expect(r.notes[0]).toContain('2026-03-11');
  });

  it('dải ngày ngược thì ném lỗi, KHÔNG tự đảo hai đầu', () => {
    // Đảo ngầm sẽ giấu mất lỗi ở chỗ gọi — cùng lý do với `listWorkdays`.
    expect(() => resolveRebuildRange(input({ from: '2026-03-10', to: '2026-03-01' }))).toThrow(
      RebuildRangeError,
    );
  });
});

describe('bù ngày thiếu snapshot — E-12', () => {
  it('ngày thiếu CŨ HƠN cửa sổ thì nới ngày đầu về tận đó', () => {
    // Không nới thì runbook mục SNAPSHOT_MISSING nói dối: nó bảo người trực bấm
    // "Đồng bộ lại" để vá lỗ thủng, mà lỗ thủng cũ hơn 7 ngày sẽ không bao giờ
    // được vá và cảnh báo P1 cứ kêu mãi.
    const r = resolveRebuildRange(input({ earliestMissingSnapshotDate: '2026-02-02' }));

    expect(r.from).toBe('2026-02-02');
    expect(r.notes[0]).toContain('E-12');
  });

  it('ngày thiếu NẰM TRONG cửa sổ thì giữ nguyên cửa sổ', () => {
    const r = resolveRebuildRange(input({ earliestMissingSnapshotDate: '2026-03-09' }));

    expect(r.from).toBe('2026-03-04');
    expect(r.notes).toEqual([]);
  });

  it('ngày gõ tay vẫn thắng: người vận hành biết mình cần gì', () => {
    const r = resolveRebuildRange(
      input({ from: '2026-03-10', earliestMissingSnapshotDate: '2026-01-01' }),
    );
    expect(r.from).toBe('2026-03-10');
  });
});

// ---------------------------------------------------------------------------
// Cả chuỗi: nội dung job → dải ngày → dựng lại
// ---------------------------------------------------------------------------

const OUTCOME: ReconstructOutcome = {
  status: 'DONE',
  epicKey: EPIC,
  daysComputed: 5,
  daysBackfilled: 0,
  snapshotsWritten: 5,
  snapshotsSkippedStale: 0,
  planShifts: 0,
  obsoleteRollupsRemoved: 0,
};

class FakePorts implements SyncJobPorts {
  readonly callOrder: string[] = [];
  readonly syncCalls: { epicKey: string; ignoreWatermark: boolean }[] = [];
  readonly rebuildCalls: { epicKey: string; from: string; to: string }[] = [];
  earliest: string | null = '2026-01-05';
  missing: string | null = null;

  async syncFromJira(epicKey: string, options: { ignoreWatermark: boolean }) {
    this.callOrder.push('syncFromJira');
    this.syncCalls.push({ epicKey, ignoreWatermark: options.ignoreWatermark });
  }

  async earliestDataDate() {
    this.callOrder.push('earliestDataDate');
    return this.earliest;
  }

  async earliestMissingSnapshotDate() {
    return this.missing;
  }

  async rebuild(args: { epicKey: string; from: string; to: string }) {
    this.callOrder.push('rebuild');
    this.rebuildCalls.push(args);
    return OUTCOME;
  }
}

const NOW = new Date('2026-03-11T00:01:00Z');
const run = (ports: FakePorts, payload: unknown, log?: (e: Record<string, unknown>) => void) =>
  handleSyncJob({ ports, calendar: CAL, now: () => NOW, ...(log ? { log } : {}) }, payload);

describe('bộ xử lý job sync-epic', () => {
  it('full = true đọc lại toàn bộ Jira RỒI dựng lại từ đầu', async () => {
    // Đây là bài kiểm chính của cả thay đổi: đúng lệnh trong runbook, đi hết
    // chuỗi, và ra một dải ngày phủ toàn bộ lịch sử.
    const ports = new FakePorts();

    const r = await run(ports, { epicKey: EPIC, full: true });

    expect(ports.syncCalls).toEqual([{ epicKey: EPIC, ignoreWatermark: true }]);
    expect(ports.rebuildCalls).toEqual([{ epicKey: EPIC, from: '2026-01-05', to: '2026-03-11' }]);
    expect(r.range.scope).toBe('FULL');
    expect(r.outcome).toBe(OUTCOME);
  });

  it('lượt thường ngày KHÔNG đọc lại toàn bộ Jira', async () => {
    // Đọc lại toàn bộ mỗi đêm là ~135 lần gọi thay vì ~15, nhân với 20 Epic thì
    // vượt hạn mức của cả tổ chức (R-04).
    const ports = new FakePorts();

    await run(ports, { epicKey: EPIC });

    expect(ports.syncCalls[0]?.ignoreWatermark).toBe(false);
    expect(ports.rebuildCalls[0]).toEqual({ epicKey: EPIC, from: '2026-03-04', to: '2026-03-11' });
  });

  it('đọc Jira TRƯỚC khi chốt dải ngày', async () => {
    // Chốt trước thì dải tính theo dữ liệu cũ, và phần lịch sử vừa lấy về nằm
    // ngoài dải — dựng xong vẫn thiếu đúng khúc mình đang đi tìm.
    const ports = new FakePorts();

    await run(ports, { epicKey: EPIC, full: true });

    expect(ports.callOrder).toEqual(['syncFromJira', 'earliestDataDate', 'rebuild']);
  });

  it('ghi dải ngày ra log ở MỌI lượt chạy', async () => {
    // Câu hỏi hay gặp nhất khi số liệu trông sai: "lần chạy vừa rồi dựng lại từ
    // ngày nào tới ngày nào?"
    const events: Record<string, unknown>[] = [];
    await run(new FakePorts(), { epicKey: EPIC, full: true }, (e) => events.push(e));

    const line = events.find((e) => e['event'] === 'rebuild.range');
    expect(line).toMatchObject({ epicKey: EPIC, scope: 'FULL', from: '2026-01-05' });
  });

  it('nội dung job sai thì DỪNG NGAY, không gọi Jira lần nào', async () => {
    const ports = new FakePorts();

    await expect(run(ports, { epicKey: EPIC, full: 'true' })).rejects.toBeInstanceOf(
      InvalidJobPayloadError,
    );
    expect(ports.callOrder).toEqual([]);
  });

  it('Epic chưa có dữ liệu mà đòi full thì lỗi rõ ràng, không dựng nhầm dải', async () => {
    const ports = new FakePorts();
    ports.earliest = null;

    await expect(run(ports, { epicKey: EPIC, full: true })).rejects.toBeInstanceOf(
      RebuildRangeError,
    );
    expect(ports.rebuildCalls).toEqual([]);
  });
});
