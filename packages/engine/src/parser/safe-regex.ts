/**
 * Chạy regex do NGƯỜI DÙNG NHẬP một cách an toàn — CONVENTIONS.md C-8, PRD E-20.
 *
 * PM tự nhập mẫu tiêu đề và regex, nên coi đây là dữ liệu KHÔNG ĐÁNG TIN. Một
 * regex như `(a+)+$` có thể làm treo cả job đêm, khiến toàn bộ Epic không có
 * snapshot.
 *
 * Ba lớp bảo vệ:
 *   1. Giới hạn độ dài 200 ký tự
 *   2. Chạy bằng `re2` (bộ máy RE2 của Google, nạp qua WebAssembly — xem
 *      `loadRe2`) — thuật toán tuyến tính, KHÔNG backtracking nên về bản chất
 *      không thể ReDoS. Bản WASM KHÔNG cần biên dịch native nên `pnpm install`
 *      chạy được offline trên mọi máy, không cần toolchain C++.
 *   3. Đồng hồ tường 100ms cho mỗi chuỗi, phòng khi re2 không dùng được
 *
 * Quá thời gian → coi như KHÔNG KHỚP, ghi cảnh báo `REGEX_TIMEOUT`, **không làm
 * sập job**. Một luật timeout quá 5 lần thì tự vô hiệu hoá.
 */

import { createRequire } from 'node:module';

export const MAX_REGEX_LENGTH = 200;
export const REGEX_TIMEOUT_MS = 100;
export const MAX_TIMEOUTS_BEFORE_DISABLE = 5;

export interface RegexWarning {
  readonly code: 'REGEX_TIMEOUT' | 'REGEX_INVALID' | 'REGEX_TOO_LONG' | 'REGEX_DISABLED';
  readonly pattern: string;
  readonly message: string;
}

/**
 * Bộ chạy regex an toàn, có nhớ số lần timeout của từng mẫu.
 *
 * Tạo MỘT thể hiện cho mỗi lần đồng bộ để bộ đếm timeout có ý nghĩa — tạo mới
 * cho từng chuỗi thì không bao giờ đạt ngưỡng tự vô hiệu hoá.
 */
export class SafeRegexRunner {
  private compiled = new Map<string, RegExp | null>();
  private timeouts = new Map<string, number>();
  private readonly warnings: RegexWarning[] = [];

  constructor(
    /** Tách ra để test kiểm chứng được nhánh timeout mà không phải chờ thật. */
    private readonly now: () => number = () => performance.now(),
    private readonly regexFactory: (src: string, flags: string) => RegExp = defaultRegexFactory,
  ) {}

  getWarnings(): readonly RegexWarning[] {
    return this.warnings;
  }

  /** Chạy `pattern` trên `input`. Trả `null` khi không khớp hoặc mẫu không dùng được. */
  exec(pattern: string, input: string): RegExpExecArray | null {
    if ((this.timeouts.get(pattern) ?? 0) >= MAX_TIMEOUTS_BEFORE_DISABLE) {
      return null; // đã tự vô hiệu hoá, không thử nữa
    }

    const re = this.compile(pattern);
    if (!re) return null;

    const start = this.now();
    let result: RegExpExecArray | null;
    try {
      re.lastIndex = 0;
      result = re.exec(input);
    } catch {
      this.warn('REGEX_INVALID', pattern, 'Lỗi khi chạy regex.');
      return null;
    }

    if (this.now() - start > REGEX_TIMEOUT_MS) {
      const n = (this.timeouts.get(pattern) ?? 0) + 1;
      this.timeouts.set(pattern, n);
      this.warn(
        'REGEX_TIMEOUT',
        pattern,
        `Regex chạy quá ${REGEX_TIMEOUT_MS}ms (lần ${n}). Coi như không khớp.`,
      );
      if (n >= MAX_TIMEOUTS_BEFORE_DISABLE) {
        this.warn('REGEX_DISABLED', pattern, `Đã timeout ${n} lần, tự vô hiệu hoá luật này.`);
      }
      return null;
    }

    return result;
  }

  private compile(pattern: string): RegExp | null {
    if (this.compiled.has(pattern)) return this.compiled.get(pattern)!;

    if (pattern.length > MAX_REGEX_LENGTH) {
      this.warn(
        'REGEX_TOO_LONG',
        pattern,
        `Regex dài ${pattern.length} ký tự, tối đa ${MAX_REGEX_LENGTH}.`,
      );
      this.compiled.set(pattern, null);
      return null;
    }

    try {
      const re = this.regexFactory(pattern, 'u');
      this.compiled.set(pattern, re);
      return re;
    } catch (err) {
      this.warn(
        'REGEX_INVALID',
        pattern,
        `Regex không biên dịch được: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.compiled.set(pattern, null);
      return null;
    }
  }

  private warn(code: RegexWarning['code'], pattern: string, message: string): void {
    this.warnings.push({ code, pattern, message });
  }
}

/**
 * Nạp `re2` MỘT LẦN lúc nạp module.
 *
 * Dùng `re2-wasm` — bản RE2 của Google biên dịch sang WebAssembly. Khác với gói
 * `re2` native, nó KHÔNG cần biên dịch addon C++ lúc `pnpm install` (không cần
 * node-gyp/MSVC) và KHÔNG tải binary từ mạng — file `.wasm` nằm sẵn trong gói.
 * Nhờ vậy máy chặn mạng / thiếu toolchain (Windows) vẫn cài và chạy được, không
 * còn cảnh `pnpm install` chết ở bước build re2 rồi phải bỏ qua script.
 *
 * Vẫn phải dùng `createRequire` chứ không gọi thẳng `require`: package này là ESM
 * (`"type": "module"`), ở đó `require` KHÔNG TỒN TẠI. Gọi thẳng sẽ ném
 * ReferenceError, rơi vào `catch`, và im lặng lùi về `RegExp` gốc — nghĩa là
 * `re2` không bao giờ chạy dù đã cài. Đúng lỗi này từng xảy ra.
 *
 * Cũng không dùng được `await import('re2-wasm')`: `exec()` là hàm ĐỒNG BỘ, mà
 * `re2-wasm` cũng khởi tạo WASM ĐỒNG BỘ ngay lúc `require` nên hợp nhau.
 */
function loadRe2(): (new (s: string, f?: string) => RegExp) | null {
  try {
    const req = createRequire(import.meta.url);
    const mod = req('re2-wasm') as { RE2: new (s: string, f?: string) => RegExp };
    return mod.RE2;
  } catch {
    return null;
  }
}

const RE2 = loadRe2();

/**
 * Đang chạy bằng `re2` hay `RegExp` gốc? Có test khẳng định giá trị này là `re2`.
 *
 * Phơi ra vì rơi về `native` là HỎNG HÓC IM LẶNG: mọi test vẫn xanh, mọi regex
 * vẫn khớp đúng, chỉ có lớp chống ReDoS quan trọng nhất là biến mất. Đồng hồ
 * 100ms bên dưới KHÔNG thay thế được — nó chỉ đo SAU KHI `exec()` trả về, không
 * cắt ngang được một regex đang quay vòng.
 */
export const REGEX_ENGINE: 're2' | 'native' = RE2 === null ? 'native' : 're2';

/**
 * `re2` chạy tuyến tính, không backtracking nên về bản chất không thể ReDoS.
 *
 * Đổi lại, nó KHÔNG hỗ trợ lookahead/lookbehind. Regex có `(?=...)` sẽ ném lỗi
 * biên dịch và bị bắt ở `compile()` — đó là hành vi mong muốn, T-06 đã chặn từ
 * lúc lưu cấu hình.
 *
 * `re2-wasm` CHỈ chạy ở chế độ unicode nên BẮT BUỘC có cờ `u` (thiếu là ném lỗi).
 * `compile()` luôn truyền `'u'`; ở đây thêm một lớp bảo hiểm phòng khi có nơi gọi
 * factory với cờ khác.
 */
function defaultRegexFactory(src: string, flags: string): RegExp {
  if (RE2 === null) return new RegExp(src, flags);
  return new RE2(src, flags.includes('u') ? flags : flags + 'u');
}
