/**
 * Mười một ngưỡng cảnh báo — PRD §10.4.
 *
 * Bảng này là bản đầy đủ, KHÔNG được bớt. Mỗi mã ứng đúng một dòng trong PRD.
 *
 * BA MỨC CÓ BA ĐƯỜNG ĐI KHÁC NHAU: P1 gọi người dậy lúc nửa đêm, P3 chỉ hiện
 * banner trên giao diện. Trộn lẫn thì hoặc là làm phiền vì chuyện không gấp,
 * hoặc là bỏ sót chuyện gấp.
 */

export const ALERT_CODE = [
  'JOB_FAILED',
  'SNAPSHOT_MISSING',
  'RATE_LIMIT_HIGH',
  'DATA_DRIFT',
  'API_SLOW',
  'PLAN_SHIFT_HIGH',
  'EPIC_STUCK_ERROR',
  'DIRTY_PHASE_DATA',
  'MISSING_ESTIMATE',
  'MISSING_WBS_DATE',
  'UNPARSED_SUBTASK',
] as const;
export type AlertCode = (typeof ALERT_CODE)[number];

export const ALERT_LEVEL = ['P1', 'P2', 'P3'] as const;
export type AlertLevel = (typeof ALERT_LEVEL)[number];

export const ALERT_CHANNEL = ['SLACK', 'EMAIL', 'BANNER'] as const;
export type AlertChannelName = (typeof ALERT_CHANNEL)[number];

export interface AlertSpec {
  readonly level: AlertLevel;
  readonly channels: readonly AlertChannelName[];
  /** Nhãn tiếng Việt hiện trong Slack, email và trên banner. */
  readonly title: string;
}

/** Cột "Mức" và "Gửi tới" của bảng PRD §10.4, chép nguyên. */
export const ALERT_SPEC: Readonly<Record<AlertCode, AlertSpec>> = {
  JOB_FAILED: { level: 'P1', channels: ['SLACK', 'EMAIL'], title: 'Job đêm thất bại' },
  SNAPSHOT_MISSING: { level: 'P1', channels: ['SLACK'], title: 'Thiếu snapshot' },
  RATE_LIMIT_HIGH: { level: 'P2', channels: ['SLACK'], title: 'Bị Jira chặn nhiều lần' },
  DATA_DRIFT: { level: 'P2', channels: ['SLACK', 'EMAIL'], title: 'Dữ liệu lệch so với Jira' },
  API_SLOW: { level: 'P2', channels: ['SLACK'], title: 'API chậm' },
  PLAN_SHIFT_HIGH: { level: 'P2', channels: ['SLACK', 'EMAIL'], title: 'Kế hoạch bị lùi nhiều' },
  EPIC_STUCK_ERROR: { level: 'P2', channels: ['SLACK'], title: 'Epic kẹt ở trạng thái lỗi' },
  DIRTY_PHASE_DATA: { level: 'P3', channels: ['EMAIL'], title: 'Nhiều Task chưa phân loại' },
  MISSING_ESTIMATE: { level: 'P3', channels: ['BANNER'], title: 'Nhiều Sub-task thiếu ước lượng' },
  MISSING_WBS_DATE: { level: 'P3', channels: ['BANNER', 'EMAIL'], title: 'Nhiều Sub-task thiếu ngày kế hoạch' },
  UNPARSED_SUBTASK: { level: 'P3', channels: ['BANNER', 'EMAIL'], title: 'Nhiều Sub-task đặt tên sai định dạng' },
};

/**
 * Khoảng lặng giữa hai lần gửi CÙNG một cảnh báo cho CÙNG một Epic.
 *
 * Cảnh báo sai còn tệ hơn không có cảnh báo: ngưỡng kêu liên tục sẽ bị tắt
 * tiếng, và lúc có chuyện thật thì không ai đọc.
 */
export const ALERT_COOLDOWN_SECONDS: Readonly<Record<AlertLevel, number>> = {
  P1: 60 * 60,
  P2: 6 * 60 * 60,
  P3: 24 * 60 * 60,
};

export interface Alert {
  readonly code: AlertCode;
  readonly level: AlertLevel;
  /** `null` với cảnh báo mức hệ thống, ví dụ API chậm. */
  readonly epicKey: string | null;
  /** Câu tiếng Việt nói cả điều gì sai lẫn làm gì tiếp (C-9). */
  readonly message: string;
  /** Số đo đã kích hoạt ngưỡng, để người trực đối chiếu. */
  readonly value: number;
  readonly threshold: number;
}
