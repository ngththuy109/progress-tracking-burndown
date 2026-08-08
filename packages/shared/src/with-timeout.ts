/**
 * Chạy một tác vụ bất đồng bộ kèm HẠN CHÓT — quá hạn thì ném lỗi rõ ràng thay vì
 * treo vô hạn.
 *
 * Vì sao cần: một phụ thuộc "treo" — ví dụ Redis accept TCP nhưng không trả lời
 * lệnh nào — khiến `await` nằm chờ MÃI MÃI: không resolve, cũng không reject. Lúc
 * khởi động, điều này để tiến trình ở trạng thái "SỐNG MÀ KHÔNG LẮNG NGHE": trình
 * giám sát thấy PID còn sống nên không dựng lại, còn người dùng chỉ thấy 500 rỗng
 * mà không rõ nguyên nhân. Bọc hạn chót biến "treo im lặng" thành một lỗi thật để
 * nơi gọi THOÁT HẲN và được khởi động lại.
 */

export class TimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly ms: number,
  ) {
    super(`${label}: quá ${ms}ms không phản hồi`);
    this.name = 'TimeoutError';
  }
}

/**
 * Trả về promise settle theo cái nào tới trước: `task` xong, hay hết `ms`.
 *
 * - `task` resolve/reject trước hạn → truyền NGUYÊN kết quả/lỗi thật ra ngoài.
 * - Hết hạn trước → ném `TimeoutError` kèm `label` để chẩn đoán đúng chỗ treo.
 *
 * Timer KHÔNG `unref()`: mục đích của nó là được PHÉP giữ event loop tới lúc bắn,
 * nếu không một task treo mà không còn handle nào khác sẽ để tiến trình thoát êm
 * (code 0) thay vì lỗi. Khi `task` settle, `finally` xoá timer nên không rò.
 */
export function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([task, deadline]).finally(() => clearTimeout(timer));
}
