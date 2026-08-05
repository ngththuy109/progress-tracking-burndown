import { describe, expect, it, vi } from 'vitest';
import { compareTotals } from '@app/engine';
import { DRIFT_THRESHOLD, exceedsDriftThreshold, type IssueTotals, type ReconcileRunRecord } from '@app/shared';
import {
  reconcileAll,
  reconcileEpic,
  type ReconcileDeps,
  type ReconcileOutcome,
} from './reconcile-epic.job.js';

const t = (issueKey: string, timeSpentS: number, originalEstimateS = 28_800): IssueTotals => ({
  issueKey,
  timeSpentS,
  originalEstimateS,
});

// ---------------------------------------------------------------------------
// So sánh — hàm thuần của engine
// ---------------------------------------------------------------------------

describe('compareTotals', () => {
  it('dữ liệu khớp hoàn toàn cho tỉ lệ lệch bằng 0', () => {
    const rows = [t('PAY-11', 7200), t('PAY-12', 14_400)];
    const r = compareTotals(rows, rows);

    expect(r.driftRatio).toBe(0);
    expect(r.perIssue).toEqual([]);
  });

  it('Jira có issue mà DB không có được đánh dấu MISSING_IN_DB', () => {
    // Nguyên nhân thường gặp: đồng bộ tăng dần bỏ sót vì lệch đồng hồ.
    const r = compareTotals([t('PAY-11', 7200)], [t('PAY-11', 7200), t('PAY-12', 3600)]);

    expect(r.perIssue).toEqual([
      { issueKey: 'PAY-12', kind: 'MISSING_IN_DB', dbS: null, jiraS: 3600 },
    ]);
  });

  it('DB có issue mà Jira không có được đánh dấu MISSING_IN_JIRA', () => {
    // Nguyên nhân khác hẳn: issue bị xoá hoặc chuyển Epic mà chưa đánh dấu.
    const r = compareTotals([t('PAY-11', 7200), t('PAY-99', 3600)], [t('PAY-11', 7200)]);

    expect(r.perIssue).toEqual([
      { issueKey: 'PAY-99', kind: 'MISSING_IN_JIRA', dbS: 3600, jiraS: null },
    ]);
  });

  it('cùng issue nhưng số giờ khác nhau được đánh dấu VALUE_DIFFERS', () => {
    const r = compareTotals([t('PAY-11', 7200)], [t('PAY-11', 10_800)]);

    expect(r.perIssue).toEqual([
      { issueKey: 'PAY-11', kind: 'VALUE_DIFFERS', dbS: 7200, jiraS: 10_800 },
    ]);
  });

  it('ba loại lệch được PHÂN BIỆT chứ không gộp thành một con số', () => {
    // Gộp lại sẽ làm mất đúng thông tin cần nhất để chẩn đoán.
    const r = compareTotals(
      [t('A', 100), t('B', 200), t('D', 400)],
      [t('A', 100), t('B', 999), t('C', 300)],
    );

    expect(r.perIssue.map((d) => `${d.issueKey}:${d.kind}`)).toEqual([
      'B:VALUE_DIFFERS',
      'C:MISSING_IN_DB',
      'D:MISSING_IN_JIRA',
    ]);
  });

  it('tỉ lệ lệch tính trên TỔNG, không phải trung bình chênh lệch từng issue', () => {
    // 500 issue khớp, một issue lệch 3600 giây. Tổng Jira = 500×3600 + 7200.
    const db = Array.from({ length: 500 }, (_, i) => t(`K-${i}`, 3600));
    const jira = [...db.slice(0, 499), t('K-499', 7200)];

    const r = compareTotals(db, jira);

    expect(r.totalDbS).toBe(1_800_000);
    expect(r.totalJiraS).toBe(1_803_600);
    expect(r.driftRatio).toBeCloseTo(3600 / 1_803_600, 10);
    // Trung bình từng issue sẽ cho ra một con số lớn hơn nhiều.
    expect(r.driftRatio).toBeLessThan(0.005);
  });

  it('tổng Jira bằng 0 thì KHÔNG chia cho 0', () => {
    // Epic vừa thêm vào, chưa ai log giờ — xảy ra ngay tuần đầu tiên.
    const r = compareTotals([], []);
    expect(r.driftRatio).toBe(0);
    expect(Number.isFinite(r.driftRatio)).toBe(true);
  });

  it('so sánh trên GIÂY, không làm tròn sang giờ', () => {
    // 3599 và 3600 giây đều thành "1 giờ" nếu làm tròn — và lệch biến mất.
    const r = compareTotals([t('PAY-11', 3599)], [t('PAY-11', 3600)]);
    expect(r.perIssue).toHaveLength(1);
  });
});

describe('ngưỡng cảnh báo', () => {
  it('đúng 0,5% CHƯA vượt ngưỡng — biên phải rõ ràng', () => {
    expect(exceedsDriftThreshold(DRIFT_THRESHOLD)).toBe(false);
    expect(exceedsDriftThreshold(0.0049)).toBe(false);
    expect(exceedsDriftThreshold(0.0051)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

interface Harness {
  readonly deps: ReconcileDeps;
  readonly records: ReconcileRunRecord[];
  readonly backfills: string[];
  readonly alerts: { code: string; message: string }[];
  readonly failFor: Set<string>;
}

function harness(db: readonly IssueTotals[], jira: readonly IssueTotals[]): Harness {
  const records: ReconcileRunRecord[] = [];
  const backfills: string[] = [];
  const alerts: { code: string; message: string }[] = [];
  const failFor = new Set<string>();

  return {
    records,
    backfills,
    alerts,
    failFor,
    deps: {
      reads: {
        dbTotals: async (epicKey) => {
          if (failFor.has(epicKey)) throw new Error(`Không đọc được ${epicKey}`);
          return db;
        },
      },
      jira: { jiraTotals: async () => jira },
      writes: {
        recordRun: async (r) => {
          records.push(r);
        },
        enqueueFullBackfill: async (k) => {
          backfills.push(k);
        },
      },
      now: () => new Date('2026-03-08T03:00:00Z'),
      onAlert: (e) => alerts.push({ code: e.code, message: e.message }),
    },
  };
}

describe('đối soát một Epic', () => {
  it('lệch 0,4% thì KHÔNG đẩy chạy bù và KHÔNG cảnh báo', () => {
    const h = harness([t('A', 99_600)], [t('A', 100_000)]);
    return reconcileEpic(h.deps, 'PAY-1').then((out: ReconcileOutcome) => {
      expect(out.result.driftRatio).toBeCloseTo(0.004, 10);
      expect(out.backfillQueued).toBe(false);
      expect(h.backfills).toEqual([]);
      expect(h.alerts).toEqual([]);
    });
  });

  it('lệch 0,6% thì đẩy chạy bù toàn bộ và phát cảnh báo P2', async () => {
    const h = harness([t('A', 99_400)], [t('A', 100_000)]);
    const out = await reconcileEpic(h.deps, 'PAY-1');

    expect(out.backfillQueued).toBe(true);
    expect(h.backfills).toEqual(['PAY-1']);
    expect(h.alerts[0]?.code).toBe('DATA_DRIFT');
    expect(h.alerts[0]?.message).toContain('0.60%');
    expect(h.alerts[0]?.message).toContain('chạy bù');
  });

  it('luôn ghi lại kết quả để theo dõi xu hướng, kể cả khi không lệch', async () => {
    const h = harness([t('A', 100_000)], [t('A', 100_000)]);
    await reconcileEpic(h.deps, 'PAY-1');

    expect(h.records).toHaveLength(1);
    expect(h.records[0]?.driftRatio).toBe(0);
    expect(h.records[0]?.backfillQueued).toBe(false);
  });

  it('KHÔNG ghi số liệu nghiệp vụ — cổng ghi chỉ có hai việc', async () => {
    // Đối soát tự sửa số liệu là sai kiến trúc: có hai đường ghi thì sẽ có ngày
    // chúng mâu thuẫn nhau. Cổng `ReconcileWritePort` cố ý chỉ có `recordRun`
    // và `enqueueFullBackfill`; không có đường nào ghi giờ hay snapshot.
    const h = harness([t('A', 50_000)], [t('A', 100_000)]);
    await reconcileEpic(h.deps, 'PAY-1');

    const portMethods = Object.keys(h.deps.writes).sort();
    expect(portMethods).toEqual(['enqueueFullBackfill', 'recordRun']);
  });

  it('lệnh chạy tay KHÔNG tự đẩy chạy bù khi thiếu cờ --fix', async () => {
    // Runbook cố ý bắt người vận hành xác nhận: backfill toàn bộ mất vài phút
    // và chiếm hạn mức Jira của cả hệ thống.
    const h = harness([t('A', 50_000)], [t('A', 100_000)]);
    const out = await reconcileEpic(h.deps, 'PAY-1', { dryRun: true });

    expect(out.result.driftRatio).toBe(0.5);
    expect(out.backfillQueued).toBe(false);
    expect(h.backfills).toEqual([]);
    expect(h.records).toEqual([]);
  });

  it('gọi Jira đúng MỘT lần dù Epic có 500 Sub-task', async () => {
    // Gọi từng issue một biến job này thành thứ tốn hạn mức nhất hệ thống.
    const rows = Array.from({ length: 500 }, (_, i) => t(`K-${i}`, 3600));
    const jiraTotals = vi.fn(async () => rows);
    const h = harness(rows, rows);

    await reconcileEpic({ ...h.deps, jira: { jiraTotals } }, 'PAY-1');

    expect(jiraTotals).toHaveBeenCalledTimes(1);
  });
});

describe('đối soát cả lượt', () => {
  it('một Epic lỗi thì các Epic còn lại VẪN chạy tiếp', async () => {
    // Sập giữa chừng thì 49 Epic còn lại không được đối soát, mà job vẫn báo
    // "đã chạy" nên không ai nhận ra.
    const h = harness([t('A', 100_000)], [t('A', 100_000)]);
    h.failFor.add('PAY-2');

    const out = await reconcileAll(h.deps, ['PAY-1', 'PAY-2', 'PAY-3']);

    expect(out.checked).toBe(2);
    expect(out.failed).toEqual([{ epicKey: 'PAY-2', message: 'Không đọc được PAY-2' }]);
  });

  it('đếm đúng số Epic đã đẩy chạy bù', async () => {
    const h = harness([t('A', 50_000)], [t('A', 100_000)]);
    const out = await reconcileAll(h.deps, ['PAY-1', 'PAY-2']);

    expect(out.queued).toBe(2);
    expect(h.backfills).toEqual(['PAY-1', 'PAY-2']);
  });

  it('danh sách rỗng không ném lỗi', async () => {
    const h = harness([], []);
    expect(await reconcileAll(h.deps, [])).toEqual({ checked: 0, queued: 0, failed: [] });
  });
});
