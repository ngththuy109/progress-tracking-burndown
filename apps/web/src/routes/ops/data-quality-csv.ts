import type { DataQualityIssue, DqProblem } from '@app/shared';

/**
 * Dựng file CSV báo cáo chi tiết lỗi dữ liệu — HÀM THUẦN, để test được phần
 * escape và nội dung mà không cần trình duyệt.
 *
 * File này là thứ PM gửi cho đội để sửa dữ liệu trên Jira, nên mỗi dòng phải
 * tự đứng được: ticket nào, thuộc Epic nào, lỗi gì, đã được bỏ qua chưa.
 */

/** Nhãn người đọc được của bốn loại lỗi — dùng chung cho bảng chi tiết và CSV. */
export const PROBLEM_LABEL: Record<DqProblem, string> = {
  MISSING_ESTIMATE: 'Missing estimate',
  MISSING_WBS_DATE: 'Missing planned dates',
  UNCLASSIFIED_PHASE: 'Unclassified phase',
  UNPARSED_TITLE: 'Title in wrong format',
};

/** Escape theo RFC 4180: bọc nháy kép khi có dấu phẩy/nháy/xuống dòng. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function buildDataQualityCsv(issues: readonly DataQualityIssue[]): string {
  const header = ['Epic', 'Epic name', 'Ticket', 'Summary', 'Problems', 'Marked "no fix needed"'];
  const rows = issues.map((i) => [
    i.epicKey,
    i.epicDisplayName,
    i.issueKey,
    i.summary,
    // Nối bằng "; " chứ không phải dấu phẩy để Excel không tách nhầm cột.
    i.problems.map((p) => PROBLEM_LABEL[p]).join('; '),
    i.exempt ? 'yes' : 'no',
  ]);
  const body = [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n');
  // BOM (U+FEFF) để Excel trên Windows đọc đúng UTF-8 — tiêu đề ticket có tiếng
  // Việt và tiếng Nhật, thiếu BOM là thành mojibake.
  return `\uFEFF${body}\r\n`;
}

export function csvFileName(collectedAtIso: string, epicKey: string | null): string {
  // Chỉ giữ phần ngày — tên file có dấu hai chấm sẽ bị Windows từ chối.
  const day = collectedAtIso.slice(0, 10);
  return epicKey === null ? `data-quality-${day}.csv` : `data-quality-${epicKey}-${day}.csv`;
}
