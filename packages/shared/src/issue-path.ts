/**
 * Chuẩn hoá đường dẫn lỗi của zod về ĐÚNG quy ước neo lỗi của màn hình cấu hình:
 * `phaseDefinitions[2].phaseCode`, `matchRules[0].keyword`, hay trần trụi
 * `phaseDefinitions`.
 *
 * Vì sao để ở `shared`: HAI nơi phải cho ra cùng một dạng đường dẫn, lệch nhau là
 * lỗi neo hỏng ngay:
 *   - Route kiểm thân yêu cầu (bọc trong `payload` khi Lưu, `draft` khi Xem thử).
 *   - Frontend kiểm cấu hình NGAY TẠI CLIENT trước khi gửi (kiểm thẳng payload,
 *     không có khoá bọc).
 *
 * Zod trả về mảng khoá kiểu `['payload','phaseDefinitions',2,'phaseCode']`. Nếu
 * chỉ `join('.')` sẽ ra `payload.phaseDefinitions.2.phaseCode` — KHÔNG khớp dạng
 * `field[index].subfield` mà cả `field-errors.ts` (T-21) lẫn `validateConfigPayload`
 * (engine) cùng dùng, nên lỗi vừa không neo được vào dòng, vừa không rơi vào nhóm
 * "không neo được" và biến mất khỏi màn hình.
 *
 *   - Bỏ khoá bọc ngoài `payload`/`draft` nếu có (client kiểm thẳng payload thì
 *     không có khoá này — điều kiện không khớp nên bỏ qua vô hại).
 *   - Chỉ số mảng viết dạng `[n]` để khớp `atRow()`.
 */
export function fieldPath(path: ReadonlyArray<PropertyKey>): string {
  const parts = path[0] === 'payload' || path[0] === 'draft' ? path.slice(1) : path.slice();
  let out = '';
  for (const seg of parts) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}
