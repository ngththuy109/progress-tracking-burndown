/**
 * Chuẩn hoá chuỗi trước khi so khớp — CONVENTIONS.md C-5, PRD §2.2.2.
 *
 * Áp dụng cho CẢ chuỗi nguồn LẪN từ khoá. Bỏ bước NFKC thì việc so khớp sẽ
 * TRƯỢT HÀNG LOẠT trên dữ liệu Jira tiếng Nhật thật, mà nhìn mắt thường hai
 * chuỗi trông y hệt nhau — đây là loại lỗi rất khó tìm.
 *
 *   ﾃｽﾄ (bán giác)  →  テスト (toàn giác)
 *   Ａ  (toàn giác) →  A     (bán giác)
 *   １  (toàn giác) →  1
 */
export function normalize(s: string): string {
  return s
    .normalize('NFKC') // 1. gộp toàn giác/bán giác
    .toLowerCase() // 2. bỏ phân biệt hoa/thường
    .replace(/\s+/g, ' ') // 3. gộp khoảng trắng liên tiếp
    .trim(); // 4. cắt hai đầu
}

/**
 * Chuẩn hoá NHƯNG GIỮ NGUYÊN hoa/thường.
 *
 * Dùng khi cần so khớp không phân biệt hoa thường nhưng vẫn phải trả về chuỗi
 * gốc để hiển thị — ví dụ `functionName` trên Signboard giữ dạng `Login` chứ
 * không thành `login`.
 */
export function normalizePreservingCase(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim();
}
