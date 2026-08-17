import type { OpsMetric } from '@app/shared';

/**
 * Epic này có dữ liệu Jira cần sửa hay không — HÀM THUẦN, để kiểm được luật mà
 * không cần dựng màn hình.
 *
 * Màn hình Epics chỉ chỉ đường sang khu Data quality khi THẬT SỰ có việc phải
 * làm. Một dòng hướng dẫn hiện thường trực trên mọi Epic sạch là tiếng ồn, và
 * tiếng ồn lặp lại làm người ta bỏ qua luôn cả lần cảnh báo thật.
 *
 * Nguồn số liệu là bộ số đo theo Epic của `GET /api/ops/health` — CÙNG nguồn mà
 * khu Data quality hiển thị, nên bấm sang là thấy đúng thứ vừa được cảnh báo.
 * Số đo đó đã trừ ticket được đánh dấu "không cần sửa": đã tắt cảnh báo ở màn
 * Monitoring rồi thì màn Epics không được dựng nó dậy.
 */

export interface EpicDataProblemsInput {
  /** Số đo Data quality của riêng Epic này. `undefined` = chưa đọc được. */
  readonly metrics?: readonly OpsMetric[] | undefined;
  /** Số Sub-task có mốc kế hoạch rơi vào ngày nghỉ (T-37). */
  readonly planConflictCount: number;
}

/** Giá trị kèm đơn vị, đọc xuôi: `12%`, `3 ngày`. */
function formatValue(metric: OpsMetric): string {
  return metric.unit === '%' ? `${metric.value}%` : `${metric.value} ${metric.unit}`;
}

/**
 * Danh sách lý do "Epic này cần sửa dữ liệu". Rỗng = sạch, và khi đó màn hình
 * KHÔNG hiện gì cả.
 *
 * Chỉ tính số đo có giá trị DƯƠNG. `null` nghĩa là chưa đo được (Epic chưa có
 * Sub-task nào) — chưa đo được thì không phải là lỗi dữ liệu, không được biến
 * thành cảnh báo.
 */
export function epicDataProblems(input: EpicDataProblemsInput): readonly string[] {
  const reasons = (input.metrics ?? [])
    .filter((m) => m.value !== null && m.value > 0)
    .map((m) => `${m.label}: ${formatValue(m)}`);

  if (input.planConflictCount > 0) {
    reasons.push(
      `${input.planConflictCount} planned start/end date${input.planConflictCount === 1 ? '' : 's'} on a day off`,
    );
  }

  return reasons;
}

/** Chữ trong tooltip: nói RÕ sai cái gì, rồi mới bảo đi đâu (C-9). */
export function dataProblemsTitle(reasons: readonly string[]): string {
  return `${reasons.join(' · ')}. Open Monitoring → Data quality to see the tickets and fix them in Jira.`;
}
