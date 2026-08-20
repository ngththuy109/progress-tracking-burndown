import {
  exceedsDriftThreshold,
  type IssueTotals,
  type ReconcileResult,
  type ReconcileRunRecord,
} from '@app/shared';
import { compareTotals } from '@app/engine';

/**
 * Đối soát MỘT Epic với Jira — PRD E-18, chạy 03:00 Chủ nhật.
 *
 * NGUYÊN TẮC KIẾN TRÚC: job này CHỈ ĐỌC và CHỈ ĐẨY JOB. Nó không sửa một dòng
 * số liệu nào. Việc sửa thuộc về pipeline đồng bộ (T-11) — có hai đường ghi dữ
 * liệu thì sẽ có ngày chúng mâu thuẫn nhau, và lúc đó không ai biết tin bên nào.
 */

export interface ReconcileReadPort {
  /**
   * Tổng giờ đã log của từng Sub-task theo database.
   *
   * PHẢI loại `removed_at IS NOT NULL` và `is_deleted = true`. Đếm worklog đã
   * xoá vào tổng sẽ tạo lệch giả mỗi tuần, cảnh báo kêu liên tục mà không có gì
   * sai, và sau vài tuần sẽ không ai đọc nó nữa (E-17).
   */
  dbTotals(epicKey: string): Promise<readonly IssueTotals[]>;
}

export interface ReconcileJiraPort {
  /**
   * Tổng giờ theo Jira, lấy bằng MỘT lần tìm kiếm gộp lô.
   *
   * Gọi từng issue một sẽ biến job này thành thứ tốn hạn mức nhất hệ thống:
   * mỗi tuần 50 Epic × 500 Sub-task.
   */
  jiraTotals(epicKey: string): Promise<readonly IssueTotals[]>;
}

export interface ReconcileWritePort {
  /** Ghi lại kết quả để theo dõi xu hướng. KHÔNG phải ghi số liệu nghiệp vụ. */
  recordRun(record: ReconcileRunRecord): Promise<void>;
  /** Đẩy job chạy bù toàn bộ. Đây là hành động DUY NHẤT job này gây ra. */
  enqueueFullBackfill(epicKey: string): Promise<void>;
}

export interface ReconcileDeps {
  readonly reads: ReconcileReadPort;
  readonly jira: ReconcileJiraPort;
  readonly writes: ReconcileWritePort;
  readonly now: () => Date;
  /** Phát sự kiện cảnh báo. T-27 nối vào Slack/email; card này chỉ phát ra. */
  readonly onAlert?: (event: { level: 'P2'; code: string; message: string; epicKey: string }) => void;
  readonly log?: (event: Record<string, unknown>) => void;
}

export interface ReconcileOutcome {
  readonly epicKey: string;
  readonly result: ReconcileResult;
  readonly backfillQueued: boolean;
}

export async function reconcileEpic(
  deps: ReconcileDeps,
  epicKey: string,
  options: { readonly dryRun?: boolean } = {},
): Promise<ReconcileOutcome> {
  const [db, jira] = await Promise.all([deps.reads.dbTotals(epicKey), deps.jira.jiraTotals(epicKey)]);
  const result = compareTotals(db, jira);

  const exceeded = exceedsDriftThreshold(result.driftRatio);
  // `dryRun` phục vụ lệnh chạy tay: in ra rồi thôi. Runbook cố ý bắt người vận
  // hành thêm cờ `--fix` mới cho tự chạy bù — backfill toàn bộ mất vài phút và
  // chiếm hạn mức Jira của cả hệ thống.
  const backfillQueued = exceeded && options.dryRun !== true;

  if (backfillQueued) {
    await deps.writes.enqueueFullBackfill(epicKey);
    deps.onAlert?.({
      level: 'P2',
      code: 'DATA_DRIFT',
      epicKey,
      message:
        `Epic ${epicKey} is off by ${(result.driftRatio * 100).toFixed(2)}% versus Jira ` +
        `(DB ${hours(result.totalDbS)}h, Jira ${hours(result.totalJiraS)}h, ` +
        `${result.perIssue.length} issues differ). A full catch-up job was queued automatically.`,
    });
  }

  if (options.dryRun !== true) {
    await deps.writes.recordRun({
      epicKey,
      checkedAt: deps.now(),
      driftRatio: result.driftRatio,
      totalDbS: result.totalDbS,
      totalJiraS: result.totalJiraS,
      driftCount: result.perIssue.length,
      backfillQueued,
    });
  }

  deps.log?.({
    event: 'reconcile.done',
    correlationId: epicKey,
    driftRatio: result.driftRatio,
    driftCount: result.perIssue.length,
    backfillQueued,
  });

  return { epicKey, result, backfillQueued };
}

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(1);
}

/**
 * Đối soát nhiều Epic.
 *
 * MỘT EPIC LỖI KHÔNG ĐƯỢC LÀM SẬP CẢ LƯỢT. Sập giữa chừng thì 49 Epic còn lại
 * không được đối soát, mà job vẫn báo "đã chạy" nên không ai nhận ra.
 */
export interface SweepOutcome {
  readonly checked: number;
  readonly queued: number;
  readonly failed: readonly { epicKey: string; message: string }[];
}

export async function reconcileAll(
  deps: ReconcileDeps,
  epicKeys: readonly string[],
): Promise<SweepOutcome> {
  const failed: { epicKey: string; message: string }[] = [];
  let checked = 0;
  let queued = 0;

  for (const epicKey of epicKeys) {
    try {
      const outcome = await reconcileEpic(deps, epicKey);
      checked += 1;
      if (outcome.backfillQueued) queued += 1;
    } catch (err) {
      failed.push({ epicKey, message: err instanceof Error ? err.message : String(err) });
      deps.log?.({ event: 'reconcile.failed', correlationId: epicKey, message: String(err) });
    }
  }

  return { checked, queued, failed };
}
