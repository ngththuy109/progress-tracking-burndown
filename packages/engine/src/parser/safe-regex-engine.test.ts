import { describe, it, expect } from 'vitest';
import { SafeRegexRunner, REGEX_ENGINE } from './safe-regex.js';

/**
 * Lưới bảo vệ cho CONVENTIONS.md C-8.
 *
 * Việc `re2` bị lùi về `RegExp` gốc là hỏng hóc HOÀN TOÀN IM LẶNG: mọi test
 * khác vẫn xanh, mọi regex vẫn khớp đúng, chỉ có lớp chống ReDoS quan trọng
 * nhất là biến mất. Đã xảy ra một lần rồi (gọi `require` trong module ESM),
 * nên phải có test khẳng định đúng điểm đó.
 */
describe('bộ máy regex thật sự đang chạy', () => {
  it('phải là re2, không được lùi về RegExp gốc', () => {
    expect(REGEX_ENGINE).toBe('re2');
  });

  it('re2 từ chối lookahead — bằng chứng hành vi, không chỉ là cái cờ', () => {
    // `RegExp` gốc khớp được `(?=x)x`; re2 thì ném lỗi biên dịch. Nếu test này
    // đỏ nghĩa là đang chạy bằng RegExp gốc dù cờ nói ngược lại.
    const runner = new SafeRegexRunner();
    expect(runner.exec('(?=x)x', 'x')).toBeNull();
    expect(runner.getWarnings().some((w) => w.code === 'REGEX_INVALID')).toBe(true);
  });

  it('regex bom ReDoS không làm treo tiến trình', () => {
    // `(a+)+$` trên chuỗi toàn 'a' không có 'b' là ca kinh điển làm RegExp gốc
    // quay vòng theo hàm mũ. re2 trả lời tức thì.
    const runner = new SafeRegexRunner();
    const started = performance.now();
    expect(runner.exec('^(a+)+$', 'a'.repeat(40) + 'b')).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('vẫn hỗ trợ nhóm đặt tên — thứ mà compilePattern dựa vào', () => {
    const runner = new SafeRegexRunner();
    const m = runner.exec('^[\\[［](?<function>[^\\]］]+)[\\]］]_(?<task>.+?)$', '[Login_Form]_BALReview');
    expect(m?.groups?.['function']).toBe('Login_Form');
    expect(m?.groups?.['task']).toBe('BALReview');
  });
});
