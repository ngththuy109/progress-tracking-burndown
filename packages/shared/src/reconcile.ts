/**
 * Đối soát dữ liệu với Jira — PRD E-18.
 *
 * Đây là lưới an toàn cho một loại lỗi KHÔNG CÓ TRIỆU CHỨNG: dữ liệu lệch dần.
 * Biểu đồ vẫn vẽ, số vẫn hợp lý, chỉ là sai — và không có gì phát hiện được,
 * trừ việc mỗi tuần đi so lại với nguồn.
 */

/** Ba loại lệch, mỗi loại một nguyên nhân và một cách xử lý khác nhau. */
export const DRIFT_KIND = ['MISSING_IN_DB', 'MISSING_IN_JIRA', 'VALUE_DIFFERS'] as const;
export type DriftKind = (typeof DRIFT_KIND)[number];

export interface IssueTotals {
  readonly issueKey: string;
  readonly timeSpentS: number;
  readonly originalEstimateS: number;
}

export interface IssueDrift {
  readonly issueKey: string;
  readonly kind: DriftKind;
  /** `null` khi phía đó không có issue này. */
  readonly dbS: number | null;
  readonly jiraS: number | null;
}

export interface ReconcileResult {
  /** `|tổng DB − tổng Jira| / tổng Jira`. Tổng Jira bằng 0 thì trả 0. */
  readonly driftRatio: number;
  readonly totalDbS: number;
  readonly totalJiraS: number;
  readonly perIssue: readonly IssueDrift[];
}

/**
 * Ngưỡng cảnh báo P2 — PRD §10.4.
 *
 * Lệch **hơn** 0,5% mới vượt ngưỡng. Đúng 0,5% thì chưa — biên phải rõ ràng để
 * hai lần chạy trên cùng dữ liệu không cho hai kết luận khác nhau.
 */
export const DRIFT_THRESHOLD = 0.005;

export function exceedsDriftThreshold(driftRatio: number): boolean {
  return driftRatio > DRIFT_THRESHOLD;
}

export interface ReconcileRunRecord {
  readonly epicKey: string;
  readonly checkedAt: Date;
  readonly driftRatio: number;
  readonly totalDbS: number;
  readonly totalJiraS: number;
  readonly driftCount: number;
  readonly backfillQueued: boolean;
}
