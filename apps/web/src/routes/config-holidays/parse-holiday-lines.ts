import { DATE_ONLY_PATTERN } from '@app/shared';

/**
 * Đọc danh sách ngày nghỉ PM dán vào — T-36, HÀM THUẦN để test thẳng.
 *
 * Mỗi dòng: `YYYY-MM-DD` hoặc `YYYY-MM-DD, tên ngày lễ`. Chấp nhận phân cách
 * bằng phẩy, chấm phẩy hoặc tab vì dữ liệu thường dán từ Excel. Dòng trống bỏ
 * qua. Dòng sai KHÔNG chặn dòng đúng — trả cả hai danh sách để màn hình xem
 * trước hiện đủ: dòng nào vào được, dòng nào cần sửa.
 */

export interface ParsedHoliday {
  readonly date: string;
  readonly label: string | null;
}

export interface ParseLineError {
  /** Số dòng NGƯỜI DÙNG nhìn thấy, đếm từ 1 và tính cả dòng trống. */
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

export interface ParseResult {
  readonly holidays: readonly ParsedHoliday[];
  readonly errors: readonly ParseLineError[];
}

/** `2026-02-30` khớp regex nhưng không tồn tại — phải kiểm bằng lịch thật. */
function isRealDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function parseHolidayLines(raw: string): ParseResult {
  const holidays: ParsedHoliday[] = [];
  const errors: ParseLineError[] = [];

  raw.split('\n').forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line === '') return;

    const [datePart = '', ...rest] = line.split(/[,;\t]/);
    const date = datePart.trim();
    const label = rest.join(',').trim();

    if (!DATE_ONLY_PATTERN.test(date)) {
      errors.push({
        line: i + 1,
        text: line,
        reason: 'The line must start with a date like 2026-02-17.',
      });
      return;
    }
    if (!isRealDate(date)) {
      errors.push({ line: i + 1, text: line, reason: `"${date}" is not a real calendar date.` });
      return;
    }

    holidays.push({ date, label: label === '' ? null : label });
  });

  return { holidays, errors };
}
