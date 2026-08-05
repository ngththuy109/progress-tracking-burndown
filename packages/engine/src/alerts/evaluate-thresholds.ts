import { ALERT_SPEC, type Alert, type AlertCode } from '@app/shared';

/**
 * Đánh giá 11 ngưỡng cảnh báo — PRD §10.4.
 *
 * HÀM THUẦN, KHÔNG ĐỌC ĐỒNG HỒ. Hai ngưỡng phụ thuộc thời điểm (thiếu snapshot
 * sau 02:00, Epic kẹt lỗi quá 24 giờ) đều nhận "bây giờ" qua tham số. Đọc đồng
 * hồ ở đây sẽ làm test xanh hôm nay và đỏ tuần sau (C-12).
 */

/**
 * Ngưỡng là HẰNG SỐ CÓ TÊN, không phải số rải rác trong code.
 *
 * Người vận hành cần nới một ngưỡng thì phải tìm được nó ở đúng một chỗ và thấy
 * ngay nó đang là bao nhiêu.
 */
export const THRESHOLDS = {
  RATE_LIMIT_PER_DAY: 10,
  DATA_DRIFT_RATIO: 0.005,
  API_P95_MS: 2000,
  PLAN_SHIFT_RATIO: 0.2,
  EPIC_ERROR_HOURS: 24,
  UNCLASSIFIED_RATIO: 0.2,
  MISSING_ESTIMATE_RATIO: 0.1,
  MISSING_WBS_RATIO: 0.1,
  UNPARSED_SUBTASK_RATIO: 0.3,
  /** Sau giờ này mà còn thiếu snapshot của hôm qua thì job đêm đã hỏng. */
  SNAPSHOT_DEADLINE_HOUR: 2,
} as const;

/**
 * Số liệu đầu vào.
 *
 * `undefined` nghĩa là CHƯA ĐO ĐƯỢC, khác hẳn 0. Thiếu số liệu thì KHÔNG phát
 * cảnh báo và cũng KHÔNG coi là OK (C-10) — báo "mọi thứ bình thường" trong khi
 * chưa đo được gì là kiểu nói dối tệ nhất của một hệ thống giám sát.
 */
export interface EpicMetricsInput {
  readonly epicKey: string;
  readonly lastJobFailed?: boolean;
  readonly missingSnapshotDays?: readonly string[];
  readonly rateLimitHits24h?: number;
  readonly driftRatio?: number;
  readonly planShiftRatio?: number;
  readonly errorSinceHours?: number | null;
  readonly unclassifiedRatio?: number;
  readonly missingEstimateRatio?: number;
  readonly missingWbsRatio?: number;
  readonly unparsedSubtaskRatio?: number;
}

export interface SystemMetricsInput {
  readonly apiP95Ms?: number;
}

export interface EvaluateArgs {
  /** Giờ địa phương hiện tại, 0–23. Nhận qua tham số, không đọc đồng hồ. */
  readonly localHour: number;
  readonly epics: readonly EpicMetricsInput[];
  readonly system?: SystemMetricsInput;
}

function alert(code: AlertCode, epicKey: string | null, value: number, threshold: number, message: string): Alert {
  return { code, level: ALERT_SPEC[code].level, epicKey, value, threshold, message };
}

/** Vượt ngưỡng dùng `>`, KHÔNG dùng `>=`: đúng giá trị biên thì chưa kêu. */
const over = (value: number | undefined, threshold: number): value is number =>
  value !== undefined && value > threshold;

export function evaluateThresholds(args: EvaluateArgs): Alert[] {
  const out: Alert[] = [];

  if (over(args.system?.apiP95Ms, THRESHOLDS.API_P95_MS)) {
    const v = args.system?.apiP95Ms ?? 0;
    out.push(
      alert('API_SLOW', null, v, THRESHOLDS.API_P95_MS,
        `API đang chậm: p95 ${Math.round(v)}ms, ngưỡng ${THRESHOLDS.API_P95_MS}ms. ` +
          'Kiểm tra tỉ lệ trúng cache biểu đồ và tải của PostgreSQL.'),
    );
  }

  for (const e of args.epics) {
    const k = e.epicKey;

    if (e.lastJobFailed === true) {
      out.push(
        alert('JOB_FAILED', k, 1, 0,
          `Job đồng bộ của Epic ${k} thất bại sau khi đã thử hết số lần. ` +
            'Xem nguyên văn lỗi ở màn hình giám sát rồi bấm Đồng bộ lại.'),
      );
    }

    // Thiếu snapshot chỉ báo động SAU mốc chốt sổ. Báo lúc 01:00 là báo trong
    // khi job đêm còn đang chạy dở.
    const missing = e.missingSnapshotDays;
    if (missing !== undefined && missing.length > 0 && args.localHour >= THRESHOLDS.SNAPSHOT_DEADLINE_HOUR) {
      out.push(
        alert('SNAPSHOT_MISSING', k, missing.length, 0,
          `Epic ${k} thiếu snapshot ${missing.length} ngày (${missing.slice(0, 5).join(', ')}). ` +
            'Job đêm nhiều khả năng đã hỏng — xem log rồi bấm Đồng bộ lại.'),
      );
    }

    if (over(e.rateLimitHits24h, THRESHOLDS.RATE_LIMIT_PER_DAY)) {
      out.push(
        alert('RATE_LIMIT_HIGH', k, e.rateLimitHits24h ?? 0, THRESHOLDS.RATE_LIMIT_PER_DAY,
          `Epic ${k} bị Jira chặn ${e.rateLimitHits24h} lần trong 24 giờ. ` +
            'Kiểm tra bộ giới hạn tốc độ có đang dùng kho Redis dùng chung không.'),
      );
    }

    if (over(e.driftRatio, THRESHOLDS.DATA_DRIFT_RATIO)) {
      out.push(
        alert('DATA_DRIFT', k, e.driftRatio ?? 0, THRESHOLDS.DATA_DRIFT_RATIO,
          `Epic ${k} lệch ${((e.driftRatio ?? 0) * 100).toFixed(2)}% so với Jira. ` +
            'Job đối soát đã tự đẩy chạy bù; theo dõi lượt sau xem còn lệch không.'),
      );
    }

    if (over(e.planShiftRatio, THRESHOLDS.PLAN_SHIFT_RATIO)) {
      out.push(
        alert('PLAN_SHIFT_HIGH', k, e.planShiftRatio ?? 0, THRESHOLDS.PLAN_SHIFT_RATIO,
          `Kế hoạch của Epic ${k} đã bị lùi ${((e.planShiftRatio ?? 0) * 100).toFixed(0)}% độ dài. ` +
            'Mở lịch sử dịch chuyển kế hoạch để xem Sub-task nào đẩy mốc đi.'),
      );
    }

    if (over(e.errorSinceHours ?? undefined, THRESHOLDS.EPIC_ERROR_HOURS)) {
      out.push(
        alert('EPIC_STUCK_ERROR', k, e.errorSinceHours ?? 0, THRESHOLDS.EPIC_ERROR_HOURS,
          `Epic ${k} đã ở trạng thái lỗi ${Math.round(e.errorSinceHours ?? 0)} giờ. ` +
            'Xem lastError ở màn hình giám sát; nhiều khả năng token Jira hết hạn.'),
      );
    }

    if (over(e.unclassifiedRatio, THRESHOLDS.UNCLASSIFIED_RATIO)) {
      out.push(
        alert('DIRTY_PHASE_DATA', k, e.unclassifiedRatio ?? 0, THRESHOLDS.UNCLASSIFIED_RATIO,
          `${((e.unclassifiedRatio ?? 0) * 100).toFixed(0)}% Task của Epic ${k} chưa phân loại được Phase. ` +
            'Mở màn hình Cấu hình Phase, xem khu "Chưa nhận diện được" rồi thêm luật khớp.'),
      );
    }

    if (over(e.missingEstimateRatio, THRESHOLDS.MISSING_ESTIMATE_RATIO)) {
      out.push(
        alert('MISSING_ESTIMATE', k, e.missingEstimateRatio ?? 0, THRESHOLDS.MISSING_ESTIMATE_RATIO,
          `${((e.missingEstimateRatio ?? 0) * 100).toFixed(0)}% Sub-task của Epic ${k} chưa có ước lượng. ` +
            'Khối lượng trên biểu đồ đang thấp hơn thực tế; nhờ đội điền trên Jira.'),
      );
    }

    if (over(e.missingWbsRatio, THRESHOLDS.MISSING_WBS_RATIO)) {
      out.push(
        alert('MISSING_WBS_DATE', k, e.missingWbsRatio ?? 0, THRESHOLDS.MISSING_WBS_RATIO,
          `${((e.missingWbsRatio ?? 0) * 100).toFixed(0)}% Sub-task của Epic ${k} thiếu ngày kế hoạch. ` +
            'Không so được sớm/trễ cho phần đó; xem danh sách ở màn hình Epic.'),
      );
    }

    if (over(e.unparsedSubtaskRatio, THRESHOLDS.UNPARSED_SUBTASK_RATIO)) {
      out.push(
        alert('UNPARSED_SUBTASK', k, e.unparsedSubtaskRatio ?? 0, THRESHOLDS.UNPARSED_SUBTASK_RATIO,
          `${((e.unparsedSubtaskRatio ?? 0) * 100).toFixed(0)}% Sub-task của Epic ${k} đặt tên sai định dạng ` +
            'nên không lên được bảng Signboard (vẫn được tính vào Burndown). ' +
            'Xem khu "Chưa lên được bảng" để biết sửa cái nào.'),
      );
    }
  }

  return out;
}
