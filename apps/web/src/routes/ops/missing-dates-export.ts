import type { MissingDateRow } from '@app/shared';

/**
 * Sinh câu JQL và file CSV từ danh sách Sub-task thiếu ngày kế hoạch.
 *
 * Tách khỏi React theo đúng lối của `resync-modes.ts`: đây là phần chuỗi dễ sai
 * nhất (escape CSV, cú pháp JQL) và cũng là phần kiểm được mà không cần trình
 * duyệt.
 */

/**
 * Tên HIỂN THỊ của hai field ngày kế hoạch trên Jira — PRD §2.8.
 *
 * JQL dùng TÊN field trong nháy kép, KHÔNG dùng mã `cf[10100]`: mã custom field
 * khác nhau ở mỗi Jira và chỉ worker biết (config/jira-fields.yaml), còn tên
 * `wbs_start_date`/`wbs_end_date` là quy ước PRD đặt ra và mọi tài liệu của
 * sản phẩm đều gọi bằng tên này.
 */
export const WBS_START_FIELD = 'wbs_start_date';
export const WBS_END_FIELD = 'wbs_end_date';

/**
 * Câu JQL lấy đúng những Sub-task đang thiếu ngày kế hoạch. `null` = không có
 * gì để lọc.
 *
 * Vì sao neo theo DANH SÁCH KEY thay vì viết bộ lọc theo Epic: từ trình duyệt
 * không dựng lại được cây Epic → Task → Sub-task bằng một mệnh đề JQL chạy đúng
 * trên mọi bản Jira (`parentEpic` nơi có nơi không), còn danh sách key là thứ
 * panel này ĐÃ có và chính xác tuyệt đối.
 *
 * Mệnh đề `IS EMPTY` vẫn được giữ lại để câu lọc "sống": ticket vừa được điền
 * ngày trên Jira sẽ tự rớt khỏi kết quả khi chạy lại bộ lọc, không cần quay về
 * app lấy câu JQL mới.
 */
export function buildMissingDatesJql(rows: readonly MissingDateRow[]): string | null {
  if (rows.length === 0) return null;
  const keys = rows.map((r) => r.issueKey).join(', ');
  return (
    `issuekey IN (${keys}) ` +
    `AND ("${WBS_START_FIELD}" IS EMPTY OR "${WBS_END_FIELD}" IS EMPTY) ` +
    'ORDER BY key ASC'
  );
}

/** Cột của file CSV — tên cột theo snake_case cho dễ đọc bằng mọi công cụ. */
const CSV_HEADER = ['issue_key', 'summary', 'parent_key', 'missing_start_date', 'missing_end_date'];

/**
 * Escape một ô CSV theo RFC 4180: chỉ bọc nháy kép khi bắt buộc, và nháy kép
 * trong nội dung thì nhân đôi. Summary là văn bản tự do từ Jira — dấu phẩy,
 * nháy kép hay xuống dòng đều đã từng xuất hiện thật.
 */
export function csvCell(raw: string): string {
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

/**
 * Nội dung file CSV, MỞ ĐẦU BẰNG BOM UTF-8.
 *
 * Không có BOM thì Excel (công cụ mà PM sẽ mở file này) đoán sai bảng mã và vỡ
 * toàn bộ ký tự ngoài ASCII — summary ở đây có cả tiếng Việt lẫn tiếng Nhật
 * (ví dụ thật: `[PAY][A][Design][決済履歴]_Create`).
 */
export function buildMissingDatesCsv(rows: readonly MissingDateRow[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.issueKey),
        csvCell(r.summary),
        csvCell(r.parentKey ?? ''),
        r.missingStart ? 'yes' : 'no',
        r.missingEnd ? 'yes' : 'no',
      ].join(','),
    );
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function missingDatesCsvFilename(epicKey: string): string {
  return `missing-dates-${epicKey}.csv`;
}
