import { normalize } from './normalize.js';

/**
 * Khoá gộp HÀNG của bảng Signboard — PRD E-31.
 *
 * `Login`, `login` và `Ｌｏｇｉｎ` phải về cùng một hàng. Không gộp thì một
 * Function bị xé thành ba hàng, mỗi hàng thiếu dữ liệu, và PM nhìn bảng sẽ
 * tưởng đó là ba chức năng khác nhau.
 *
 * Cố tình gọi thẳng `normalize()` của T-07 chứ không tự chuẩn hoá lại. Khoá gộp
 * phải trùng khít cách chuẩn hoá ở mọi chỗ khác; lệch đúng một bước là hàng
 * không gộp được nữa mà không có lỗi nào báo ra.
 *
 * Vẫn tách thành hàm có tên riêng vì đây là một KHÁI NIỆM chứ không phải một
 * phép biến đổi chuỗi tuỳ tiện: khi cần đổi cách gộp hàng, đây là chỗ phải sửa,
 * và tìm được nó bằng cách tra tên.
 */
export function toFunctionKey(functionName: string): string {
  return normalize(functionName);
}
