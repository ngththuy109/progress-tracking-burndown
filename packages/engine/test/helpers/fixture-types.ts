import type { DateOnly, StatusCategory } from '@app/shared';

/**
 * Hình dạng của `input.json` trong mỗi thư mục golden dataset.
 *
 * Nguyên tắc: fixture phải ĐỌC ĐƯỢC BẰNG MẮT. Thời điểm ghi bằng chuỗi ISO chứ
 * không bằng số mili-giây — `1773619200000` thì không ai kiểm tay được, còn
 * `2026-03-13T09:00:00+07:00` thì đọc là hiểu ngay.
 */

export interface FixtureChangelog {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
  /** Chuỗi ISO 8601 có múi giờ. */
  readonly at: string;
}

export interface FixtureWorklog {
  readonly id: string;
  readonly seconds: number;
  /** Lấy từ trường `started` của Jira, KHÔNG phải `created`. */
  readonly started: string;
  readonly deleted?: boolean;
}

export interface FixtureSubtask {
  readonly key: string;
  readonly phaseCode: string;
  readonly originalEstimateSeconds: number;
  readonly createdAt: string;
  readonly removedAt?: string | null;
  readonly wbsStartDate?: string | null;
  readonly wbsEndDate?: string | null;
  readonly changelog?: readonly FixtureChangelog[];
  readonly worklogs?: readonly FixtureWorklog[];
}

export interface FixtureCalendar {
  readonly timezone: string;
  /** Mặc định T2–T6 (31). */
  readonly workdaysMask?: number;
  readonly hoursPerDay?: number;
  readonly holidays?: readonly string[];
}

/** Golden dataset kiểu "dựng lại Burndown" — GD-01 → GD-18. */
export interface BurndownFixture {
  readonly id: string;
  readonly kind: 'burndown';
  readonly title: string;
  /**
   * BẮT BUỘC. Engine không được đọc đồng hồ, nên "hôm nay" phải nằm trong
   * fixture. Meta-test quét cả thư mục để bắt fixture nào quên trường này.
   */
  readonly asOfDate: DateOnly;
  readonly epicKey: string;
  readonly calendar: FixtureCalendar;
  /** Tra `status_id` (số, lấy từ changelog) sang nhóm trạng thái. */
  readonly statusIds: Readonly<Record<string, StatusCategory>>;
  readonly sourceReadAt: string;
  readonly snapshotRange: { readonly from: DateOnly; readonly to: DateOnly };
  readonly subtasks: readonly FixtureSubtask[];
  /** Rollup của lần chạy trước, để kiểm phát hiện dịch chuyển kế hoạch. */
  readonly previousRollups?: readonly {
    readonly phaseCode: string;
    readonly planStart: DateOnly | null;
    readonly planEnd: DateOnly | null;
  }[];
}

/** Golden dataset kiểu "phân tách tiêu đề" — GD-19. */
export interface ParseFixture {
  readonly id: string;
  readonly kind: 'parse';
  readonly title: string;
  readonly asOfDate: DateOnly;
  readonly config: {
    readonly titlePatterns: readonly string[];
    readonly subtaskPatterns: readonly string[];
    readonly fallbackScanFullTitle: boolean;
    readonly phaseCodes: readonly string[];
    readonly rules: readonly {
      readonly keyword: string;
      readonly matchMode: 'CONTAINS' | 'REGEX';
      readonly phaseCode: string;
      readonly matchPriority: number;
    }[];
    readonly taskColumns: readonly string[];
  };
  readonly tasks: readonly { readonly key: string; readonly title: string }[];
  readonly subtasks: readonly {
    readonly key: string;
    readonly title: string;
    readonly parentPhaseCode: string;
  }[];
}

/** Golden dataset kiểu "cây quyết định Signboard" — GD-20. */
export interface SignboardFixture {
  readonly id: string;
  readonly kind: 'signboard';
  readonly title: string;
  readonly asOfDate: DateOnly;
  readonly cells: readonly {
    readonly name: string;
    readonly tickets: readonly {
      readonly issueKey: string;
      readonly statusCategory: StatusCategory;
      readonly planStart: DateOnly | null;
      readonly planEnd: DateOnly | null;
      readonly actualStart: DateOnly | null;
      readonly actualEnd: DateOnly | null;
    }[];
  }[];
}

/** Golden dataset kiểu "kế thừa cấu hình theo project" — GD-14. */
export interface InheritFixture {
  readonly id: string;
  readonly kind: 'inherit';
  readonly title: string;
  readonly asOfDate: DateOnly;
  readonly globalConfig: {
    readonly fallbackScanFullTitle: boolean;
    readonly titlePatterns: readonly string[];
    readonly subtaskPatterns: readonly string[];
    readonly phaseCodes: readonly string[];
    readonly ruleKeywords: readonly { readonly keyword: string; readonly phaseCode: string }[];
    readonly taskColumns: readonly string[];
  };
  /** `null` = project chưa có bộ riêng nào. */
  readonly projectConfig:
    | (Partial<InheritFixture['globalConfig']> & { readonly projectKey: string })
    | null;
  readonly projectKey: string;
  readonly globalVersion: number;
  readonly projectVersion: number | null;
}

export type GoldenFixture = BurndownFixture | ParseFixture | SignboardFixture | InheritFixture;
